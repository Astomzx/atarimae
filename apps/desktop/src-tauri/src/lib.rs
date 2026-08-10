//! The Atarimae desktop client.
//!
//! A window pointed at *your own* server. That is the whole shape of it, and
//! it is what a self-hosted product forces: there is no address to hard-code,
//! because every organisation runs its own. So the first thing this asks for
//! is where the server is, and the last thing it does is remember.
//!
//! Everything after that is the web application the server already serves —
//! the same one a browser gets, and the same one the PWA installs. This shell
//! adds a taskbar entry and a window that is not a browser tab, and
//! deliberately nothing else.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// Long enough for a slow office VPN, short enough that a wrong address does
/// not look like a hung application.
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Serialize, Deserialize, Default)]
struct StoredConfig {
    /// Origin only, no trailing slash. Absent until somebody connects once.
    server_url: Option<String>,
}

fn config_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("no config directory: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {dir:?}: {e}"))?;
    Ok(dir.join("server.json"))
}

fn read_config(app: &tauri::AppHandle) -> StoredConfig {
    // A corrupt or missing file is simply "not configured yet". There is
    // nothing here worth failing to start over — the worst case is being asked
    // for the address again.
    config_path(app)
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn write_config(app: &tauri::AppHandle, config: &StoredConfig) -> Result<(), String> {
    let path = config_path(app)?;
    let text = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| format!("could not write {path:?}: {e}"))
}

/// Normalises what somebody typed into an origin.
///
/// People type `atarimae.example.co.jp`, and they paste
/// `https://atarimae.example.co.jp/my/announcements` out of the address bar.
/// Both mean the same server.
fn normalise(input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("アドレスを入力してください。".into());
    }

    let with_scheme = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        // https, not http. Sign-in does not work without TLS anyway: session
        // cookies are Secure in production.
        format!("https://{trimmed}")
    };

    let url = url_origin(&with_scheme)?;
    Ok(url)
}

fn url_origin(input: &str) -> Result<String, String> {
    let (scheme, rest) = input
        .split_once("://")
        .ok_or_else(|| "http または https のアドレスを入力してください。".to_string())?;

    if scheme != "http" && scheme != "https" {
        return Err("http または https のアドレスを入力してください。".into());
    }

    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() {
        return Err("アドレスが正しくありません。".into());
    }
    if authority.contains('@') {
        return Err("アドレスにユーザー名やパスワードを含めることはできません。".into());
    }

    Ok(format!("{scheme}://{authority}"))
}

#[derive(Serialize)]
struct Connected {
    server_url: String,
}

/// Asks an origin whether it is an Atarimae server.
///
/// Separate from the command, and taking nothing from Tauri, so it can be
/// tested against a real socket — which is the only way to know that a wrong
/// address produces a sentence rather than a blank window.
async fn probe(origin: &str) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(PROBE_TIMEOUT)
        .user_agent(concat!("Atarimae-Desktop/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("接続を準備できませんでした: {e}"))?;

    let health = format!("{origin}/api/v1/health");
    let response = client.get(&health).send().await.map_err(|e| {
        if e.is_timeout() {
            "サーバーが応答しませんでした。アドレスとネットワークを確認してください。".to_string()
        } else if e.is_connect() {
            "サーバーに接続できませんでした。アドレスを確認してください。".to_string()
        } else {
            // The underlying message can carry the whole URL and any redirect
            // chain; only the shape of the failure is useful here.
            "サーバーに接続できませんでした。".to_string()
        }
    })?;

    if !response.status().is_success() {
        return Err(format!(
            "そのアドレスは Atarimae ではないようです（HTTP {}）。",
            response.status().as_u16()
        ));
    }

    // Something answered — but plenty of things answer 200. This has to be an
    // Atarimae server, or the window would open on somebody else's website.
    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|_| "そのアドレスは Atarimae ではないようです。".to_string())?;

    if body.get("status").and_then(|s| s.as_str()) != Some("ok") {
        return Err("そのアドレスは Atarimae ではないようです。".into());
    }

    Ok(())
}

/// Checks the address before storing it, and refuses if nothing answers.
///
/// The alternative — save whatever was typed and navigate — produces a blank
/// window and no explanation, which is exactly the kind of silent failure this
/// product exists to argue against. A typo should say it is a typo.
#[tauri::command]
async fn connect(app: tauri::AppHandle, address: String) -> Result<Connected, String> {
    let origin = normalise(&address)?;
    probe(&origin).await?;

    write_config(
        &app,
        &StoredConfig {
            server_url: Some(origin.clone()),
        },
    )?;

    if let Some(window) = app.get_webview_window("main") {
        window
            .navigate(origin.parse().map_err(|_| "アドレスが正しくありません.")?)
            .map_err(|e| format!("画面を開けませんでした: {e}"))?;
    }

    Ok(Connected { server_url: origin })
}

