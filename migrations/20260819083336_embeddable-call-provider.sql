-- embeddable-call-provider
--
-- Whether the provider's room may be shown inside Atarimae rather than in its
-- own window.
--
-- Off by default, and it has to be, for a reason that is about browsers rather
-- than taste: a page cannot tell whether a cross-origin frame loaded or was
-- refused by the provider's own `X-Frame-Options`. The load event fires either
-- way and nothing inside is readable. So "try it and fall back" is not
-- available — an administrator who knows their provider has to say so, and
-- until they do, the behaviour is the one already known to work.
--
-- The column also decides what the Content-Security-Policy allows. Nothing may
-- be framed unless a row here says it may, which keeps the answer to "what can
-- this application embed" in one place that an administrator can see.

-- Up Migration

ALTER TABLE call_providers
  ADD COLUMN embeddable boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN call_providers.embeddable IS
  'Room may be shown in an iframe. Requires the provider to permit framing; '
  'browsers give no way to detect that it does not.';

-- Down Migration

ALTER TABLE call_providers
  DROP COLUMN embeddable;
