-- Migração inaugural do mecanismo incremental.
-- É exclusivamente aditiva e segura para instalações existentes.
CREATE TABLE IF NOT EXISTS app_releases (
  release_id text PRIMARY KEY,
  color text,
  git_commit text,
  deployed_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  status text NOT NULL DEFAULT 'deployed',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS app_releases_deployed_at
  ON app_releases (deployed_at DESC);
