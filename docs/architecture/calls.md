# 通話 — calls

Voice and video calls over the network, the way LINE and WeChat do them. **Not
telephone calls.** Nothing here dials a number.

## One-to-one and group, from the same mechanism

Both, and they are not two features.

A call belongs to a **channel**, and a channel is either a one-to-one
conversation or a group. So:

| Channel kind         | What a call there is                        |
| -------------------- | ------------------------------------------- |
| `direct`             | A one-to-one call, ringing the other person |
| `public` / `private` | A group call, ringing everybody in it       |

Nothing branches on which. The 通話 button is in every conversation, joining
asks the same question in both, and the record afterwards has the same shape.

That "nothing branches" is a claim rather than an observation, so it has tests
on both sides: a one-to-one call that a third person holding the id cannot join
(404 — the conversation does not exist as far as they are concerned), and a
group call that somebody who can merely _read_ a public channel cannot join
(403 — reading a channel is not being in it).

## What Atarimae does, and what it refuses to do

Atarimae does not carry the audio and is not going to. Running an SFU is a
product of its own — bandwidth, TURN servers, codecs, an operations burden that
dwarfs everything else here — and a small office should not have to adopt this
project's opinion about any of it.

So a call has two halves:

| Belongs here                                  | Belongs to a provider |
| --------------------------------------------- | --------------------- |
| Who is being called, and being told about it  | The media             |
| When it started, and whether anybody answered |                       |
| Whether it is still going                     |                       |
| Who may join, checked on every join           |                       |
| The record afterwards                         |                       |

The provider is configured, not bundled. An office that already runs Jitsi in
its server cupboard points this at that, and its calls never leave the
building.

## Two kinds of provider

### `url` — a room template

```
https://meet.example.com/{room}
```

Atarimae generates the room name and substitutes it. Nothing is sent anywhere,
nothing can fail, and there is no credential to leak. This covers Jitsi and
most of the self-hostable services, and it is the kind the interface offers
first.

**`{room}` is required, and the server refuses a template without it.** A
template with no placeholder puts every call in the organisation into one
shared room — two unrelated conversations hearing each other, while looking
exactly like the product working.

### `http` — ask an API

For services that mint a room or a per-call token. Atarimae POSTs a templated
body to a configured URL and reads the join URL out of the answer at a dotted
path (`data.url`), because every service puts it somewhere different and
hard-coding one of them is how a "generic" provider quietly becomes a provider
for exactly one vendor.

Only `{room}` and `{secret}` are substituted, into the URL, the headers and the
body. Deliberately not a template language: anything cleverer would be an
expression evaluator reachable from stored configuration.

The API secret is **encrypted**, not hashed — it is presented to another
system, so the plaintext has to come back. Same category as the SMTP password,
same secret store. It is never returned by the API; the provider list says only
whether one is set.

## Private addresses are allowed here

`checkProviderUrl` deliberately permits `https://10.0.0.20/meet/{room}`, where
the webhook check would refuse it.

The difference is who the address belongs to. A webhook points at a third
party, so an address inside your own network is a request forger. A call
provider is the administrator's own infrastructure, and refusing it would mean
the only supported way to have calls is to route them through somebody else's
cloud — the arrangement this project exists to argue with.

What is left to lean on: administrator-only configuration, and the provider's
response is never returned to the caller, only the join URL extracted from it.

## Where the room appears

Its own window by default. Inside Atarimae if an administrator ticks
`embeddable` on a `url` provider — and the objection that used to sit here,
"embedding it would mean a vendor's SDK on every page", turned out to be an
objection to something nobody had to build.

**A frame is not an SDK.** An iframe pointed at a room URL runs no third-party
JavaScript on this origin, and a cross-origin frame cannot read the page it sits
in. `script-src 'self'` does not move to allow it. Swapping providers is still a
settings change, because there is still nothing of the vendor's in this
codebase.

What does move is narrow: `frame-src` gains exactly one origin, and
`Permissions-Policy` grants camera and microphone to that origin and never to
this one. `frame-ancestors 'none'` — the clickjacking defence around 確認 — does
not move at all, which is the whole reason this was affordable. See
`security.md`.

### Why it has to be asked for

