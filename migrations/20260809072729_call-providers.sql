-- call-providers
--
-- 通話 — voice and video calls over the network, the way LINE and WeChat
-- do them. Not telephone calls.
--
-- Atarimae does not carry the media and is not going to. Running an SFU is a
-- product of its own, and a small office that wants calls should be able to
-- point this at whatever it already has — a self-hosted Jitsi on the office
-- LAN, or a hosted service — rather than at whatever this project happened to
-- bundle. So a call has two halves: the part that belongs here (who is being
-- called, when it started, was it answered, is it still going) and the part
-- that does not (the audio).
--
-- Two provider kinds, which is the whole extensibility story:
--
--   'url'  — a room URL template. `https://meet.example.com/{room}`. Nothing
--            is asked of the provider; Atarimae generates the room name and
--            hands out the link. This is enough for Jitsi and most of the
--            self-hostable ones, and it needs no credential at all.
--
--   'http' — ask an API for a room. For services that mint a room or a join
--            token per call. The API secret is ENCRYPTED, because unlike every
--            token in this project it has to be sent to somebody.

-- Up Migration

CREATE TABLE call_providers (
  id                    uuid PRIMARY KEY DEFAULT uuidv7(),

  -- What an administrator calls it: "社内 Jitsi", not "provider 1".
  name                  text NOT NULL,
  kind                  text NOT NULL,

  -- kind = 'url'. `{room}` is substituted; nothing else is.
  url_template          text,

  -- kind = 'http'. Where to ask, and how to read the answer.
  request_url           text,
  request_headers       jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_body_template text,
  -- Dotted path to the join URL in the JSON response, e.g. 'data.url'.
  response_url_path     text,

  -- enc:v1:<keyid>:... — substituted into headers and body as {secret}.
  -- Encrypted rather than hashed: this one is presented to another system, so
  -- the plaintext has to come back. See docs/architecture/decisions.md.
  secret_encrypted      text,

  -- The one a call uses when nobody chose. Exactly one, enforced below.
  is_default            boolean NOT NULL DEFAULT false,

  created_by            uuid NOT NULL REFERENCES users(id),
  disabled_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_call_provider_kind CHECK (kind IN ('url', 'http')),
  CONSTRAINT ck_call_provider_name CHECK (length(trim(name)) > 0),

  -- Each kind needs its own fields and must not carry the other's. A row with
  -- both is a configuration nobody can reason about, and the failure would
  -- appear as a call that does not connect.
  CONSTRAINT ck_call_provider_url_kind CHECK (
    kind <> 'url' OR (url_template IS NOT NULL AND request_url IS NULL)
  ),
  CONSTRAINT ck_call_provider_http_kind CHECK (
    kind <> 'http' OR (
      request_url IS NOT NULL
      AND response_url_path IS NOT NULL
      AND url_template IS NULL
    )
  ),

  -- A template with no room placeholder sends everybody into one shared room,
  -- for every call, forever. That is not a small bug — it is two unrelated
  -- conversations hearing each other.
  CONSTRAINT ck_call_provider_url_has_room CHECK (
    url_template IS NULL OR url_template LIKE '%{room}%'
  )
);

CREATE TRIGGER trg_call_providers_updated_at
  BEFORE UPDATE ON call_providers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- At most one default among the live ones. Two defaults is a coin toss over
-- which service an office's calls go to.
CREATE UNIQUE INDEX uq_call_provider_default
  ON call_providers ((true))
  WHERE is_default AND disabled_at IS NULL;

-- ---------------------------------------------------------------------------
-- calls
-- ---------------------------------------------------------------------------

CREATE TABLE calls (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  channel_id   uuid NOT NULL REFERENCES channels(id),
  provider_id  uuid NOT NULL REFERENCES call_providers(id),

  -- Generated here, never derived from anything a caller sends. A room name
  -- taken from a channel name would be guessable, and a guessable room is one
  -- an outsider can walk into.
  room_name    text NOT NULL,

  -- Where to go. Handed out by POST /calls/:id/join, which re-checks channel
  -- membership first — a link is not a capability, the same rule as
  -- attachments.
  join_url     text NOT NULL,

  started_by   uuid NOT NULL REFERENCES users(id),
  started_at   timestamptz NOT NULL DEFAULT now(),
  ended_at     timestamptz,
  ended_reason text,

  CONSTRAINT ck_call_ended_after_start CHECK (ended_at IS NULL OR ended_at >= started_at)
);

-- One live call per channel. Pressing 通話 while a call is already running
-- joins it; it does not open a second room with half the participants in each.
CREATE UNIQUE INDEX uq_call_live_per_channel
  ON calls (channel_id)
  WHERE ended_at IS NULL;

CREATE INDEX ix_calls_channel ON calls (channel_id, started_at DESC);

-- ---------------------------------------------------------------------------
-- who was on it
-- ---------------------------------------------------------------------------

-- Answers "did anybody actually pick up", which is the difference between a
-- call that happened and a call that rang out. The interface shows both.
CREATE TABLE call_participants (
  id        uuid PRIMARY KEY DEFAULT uuidv7(),
  call_id   uuid NOT NULL REFERENCES calls(id),
  user_id   uuid NOT NULL REFERENCES users(id),
  joined_at timestamptz NOT NULL DEFAULT now(),
  left_at   timestamptz
);

CREATE UNIQUE INDEX uq_call_participant ON call_participants (call_id, user_id);

CREATE INDEX ix_call_participants_call ON call_participants (call_id);

-- Down Migration

DROP TABLE IF EXISTS call_participants;
DROP TABLE IF EXISTS calls;
DROP TABLE IF EXISTS call_providers;
