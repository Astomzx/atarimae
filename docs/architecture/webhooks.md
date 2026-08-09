# Webhooks

Telling another system that something happened here.

## Delivery is an outbox, not a request

`enqueueWebhookEvent` writes its rows **inside the transaction that performs the
change**. By the time the worker sees one, the thing it describes definitely
happened — an announcement that was published and then rolled back cannot
produce a delivery, and one that committed cannot fail to produce one.

That order also decides what failure means. Since the row describes something
real, a failure to deliver is retried, never discarded. "The announcement was
published but the dispatch system never heard" is precisely the silent failure
this product exists to argue against, and dropping a delivery would reintroduce
it at the last step.

- Exponential backoff: a minute, then two, capped at an hour.
- Ten attempts, roughly six hours, then the delivery stops being retried. An
  endpoint unreachable that long is not coming back inside the window where the
  event still means anything, and retrying forever lets one broken receiver
  fill the table.
- **One row per subscriber.** Two webhooks on the same event get two rows: a
  shared one would mean a slow endpoint delaying the other, and one permanent
  failure abandoning both.
- The payload is frozen at enqueue time. Rebuilding it at delivery would send
  the world as it is now rather than as it was — a retry an hour later would
  describe something that never happened.

## Events

| Event                       | When                                   |
| --------------------------- | -------------------------------------- |
| `announcement.published`    | An announcement reached its recipients |
| `announcement.acknowledged` | One person confirmed one announcement  |
| `user.created`              | A member account was created           |
| `user.disabled`             | A member account was disabled          |

Deliberately short. Every event is a promise to keep sending it in that shape,
and a webhook nobody uses is a compatibility constraint bought for nothing.

`announcement.acknowledged` fires only on the insert that actually recorded
something — a second tap on a slow connection must not tell a subscriber it
happened twice.

## Signing

```
X-Atarimae-Signature: t=1786190000,v1=<hex>
X-Atarimae-Event: announcement.published
X-Atarimae-Delivery: <uuid, stable across retries>
```

`v1` is HMAC-SHA256 of `<t>.<body>` under the webhook's secret.

**The timestamp is signed with the body**, and that is the whole point of
including it. An HMAC over the body alone proves who sent it and nothing about
when — anybody who captures one signed request can replay it forever. The
receiver must reject anything outside a tolerance; five minutes is the default,
and `verifySignature` in `apps/server/src/lib/webhook-signature.ts` is a working
implementation of the check, exercised by the test suite against the bytes we
actually send.

The separator is not decoration: without it, a body starting with digits could
be shifted into the timestamp and two different inputs would sign the same
string.

Several `v1=` values are allowed by the format, which is how a secret gets
rotated without downtime. This side does not do that yet; the format must not
have to change when it does.

The secret is **encrypted, not hashed**. Every other credential in this project
is hashed, so the exception needs stating: signing needs the plaintext back on
every delivery, and a hash can only be compared. That puts it in the same
category as the SMTP password, and it uses the same secret store. It is still
shown only once — the receiver keeps its own copy, and a second way to read it
would be a second way to leak it.

## Where a webhook may point

A webhook URL is input the server then fetches, on its own network, with
whatever access that network has. Unchecked it is a request forger: aim it at
`http://169.254.169.254/` and read cloud credentials, or at `localhost:5432` to
probe the database, with the delivery log for output.

`checkOutboundUrl` refuses, before anything is stored:

- any scheme but http and https
- credentials in the URL, which some clients forward as a header
- loopback, link-local (including cloud metadata), private ranges,
  carrier-grade NAT, multicast — in IPv4, in IPv6, and in the IPv4-mapped IPv6
  forms

That last one is not theoretical. `new URL()` rewrites `[::ffff:127.0.0.1]` as
`[::ffff:7f00:1]`, and the first version of this check only matched the dotted
form — the test that spells loopback six different ways is what caught it.

Redirects are not followed. A receiver that redirects has not been configured,
and following one would send the signature somewhere the administrator never
named.

**Open item — DNS rebinding.** The address check happens when the webhook is
saved; the hostname is resolved again at delivery. A name that resolves to a
public address now and a private one later is not caught. Closing it means
resolving and pinning the address at request time, through a custom agent.

## When an endpoint is gone

Twenty consecutive failures switches the webhook off. Not silently:
`disabled_at`, `consecutive_failures` and `last_error` are all on the row and
all shown in the interface, alongside a per-delivery log. "Did it arrive"
should not require shell access to answer.

Any success resets the counter, so an endpoint that is merely flaky is never
switched off — only one that is consistently gone. Re-enabling clears the
counter too, giving it a full allowance again.

## Limits

- No custom headers, and no way to add an `Authorization`. The signature is the
  authentication; a second mechanism would be a second thing to get wrong.
- No replay-from-the-interface button. Abandoned deliveries stay in the table
  and can be re-queued by hand; a button is a feature nobody has asked for yet.
- Delivery is in-process on a single instance, like notifications. The claim
  uses `SKIP LOCKED`, so scaling out needs no change here.
