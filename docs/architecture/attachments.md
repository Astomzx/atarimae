# Attachments

What may be uploaded, what happens to it, and which failure each rule prevents.

Everything here applies to chat. Announcements do not carry files.

## The four rules

They are stated in the project's own notes, and each closes a specific hole.

### 1. An allow-list of extensions

`apps/server/src/lib/attachments.ts` holds the whole list: PDF, JPEG, PNG, GIF,
WebP, xlsx, docx, pptx, ZIP, CSV, plain text.

A deny-list is a promise to have thought of every dangerous extension, which
nobody has ever managed. Everything absent is refused, including whatever the
next dangerous extension turns out to be.

**SVG is deliberately absent.** It is XML, it can carry script, and a browser
runs that script when the file is served inline from your own origin. There is
no way to accept SVG and also display it safely, so it is not accepted.

### 2. The bytes decide, not the extension and not `Content-Type`

`Content-Type` is set by whoever is uploading and means nothing. Every accepted
format is verified by its signature:

| Format           | How it is verified                                               |
| ---------------- | ---------------------------------------------------------------- |
| PDF              | `%PDF-`                                                          |
| JPEG / PNG / GIF | Format signature                                                 |
| WebP             | `RIFF` container                                                 |
| xlsx/docx/pptx   | A real ZIP container; the specific type comes from the extension |
| ZIP              | ZIP signature                                                    |
| CSV / txt        | Decodes as UTF-8, and contains no NUL byte                       |

**The honest limit**: the Office formats are ZIP containers, and telling xlsx
from docx means reading the central directory. A .docx renamed to .xlsx passes.
What does not pass is anything that is not a ZIP at all — the file that is
really a program, which is the case that matters.

The stored `content_type` is the canonical one from this table, and it is what
the download serves. The uploader's is never stored and never echoed.

### 3. The storage name is generated

`storageKeyFor` produces `YYYY/MM/<the row's own uuid>`, with **no extension**.

The uploaded name is kept in `original_name`, shown to people, and never used
as a path. A stored name ending in `.html` is one webserver misconfiguration
away from being served as a page from your own origin; a stored name containing
anything from the request is a path traversal waiting for a mistake elsewhere.

`AttachmentStore` re-checks that a resolved path is inside the root anyway. It
should be impossible to fail — that is why it is cheap to keep.

### 4. Permission is re-checked on download

`GET /api/v1/attachments/:id` loads the attachment, finds the channel it was
uploaded to, and asks the same access rules every other chat endpoint asks.

A link is not a capability. Somebody removed from a private channel stops being
able to fetch its files, including ones they were sent while still a member and
whose URLs are still in their browser history.

The response also carries `X-Content-Type-Options: nosniff` and a
`Content-Disposition` of `attachment` — except for the verified image formats,
which are `inline` so a photograph appears in the conversation.

## Why upload and send are separate

`message_attachments.message_id` was `NOT NULL` in the original chat schema,
which assumed a file could only exist once its message did. That is the wrong
order: somebody picks a file, waits for it to upload, and only then finishes
typing.

The `chat-attachments` migration makes `message_id` nullable and adds
`channel_id` and `uploaded_by`, so an upload is a complete, answerable thing
before any message exists:

- **who may download it** — the channel is fixed at upload time
- **who may attach it** — only the uploader, only in that channel, only once
- **what removes the ones nobody sent** — a sweep, below

### Claiming

`attachmentIds` on the send request. One statement claims them all, and the
count is compared:

```sql
UPDATE message_attachments SET message_id = $1
 WHERE id = ANY($2) AND message_id IS NULL
   AND channel_id = $3 AND uploaded_by = $4
```

Anything that does not match fails the **whole send** with 422 and names the
ids. Delivering the message and quietly dropping the file would be this
product's own worst case: a report of success with the thing anybody cared
about missing.

Three attacks fall out of that one statement: attaching somebody else's upload,
attaching a file from a private channel onto a public message, and attaching
the same file to a second message.

## The sweep

Picking a file and changing your mind is normal, and each of those leaves a row
and a file behind. `sweepUnclaimedAttachments` runs on the existing worker loop
and deletes unclaimed rows older than an hour, then their files.

**The row goes first, the file second.** That order can leave a file with no
row — a wasted block on disk. The other order can leave a row pointing at a
deleted file — a download that fails forever. Given the choice, waste the space.

## Operations

`ATTACHMENT_ROOT` is a plain directory. Not object storage: an organisation
that can run one container should not also need an S3 account, and a backup of
this directory plus a database dump is the whole system.

**In Docker it must be a mounted volume.** `docker-compose.yml` declares one.
Without it, the next `docker compose up --build` destroys every uploaded file
while the database keeps the rows pointing at them — downloads that fail
forever, with no error until somebody clicks one.

## Limits

- 25 MiB per file, enforced in three places: the route's `bodyLimit` (so an
  oversized body is refused before it is read into memory), the validator, and
  a CHECK constraint on the table.
- Ten attachments per message.
- No virus scanning. Stated plainly because it is the thing people assume: this
  verifies what a file _is_, not whether its contents are hostile.
