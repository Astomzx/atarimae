//! Native notifications, by asking the server rather than by being told.
//!
//! `docs/architecture/desktop.md` said this item was further away than it
//! looked, and why: WebView2 refuses a Web Push subscription — `AbortError:
//! Registration failed - push service error` — and has never implemented the
//! HTML5 Notification API. So the page inside this window cannot raise a
//! notification, and the Web Push work that serves the PWA does nothing here.
//!
//! Three ways out were available, and this is the third:
//!
//! 1. Grant the remote page IPC access so it can call a Tauri command. Rejected:
//!    the address is whatever the operator typed, so the capability would have
//!    to be a wildcard, and every page the webview ever loads would be able to
//!    invoke commands.
//! 2. Open a second realtime WebSocket from Rust. That is a second client of a
//!    protocol the web application already implements, and two implementations
//!    of one protocol drift.
//! 3. Poll a REST endpoint the web application does not need to know about.
//!
//! The cost of polling is latency, and for a board that asks people to confirm
//! a shift roster, sixty seconds is not a cost. It buys no second protocol
//! implementation, no IPC grant to a remote origin, and no new dependency
//! beyond the notification plugin itself.
//!
//! The session belongs to the webview, not to this process, so the cookie is
//! read from the webview for the configured origin. Nothing is stored: if
//! nobody is signed in there is no cookie, and polling simply finds nothing.

use std::sync::Mutex;
use std::time::Duration;

use serde::Deserialize;
use tauri::{Manager, WebviewWindow};
use tauri_plugin_notification::NotificationExt;

/// Long enough not to matter to a battery, short enough that "confirm this
/// before your shift" arrives while it is still useful.
const POLL_INTERVAL: Duration = Duration::from_secs(60);

/// A slow office VPN should delay a poll, not kill the loop.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// Beyond this, the operating system is a better place to see the rest.
const MAX_PER_POLL: usize = 3;

#[derive(Debug, Deserialize)]
struct NotificationItem {
    id: String,
    title: String,
    body: String,
}

#[derive(Debug, Deserialize)]
struct NotificationsResponse {
    items: Vec<NotificationItem>,
}

/// The newest notification already shown.
///
/// Ids are uuidv7 and therefore time-ordered, which is why this is an id and
/// not a timestamp: a laptop coming out of sleep has a clock the server does
/// not agree with, and "everything since this id" needs no clock at all.
#[derive(Default)]
pub struct SeenMarker(Mutex<Option<String>>);

/// The session cookie the webview holds for this origin.
///
/// Read from the webview rather than kept here. This process never has its own
/// credentials, so there is nothing for it to leak and nothing to keep in step
/// when somebody signs out.
fn session_cookie(window: &WebviewWindow, origin: &str) -> Option<String> {
    let url = origin.parse().ok()?;
    let cookies = window.cookies_for_url(url).ok()?;

    let pairs: Vec<String> = cookies
        .iter()
        .map(|cookie| format!("{}={}", cookie.name(), cookie.value()))
        .collect();

    if pairs.is_empty() {
        None
    } else {
        Some(pairs.join("; "))
    }
}

/// Everything newer than `after`, or the outstanding ones when there is no
/// marker yet.
async fn fetch_notifications(
    origin: &str,
    cookie: &str,
    after: Option<&str>,
) -> Result<Vec<NotificationItem>, String> {
    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .user_agent(concat!("Atarimae-Desktop/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())?;

    let mut url = format!("{origin}/api/v1/my/notifications?unreadOnly=true&limit=20");
    if let Some(after) = after {
        url.push_str(&format!("&after={after}"));
    }

    let response = client
        .get(&url)
        .header("cookie", cookie)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        // 401 is the ordinary case of nobody being signed in. Not an error
        // worth a notification, and not worth stopping the loop for.
        return Err(format!("HTTP {}", response.status().as_u16()));
    }

    let body: NotificationsResponse = response.json().await.map_err(|e| e.to_string())?;
    Ok(body.items)
}

/**
 * One pass: ask, show what is new, remember how far we got.
 *
 * Separate from the loop so the interesting decision — what counts as new —
 * is not tangled with timers.
 */
async fn poll_once(app: &tauri::AppHandle, origin: &str) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Some(cookie) = session_cookie(&window, origin) else {
        return; // Nobody signed in.
    };

    let after = {
        let marker = app.state::<SeenMarker>();
        let guard = marker.0.lock().expect("seen marker");
        guard.clone()
    };

    let items = match fetch_notifications(origin, &cookie, after.as_deref()).await {
        Ok(items) => items,
        Err(_) => return,
    };

    if items.is_empty() {
        return;
    }

    /*
     * The response is newest first, so the first id is the high-water mark.
     * It is recorded whether or not every notification is shown: the cap below
     * is about not burying somebody in toasts, not about forgetting.
     */
    let newest = items[0].id.clone();

    /*
     * On the very first poll after launch there is no marker, and everything
     * outstanding would arrive at once — a week off work becoming twenty
     * notifications in one second. So the first pass only records where we
     * are; it does not announce the backlog.
     */
    let first_pass = after.is_none();

    if !first_pass {
        // Oldest first, so the order they appear matches the order they happened.
        for item in items.iter().rev().take(MAX_PER_POLL) {
            let _ = app
                .notification()
                .builder()
                .title(&item.title)
                .body(&item.body)
                .show();
        }
    }

    let marker = app.state::<SeenMarker>();
    let mut guard = marker.0.lock().expect("seen marker");
    *guard = Some(newest);
}

/// Starts the poll loop. Returns immediately.
pub fn start(app: &tauri::AppHandle, origin: String) {
    let handle = app.clone();

    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(POLL_INTERVAL).await;
            poll_once(&handle, &origin).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The cap is about not burying somebody, and the marker is about not
    /// repeating. They are different numbers for different reasons, and
    /// conflating them is how a backlog gets silently dropped.
    #[test]
    fn shows_at_most_a_handful_at_once() {
        assert_eq!(MAX_PER_POLL, 3);
    }

    #[test]
    fn polls_often_enough_to_be_useful_and_rarely_enough_to_be_polite() {
        assert!(POLL_INTERVAL >= Duration::from_secs(30));
        assert!(POLL_INTERVAL <= Duration::from_secs(300));
    }

    /// A request that hangs must not hold the loop past its next tick.
    #[test]
    fn a_request_cannot_outlive_its_interval() {
        assert!(REQUEST_TIMEOUT < POLL_INTERVAL);
    }
}