Off by default, and detection is not on offer: **a page cannot tell whether a
cross-origin frame loaded or was refused by the provider's own
`X-Frame-Options`.** The load event fires either way and nothing inside is
readable. So "try it and fall back" does not exist, an administrator who knows
their provider has to say so, and the interface always offers 別の窓で開く
underneath the frame — because an empty rectangle is a possible outcome that
nothing can report.

The one framing failure a browser _does_ report is its own: a CSP refusal fires
`securitypolicyviolation`, and the client uses it to fall back to a link. That
matters because the policy travels with the document — a page loaded before the
setting was changed is still enforcing the old one, and the interface says so on
the form.

### `url` only, and that is the browser's rule

An `http` provider cannot be embedded and the request is refused with
`CALL_PROVIDER_NOT_EMBEDDABLE` rather than stored. The origin has to be in a
response header before the page that will hold the frame is served, and an HTTP
provider's join URL does not exist until a call asks for it. A template whose
_host_ is a placeholder (`https://{room}.example.com/`) is refused for the same
reason.

### What the client is told, and when

Two questions, deliberately separate:

| Question                      | Answered by           | Why not the other one                                                                |
| ----------------------------- | --------------------- | ------------------------------------------------------------------------------------ |
| Are calls framed here at all? | `GET /call-embedding` | A popup blocker only allows `window.open` during the gesture that asked for one      |
| May _this_ room be framed?    | `embed` on join       | The provider can change mid-call; the answer has to be about the header now in force |

`embed` is computed by comparing the call's join URL against the origin
currently in `frame-src`, not by reading the provider's flag. A call outlives the
provider it was started with, and telling the client to frame something the
browser will refuse is an empty panel with no explanation.

### The costs, stated

- **The framed room closes when you leave the conversation.** A window did not.
  Rejoining works and is one press, but this is a real difference and it is why
  embedding is opt-in rather than the default.
- The origin reaches the header when a provider is written **through the API**.
  A database changed underneath a running server — a restore — needs a restart
  before the header agrees with it.

## The room name

Generated (`atarimae-<uuid>`), never derived from the channel or anything a
caller sends. A room named after the channel is guessable, and a guessable room
is one an outsider can already be sitting in.

## A link is not a capability

The join URL is handed out by `POST /calls/:id/join` and nowhere else — not in
the call list, not in the channel list. Every join re-checks membership of the
channel the call belongs to, so somebody removed from a private channel cannot
walk back into its call with a link they still have.

This is the same rule as attachments, and for the same reason.

## One live call per channel

A unique partial index, so it holds even when two people press 通話 at the same
moment. Pressing it while a call is running **joins** that one rather than
opening a second room with half the participants in each.

Ending is the last participant leaving. That leaves one way to strand a
channel: a browser tab closing is not somebody leaving, and without a way out
the conversation would show 通話中 forever with nobody in it — and could never
start another. Two things address it:

- a 退出 button whenever you are on the call, which is the normal path
- a backstop in the worker that ends calls running longer than twelve hours.
  Far longer than any real call, so it never cuts one short.

## Being told

`call.started` goes to every member over the socket, and the interface shows it
**at the top of every screen**, not inside the chat pages. A call somebody only
discovers by opening the right conversation is not a call.

Answering actually joins, then shows the conversation. A button that says
参加する and only navigates somewhere is a button that lies.

Your own call does not ring at you.

Delivery is best-effort like every other socket event, so the channel also
carries the live call: the socket makes it immediate, it does not make it true.

## The record

Each call keeps who joined and when they left, so the history distinguishes a
call that happened from one that rang out — which is the thing anybody wants to
know afterwards. The conversation shows the last few with a duration.

Calls are **not** messages. Retrofitting a system-message concept into the chat
model would need its own rules — who can delete one, does it notify, does it
count as unread — for a line of text.

## Limits

- One provider is used, the default. Per-channel providers are not a thing
  anybody has asked for. The provider a call is held with and the origin in
  `frame-src` are chosen by the same rule, in one place, because two spellings
  of "the default one" would disagree the moment an organisation has two.
- No per-participant tokens: one room URL is issued per call and shared by
  everybody who joins. A provider that issues a token per person would need
  the provider asked once per join, which is a change to `resolveJoinUrl` and
  not to anything else.
- No ringing sound, and no missed-call notification by email or push. The
  banner is what there is.
