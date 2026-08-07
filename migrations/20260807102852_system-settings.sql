-- system-settings
--
-- Key/value configuration an administrator can change without redeploying.
-- Values that are credentials for *other* systems (the SMTP password) are
-- stored encrypted; see packages/secret-store. Anything that is only ever
-- compared rather than replayed is hashed instead and does not belong here.

-- Up Migration

CREATE TABLE system_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_system_settings_key CHECK (length(trim(key)) > 0)
);

COMMENT ON TABLE system_settings IS
  'Administrator-editable configuration. Credential fields inside `value` are ciphertext from the secret store and must never be returned by the API in plaintext.';

-- Down Migration

DROP TABLE IF EXISTS system_settings;
