# Chat permissions

## Department groups

Every organisation unit has exactly one managed channel. Its displayed name and
description come from the unit, and its membership follows `user_org_units`:
joining the unit joins the channel, leaving the unit leaves the channel, and
restoring a disabled unit restores the same chat history.

Owners and administrators may read and moderate a managed department channel
without being assigned to that unit. They may choose either:

- `everyone`: every active unit member may post;
- `admins_only`: members can read, but only Owners and administrators may post.

They may also mute one ordinary member. Both rules are checked by the server for
messages and attachments; hiding the composer is only the matching interface.
Direct conversations never inherit either rule.

## Direct conversations

Every active person account can start a direct conversation with another active
person account. The pair has one durable conversation, no matter which side
opens it or how many devices they use. Somebody outside that pair receives 404,
including an administrator: an administrative role is not permission to read a
private conversation.

Invitation-only membership is a sensible access boundary for a small company,
but it is not a complete interpersonal-safety policy. It keeps outsiders out;
it does not prevent an invited colleague from harassing another person or
copying information they can legitimately read. An administrator can disable an
account and revoke its sessions. Per-user blocking, reporting and legal-hold or
retention workflows are not implemented and must not be claimed.
