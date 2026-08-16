# The desktop client

A window pointed at your own server. That is the whole shape of it.

## What it adds, and what it deliberately does not

The web application is already installable as a PWA. So the desktop client has
to justify itself, and it justifies itself with very little: a taskbar entry, a
window that is not a browser tab, and an address that is remembered.

Everything after connecting is the same web application the server serves — the
same one a browser gets. There is no second interface to keep in step, and no
feature that exists only on Windows. That is the same rule as phone-versus-PC,
applied one layer out.

## The address cannot be hard-coded

This is what self-hosting forces, and it shapes the whole client. There is no
`atarimae.com` to default to, because every organisation runs its own server.
So the first screen asks where that is, and it is the only screen this shell
owns.

Three things happen to what somebody types:

1. **A bare host gets `https://`.** Not `http` — sign-in does not work without
   TLS anyway, because session cookies are `Secure` in production.
2. **Only the origin is kept.** People paste
   `https://atarimae.example.co.jp/my/announcements` out of an address bar, and
   they mean the server.
3. **Credentials in the address are refused**, as they are for webhooks.

## It refuses an address that does not answer

Before storing anything, Rust fetches `/api/v1/health` and requires a JSON body
with `status: "ok"`.

The alternative — save whatever was typed and navigate — produces a blank
window and no explanation, which is the exact silent failure this product
exists to argue against. A typo should say it is a typo, and a correct address
for somebody else's website should say that too: plenty of servers answer 200,
so the check is for _this_ application, not for a live socket.

The request is made from Rust rather than from the connect page. From the page
it would be a cross-origin call to somebody's server, which their CORS
configuration would rightly refuse — and a refusal is indistinguishable from
the server being down.

## One copy, and a window that can be put away

Three behaviours that only make sense together, which is why they arrived
together.

**A second launch focuses the first.** Two windows onto the same server is not
a harmless duplicate: both hold a realtime socket, both mark things read, and
the second one to notice a change shows a count the first one has already
cleared. Somebody who clicks the taskbar icon twice wants the application, not
a second opinion about their unread count. The single-instance plugin is
registered before anything else in the builder, because the decision has to be
made before a window exists.

**Closing hides.** A board is something people leave open all day and shut when
the screen is in the way. Quitting on that means the realtime socket is gone
until somebody thinks to start the application again — which they only do after
already missing something.

**So there is a tray icon**, and it is what makes the previous paragraph
defensible rather than sinister. Hiding on close without one is an application
that has apparently vanished and is still running. The icon says it is there,
the left button brings it back, and the right button has 開く and 終了.

終了 is now the only way out, so the two are deliberately coupled: if the tray
cannot be built, `setup` fails and the application does not start. An
unquittable window is a worse outcome than a window that never opened, and this
makes that state unreachable rather than unlikely.

**Windows 起動時に開く** is the third entry, and it is off until somebody ticks
it. Installing this application does not add it to startup — an application
that puts itself there uninvited is one people uninstall. The tick is read from
the registry when the menu is built and set from the registry again after a
toggle, never from what was clicked: the entry lives somewhere a cleanup tool or
a group policy can remove it, and a tick claiming a setting the system does not
have is worse than no tick.

## Where things live

```
apps/desktop/
  ui/index.html          the connect screen — one form, no build step
  scripts/make-icons.mjs generates PNG and ICO from the same mark as the web app
  src-tauri/             the Rust shell
```

The connect screen is a single static file with inline CSS and about twenty
lines of script. It has no framework and no bundler because it is one form, and
because it has to render before anything at all is known about the server.

**The icons are generated, not drawn twice.** Tauri wants PNG and ICO; the web
app has an SVG. Rather than add an image library, `make-icons.mjs` draws the
rounded square and the check with arithmetic and encodes them with the zlib
that ships with Node — including the ICO, which has allowed embedded PNGs since
Vista. One definition of the mark, regenerated with `pnpm desktop:icons`.

## It is not in the pnpm workspace

`apps/desktop` has no `package.json`, so `pnpm -r build` never reaches it and
`pnpm check` stays a Node-only gate that runs in seconds. Compiling a webview
shell into the pre-commit gate would make every commit wait on Rust.

The commands are on the root package instead:

| Command              | What                                                   |
| -------------------- | ------------------------------------------------------ |
| `pnpm desktop:dev`   | Run it against a dev server                            |
| `pnpm desktop:build` | Build the binary and the NSIS installer                |
| `pnpm desktop:test`  | The Rust unit tests — address normalisation, tray menu |
| `pnpm desktop:icons` | Regenerate the icons from the mark                     |

## Deliberately not done

- **No auto-update.** Tauri's updater needs a signing key and somewhere to host
  a manifest, and this project has neither a release pipeline nor a domain yet.
  Until it does, an updater would be a key to lose — and a private key is the
  one thing that cannot live in the repository that would have to hold it.
- **No native notifications.** This is the item that is further away than it
  looks, and the reason is worth writing down because the obvious plan does not
  work. Wiring up the push tables M2 left unused would give the _PWA_
  notifications; it would not give this client any, because WebView2 refuses
  the push subscription outright with an `AbortError`, and has never
  implemented the HTML5 Notification API at all
  ([WebView2Feedback #308], [#5051]). The service worker registers; the
  subscription is the part that fails. So a desktop notification here cannot
  come from the page. It has to come from Rust holding its own connection and
  bridging into the webview, which is a second client of the realtime protocol
  and a second thing to keep in step with the server — the exact cost the rest
  of this document exists to avoid. It stays undone until it is worth that,
  and "the PWA gets push" will not by itself make it so.
- **No code signing.** Windows will show SmartScreen on the installer. Signing
  needs a certificate the project does not have, and saying so is better than
  pretending the warning is a Windows bug.

[webview2feedback #308]: https://github.com/MicrosoftEdge/WebView2Feedback/issues/308
[#5051]: https://github.com/MicrosoftEdge/WebView2Feedback/issues/5051

## Testing it

The Rust side has unit tests for address normalisation and for the tray menu,
which is where the decisions are. The tray test looks trivial and is not: the
menu is built from string ids and the click handler reads string ids back, so a
rename in one place leaves an entry that still receives the click, still matches
nothing, and does nothing without an error anywhere. That is this project's
least favourite failure, in fourteen lines of Rust.

What a unit test cannot reach is the window, so the window behaviour was
checked against the running binary — closing it leaves the process alive and
the window hidden rather than destroyed, and a second launch exits immediately
and makes the first one's window visible again.

**One thing is genuinely unverified.** Autostart's default was checked against
the real registry — launching the application adds nothing to
`HKCU\…\CurrentVersion\Run`, and quitting leaves nothing behind. What was not
exercised is the toggle itself: a tray menu click cannot be driven from outside
the process the way a window can be sent `WM_CLOSE`, and adding a command-line
switch to the shipped binary purely so a test could reach it would be putting
scaffolding in the product. So the registry write is the plugin's own, on the
plugin's own testing, and this document does not claim otherwise.

The webview itself is untested here on purpose: the shell loads a remote page,
and that page is the web application, which already has 151 end-to-end tests of
its own against a real browser.
