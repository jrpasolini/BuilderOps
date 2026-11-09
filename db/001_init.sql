-- The verified Auth0 subject is the sole owner identifier.
CREATE TABLE IF NOT EXISTS profiles (
  user_sub TEXT PRIMARY KEY,
  preferred_city TEXT NOT NULL DEFAULT 'vitoria' CHECK (preferred_city IN ('vitoria','sao-paulo','lisboa')),
  temperature_unit TEXT NOT NULL DEFAULT 'celsius' CHECK (temperature_unit IN ('celsius','fahrenheit')),
  response_language TEXT NOT NULL DEFAULT 'pt-BR' CHECK (response_language IN ('pt-BR','en-US')),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  user_sub TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_conversations_owner ON conversations(user_sub, updated_at);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_sub TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(user_sub, conversation_id, created_at);
