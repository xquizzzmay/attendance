-- Схема базы «Посещаемость» (Cloudflare D1 / SQLite).
-- Применить: npx wrangler d1 execute attendance --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS groups (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pairs_per_day INTEGER NOT NULL DEFAULT 3,
  reg_key_hash  TEXT,            -- ключ регистрации старосты (одноразовый), хранится только хеш
  pass_hash     TEXT,            -- пароль старосты: PBKDF2
  pass_salt     TEXT,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS students (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id   INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  full_name  TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,   -- 0 = удалён из списка (история отметок остаётся)
  created_at INTEGER NOT NULL,
  removed_at INTEGER
);
CREATE INDEX IF NOT EXISTS students_group ON students(group_id, active);

-- Одна отметка = один ученик на одной паре в один день. present: 1 = «+», 0 = «−».
CREATE TABLE IF NOT EXISTS marks (
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  day        TEXT NOT NULL,              -- 'YYYY-MM-DD' по Ташкенту
  pair       INTEGER NOT NULL,
  present    INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (student_id, day, pair)
);
CREATE INDEX IF NOT EXISTS marks_day ON marks(day);

-- Сессии входа: хранится только хеш токена.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  role       TEXT NOT NULL,              -- 'admin' | 'group'
  group_id   INTEGER,
  expires_at INTEGER NOT NULL
);

-- Защита от подбора пароля/ключа: число неудач и блокировка.
CREATE TABLE IF NOT EXISTS throttle (
  k            TEXT PRIMARY KEY,
  fails        INTEGER NOT NULL,
  locked_until INTEGER NOT NULL
);