/// Forgets the server and returns to the connect screen.
///
/// Not a settings dialog: this client has exactly one setting, and the honest
/// way to change it is to ask again.
#[tauri::command]
async fn forget(app: tauri::AppHandle) -> Result<(), String> {
    write_config(&app, &StoredConfig::default())?;

    if let Some(window) = app.get_webview_window("main") {
        window
            .navigate("tauri://localhost".parse().map_err(|_| "bad url")?)
            .map_err(|e| format!("画面を開けませんでした: {e}"))?;
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![connect, forget])
        .setup(|app| {
            let handle = app.handle();
            let stored = read_config(handle);

            /*
             * The window is built here rather than declared in tauri.conf.json
             * because where it points is not known until the config is read.
             * A declared window would flash the connect screen on every launch
             * before being sent somewhere else.
             */
            let url = match stored.server_url.as_deref() {
                Some(server) => WebviewUrl::External(
                    server.parse().map_err(|e| format!("stored url: {e}"))?,
                ),
                None => WebviewUrl::default(),
            };

            WebviewWindowBuilder::new(app, "main", url)
                .title("Atarimae")
                .inner_size(1100.0, 780.0)
                .min_inner_size(360.0, 480.0)
                .build()?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to start Atarimae");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adds_https_when_somebody_types_a_bare_host() {
        assert_eq!(
            normalise("atarimae.example.test").unwrap(),
            "https://atarimae.example.test"
        );
    }

    /// People paste out of the address bar, and what they paste has a path on
    /// it. It still names the same server.
    #[test]
    fn keeps_only_the_origin() {
        assert_eq!(
            normalise("https://atarimae.example.test/my/announcements?x=1").unwrap(),
            "https://atarimae.example.test"
        );
    }

    #[test]
    fn keeps_a_port() {
        assert_eq!(
            normalise("http://192.168.1.10:3000/").unwrap(),
            "http://192.168.1.10:3000"
        );
    }

    #[test]
    fn trims_surrounding_space() {
        assert_eq!(
            normalise("  https://atarimae.example.test  ").unwrap(),
            "https://atarimae.example.test"
        );
    }

    #[test]
    fn refuses_a_scheme_that_is_not_http() {
        assert!(normalise("file:///etc/passwd").is_err());
        assert!(normalise("ftp://example.test").is_err());
    }

    /// Some clients forward these as an Authorization header.
    #[test]
    fn refuses_credentials_in_the_address() {
        assert!(normalise("https://user:pass@example.test").is_err());
    }

    #[test]
    fn refuses_nothing_at_all() {
        assert!(normalise("").is_err());
        assert!(normalise("   ").is_err());
        assert!(normalise("https://").is_err());
    }

    // ------------------------------------------------------------- probe --

    use std::io::{Read, Write};
    use std::net::TcpListener;

    /// A socket that answers once with whatever is handed to it.
    ///
    /// Hand-rolled rather than a test-server crate: one canned response over
    /// one connection is a dozen lines, and a dependency that exists only for
    /// tests still has to be audited and updated.
    fn serve_once(response: &'static str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();

        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut scratch = [0u8; 1024];
                let _ = stream.read(&mut scratch);
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.flush();
            }
        });

        format!("http://127.0.0.1:{port}")
    }

    fn http(body: &'static str) -> String {
        // Content-Length matters: reqwest waits for the body otherwise.
        format!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
            body.len(),
            body
        )
    }

    #[tokio::test]
    async fn accepts_a_server_that_says_it_is_healthy() {
        let body = r#"{"status":"ok","version":"0.0.0"}"#;
        let response: &'static str = Box::leak(http(body).into_boxed_str());
        let origin = serve_once(response);

        assert_eq!(probe(&origin).await, Ok(()));
    }

    /// Plenty of things answer 200. The address has to be *this* application,
    /// or the window opens on somebody else's website.
    #[tokio::test]
    async fn refuses_something_else_that_answers_200() {
        let body = r#"{"hello":"this is a different service"}"#;
        let response: &'static str = Box::leak(http(body).into_boxed_str());
        let origin = serve_once(response);

        let error = probe(&origin).await.unwrap_err();
        assert!(error.contains("Atarimae ではないようです"), "{error}");
    }

    #[tokio::test]
    async fn refuses_a_page_that_is_not_json_at_all() {
        let response = "HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: 13\r\nconnection: close\r\n\r\n<html></html>";
        let origin = serve_once(response);

        assert!(probe(&origin).await.is_err());
    }

    #[tokio::test]
    async fn reports_the_status_when_the_server_refuses() {
        let response =
            "HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n";
        let origin = serve_once(response);

        let error = probe(&origin).await.unwrap_err();
        assert!(error.contains("404"), "{error}");
    }

    /// The commonest mistake: a typo, or a server that is simply not running.
    #[tokio::test]
    async fn explains_a_refused_connection() {
        // Bound and dropped, so the port is free and nothing is listening.
        let port = TcpListener::bind("127.0.0.1:0")
            .expect("bind")
            .local_addr()
            .expect("addr")
            .port();

        let error = probe(&format!("http://127.0.0.1:{port}"))
            .await
            .unwrap_err();
        assert!(error.contains("接続できませんでした"), "{error}");
    }
}
