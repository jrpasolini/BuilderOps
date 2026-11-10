-- Calendar reads use Auth0 Token Vault. These tables store event ids and CIBA
-- request handles only. Do not store Google access tokens or refresh tokens here.
CREATE TABLE IF NOT EXISTS calendar_snapshots (
  user_sub TEXT PRIMARY KEY,
  events_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS calendar_approvals (
  id TEXT PRIMARY KEY,
  user_sub TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  action TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  binding_message TEXT NOT NULL,
  auth_req_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','executing','approved','denied','expired','error')),
  interval_seconds INTEGER NOT NULL DEFAULT 5,
  result_text TEXT,
  expires_at TEXT NOT NULL,
  next_poll_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_calendar_approvals_owner ON calendar_approvals(user_sub, status, created_at);
