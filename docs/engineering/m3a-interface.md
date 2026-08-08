# M3a chat interface — what running it found

Same rule as [m0-regressions.md](m0-regressions.md): defects that surfaced only
when something was actually run, each naming the test that now prevents it.

The chat backend was finished and tested before any of this existed, so nothing
below is a server bug. They are all failures of the layer that turns stored data
back into something a person can read.

---

## 1. A uuid where a colleague's name belonged

The channel list shows the last message under each channel name. Mentions are
stored as `@<uuid>` — the server resolves them that way on purpose, because
display names contain spaces and matching on a name is ambiguous — and the
message view turned them back into names.

The channel list did not. A Playwright failure snapshot showed the real thing:

```
全体連絡
A区域の担当をお願いします @019fe100-ed2c-7d7f-af76-468c179fdb48
```

Nobody scanning their channels learns anything from that line. It is the
interface showing the reader its own storage format.

The preview makes it worse than the message view: the server sends the first 80
characters of the body, so a mention near the end arrives as a **fragment** that
no longer matches the id pattern at all, and rendering it as text would leave
half a uuid on screen.

**Fix**: `previewBody` resolves complete mentions against the organisation's
directory and replaces a trailing partial id with `@…`. Names come from the user
list rather than the channel's member list, so somebody who has since left the
channel is still named rather than becoming "不明なメンバー".

**Guarded by**: `apps/web/src/chat/format.test.ts` — `previewBody` renders a
full mention as a name, hides one the preview cut in half, and leaves an email
address at the end of a preview alone.

---

## 2. Signing out is a page load, and the next navigation raced it

Sign-out deliberately does `window.location.assign("/login")` rather than a
client-side navigation, so nothing of the previous user survives in memory.

A test that clicked 「ログアウト」 and immediately navigated failed with
`net::ERR_ABORTED` — the second navigation cancelled the first while it was
still in flight. It passed when the spec was run alone and failed in the full
suite, which is the shape of a race that eventually fails in CI instead.

**Fix**: the spec's `signOut` helper waits for the login form before returning,
matching the M2 spec, which had already solved this.

**Guarded by**: `e2e/tests/m3a-ui.spec.ts` — `signOut` is the only way the spec
leaves a session, and it asserts the login form is visible.

---

## Hazards this was written against

Not defects — none of these ever ran wrong — but each is a mistake the design
would otherwise permit, so each has a test rather than a comment.

- **Your own message appearing twice.** The author is a member of the channel,
  so their message arrives over the socket as well as in the response to the
  request that created it. `appendMessage` deduplicates by id and returns the
  same object when nothing changed. Tested directly, and asserted end to end:
  after sending, the sender's window contains exactly one copy.

- **Mentioning the wrong colleague.** The composer converts a picked name back
  into an id before sending. Two people with the same display name make that
  ambiguous, so `encodeMentions` refuses and reports the name instead of
  resolving to whichever was picked first — the same principle as the rest of
  the product: a command that cannot do what was meant says so.

- **A `/g` regex reused across messages.** `lastIndex` carries between calls, so
  a shared mention pattern renders every second message's mention as plain text.
  Only visible once more than one message is on screen. `parseBody` builds its
  own regex per call, and a test parses the same body three times.

- **Realtime working in production but not in development.** The API is proxied
  in development; the socket lives at `/api/v1/realtime` under the same prefix,
  but a Vite proxy does not forward the upgrade request without `ws: true`. The
  E2E suite runs through that proxy and asserts a message written in one browser
  context appears in another with no reload, so the two environments cannot
  quietly diverge.
