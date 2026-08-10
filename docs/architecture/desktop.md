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

| Command              | What                                        |
| -------------------- | ------------------------------------------- |
| `pnpm desktop:dev`   | Run it against a dev server                 |
| `pnpm desktop:build` | Build the binary and the NSIS installer     |
| `pnpm desktop:test`  | The Rust unit tests — address normalisation |
| `pnpm desktop:icons` | Regenerate the icons from the mark          |

## Deliberately not done

- **No auto-update.** Tauri's updater needs a signing key and somewhere to host
  a manifest, and this project has neither a release pipeline nor a domain yet.
  Until it does, an updater would be a key to lose.
- **No native notifications.** They would be the first genuine reason to prefer
  this over the PWA, and they need the push work M2 left unwired.
- **No tray icon, no launch at startup.** Both are easy and neither has been
  asked for.
- **No single-instance lock.** A second launch opens a second window today.
- **No code signing.** Windows will show SmartScreen on the installer. Signing
  needs a certificate the project does not have, and saying so is better than
  pretending the warning is a Windows bug.

## Testing it

The Rust side has unit tests for address normalisation, which is where the
decisions are. What the tests do not cover is the webview itself — the shell
loads a remote page, and that page is the web application, which already has
151 end-to-end tests of its own against a real browser.
