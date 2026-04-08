-- ============================================================
-- Comediq D1 Schema (SQLite-compatible)
-- Translated from comediq-schema.sql (Supabase/PostgreSQL)
-- ============================================================
-- UUID generation is handled in application code (crypto.randomUUID()).
-- JSON columns stored as TEXT; arrays stored as JSON text (e.g. '[]').
-- Booleans stored as INTEGER (0/1).
-- ============================================================

PRAGMA journal_mode = WAL;

-- ── SETS ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sets (
  id                 TEXT PRIMARY KEY,
  created_at         TEXT DEFAULT (datetime('now')),
  venue              TEXT,
  date               TEXT,
  date_iso           TEXT,
  duration_sec       REAL,
  audio_url          TEXT,
  transcript         TEXT,
  overall_score      REAL,
  overall_summary    TEXT,
  strongest_bit      TEXT,
  total_duration     TEXT,
  context            TEXT DEFAULT '{}',
  laugh_data         TEXT DEFAULT '{}',
  pause_points       TEXT DEFAULT '[]',
  words              TEXT DEFAULT '[]',
  -- post-show reflection fields
  confidence_rating  REAL,
  personal_notes     TEXT,
  audience_reception TEXT,
  topic_summary      TEXT,
  total_laugh_count  INTEGER DEFAULT 0,
  set_topics         TEXT DEFAULT '[]'  -- JSON array of topic name strings
);

-- ── BIT IDENTITIES ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bit_identities (
  id                   TEXT PRIMARY KEY,
  created_at           TEXT DEFAULT (datetime('now')),
  canonical_name       TEXT NOT NULL,
  slug                 TEXT UNIQUE,
  topic_tags           TEXT DEFAULT '[]',   -- JSON array of strings
  total_performances   INTEGER DEFAULT 0,
  avg_analysis_score   REAL,
  avg_user_rating      REAL,
  avg_laugh_proxy      REAL,
  best_score           REAL,
  first_seen_at        TEXT,
  last_performed_at    TEXT,
  status               TEXT DEFAULT 'premise',  -- premise/being_written/retired/shelved
  written_text         TEXT,
  confidence_history   TEXT DEFAULT '[]',        -- JSON array
  latest_confidence    REAL
);

-- ── BITS ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bits (
  id                  TEXT PRIMARY KEY,
  created_at          TEXT DEFAULT (datetime('now')),
  set_id              TEXT REFERENCES sets(id) ON DELETE CASCADE,
  bit_identity_id     TEXT REFERENCES bit_identities(id),
  chunk_id            TEXT REFERENCES chunks(id) ON DELETE SET NULL,
  name                TEXT,
  score               REAL,
  setup               TEXT,
  punchline           TEXT,
  feedback            TEXT,
  tags                TEXT DEFAULT '[]',         -- JSON array of {text, tagType}
  positives           TEXT DEFAULT '[]',         -- JSON array of strings
  improvements        TEXT DEFAULT '[]',         -- JSON array of strings
  transcript_excerpt  TEXT,
  likely_laughed      INTEGER DEFAULT 0,         -- boolean
  timestamp_sec       REAL,
  pause_duration_ms   REAL,
  user_rating         REAL,
  chunk_name          TEXT,
  personal_notes      TEXT
);

-- ── BIT PERFORMANCES ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bit_performances (
  id                   TEXT PRIMARY KEY,
  created_at           TEXT DEFAULT (datetime('now')),
  bit_id               TEXT REFERENCES bits(id) ON DELETE CASCADE,
  bit_identity_id      TEXT REFERENCES bit_identities(id),
  set_id               TEXT REFERENCES sets(id) ON DELETE CASCADE,
  performance_date     TEXT,
  performance_date_iso TEXT,
  venue                TEXT,
  user_rating          REAL,
  analysis_score       REAL,
  laugh_proxy_score    REAL,
  likely_laughed       INTEGER,
  pause_duration_ms    REAL,
  context_notes        TEXT,
  crowd_size           INTEGER,
  crowd_type           TEXT,
  audience_notes       TEXT
);

-- ── CHUNKS ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chunks (
  id             TEXT PRIMARY KEY,
  created_at     TEXT DEFAULT (datetime('now')),
  set_id         TEXT REFERENCES sets(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  position_order INTEGER,
  start_sec      REAL,
  end_sec        REAL,
  overall_score  REAL,
  laugh_count    INTEGER DEFAULT 0,
  bit_count      INTEGER DEFAULT 0,
  topics         TEXT DEFAULT '[]'
);

-- ── TOPICS ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS topics (
  id                  TEXT PRIMARY KEY,
  created_at          TEXT DEFAULT (datetime('now')),
  name                TEXT NOT NULL,
  slug                TEXT UNIQUE,
  description         TEXT,
  total_performances  INTEGER DEFAULT 0,
  avg_score           REAL,
  best_score          REAL,
  last_performed_at   TEXT
);

-- ── BIT_TOPICS (many-to-many) ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bit_topics (
  bit_identity_id  TEXT REFERENCES bit_identities(id) ON DELETE CASCADE,
  topic_id         TEXT REFERENCES topics(id) ON DELETE CASCADE,
  PRIMARY KEY (bit_identity_id, topic_id)
);

-- ── SET_TOPICS (many-to-many) ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS set_topics (
  set_id    TEXT REFERENCES sets(id) ON DELETE CASCADE,
  topic_id  TEXT REFERENCES topics(id) ON DELETE CASCADE,
  PRIMARY KEY (set_id, topic_id)
);

-- ── QUICK NOTES ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS quick_notes (
  id                  TEXT PRIMARY KEY,
  created_at          TEXT DEFAULT (datetime('now')),
  text                TEXT NOT NULL,
  captured_during_set INTEGER DEFAULT 0,
  set_id              TEXT REFERENCES sets(id) ON DELETE SET NULL,
  processed           INTEGER DEFAULT 0
);

-- ── SET PLANS ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS set_plans (
  id             TEXT PRIMARY KEY,
  created_at     TEXT DEFAULT (datetime('now')),
  name           TEXT,
  items          TEXT DEFAULT '[]',
  used_in_set_id TEXT REFERENCES sets(id) ON DELETE SET NULL
);

-- ── REVIEW STATE ─────────────────────────────────────────────────────────────
-- Single-row table; id is always 'singleton'.
CREATE TABLE IF NOT EXISTS review_state (
  id                    TEXT PRIMARY KEY DEFAULT 'singleton',
  created_at            TEXT DEFAULT (datetime('now')),
  review_completed      INTEGER DEFAULT 0,
  review_completed_at   TEXT,
  request_timestamps    TEXT DEFAULT '[]'
);

-- ── JOBS (async processing tracker) ──────────────────────────────────────────
-- Tracks upload → transcription → analysis pipeline state.
CREATE TABLE IF NOT EXISTS jobs (
  id         TEXT PRIMARY KEY,
  status     TEXT DEFAULT 'pending',  -- pending/transcribing/analyzing/saving/done/error
  r2_key     TEXT,
  venue      TEXT,
  error      TEXT,
  set_id     TEXT REFERENCES sets(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- ── INDEXES ──────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_sets_created_at              ON sets(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chunks_set_id                ON chunks(set_id);
CREATE INDEX IF NOT EXISTS idx_bits_set_id                  ON bits(set_id);
CREATE INDEX IF NOT EXISTS idx_bits_identity_id             ON bits(bit_identity_id);
CREATE INDEX IF NOT EXISTS idx_bits_chunk_id                ON bits(chunk_id);
CREATE INDEX IF NOT EXISTS idx_bit_performances_identity_id ON bit_performances(bit_identity_id);
CREATE INDEX IF NOT EXISTS idx_bit_performances_set_id      ON bit_performances(set_id);
CREATE INDEX IF NOT EXISTS idx_topics_slug                  ON topics(slug);
CREATE INDEX IF NOT EXISTS idx_bit_topics_identity_id       ON bit_topics(bit_identity_id);
CREATE INDEX IF NOT EXISTS idx_bit_topics_topic_id          ON bit_topics(topic_id);
CREATE INDEX IF NOT EXISTS idx_set_topics_set_id            ON set_topics(set_id);
CREATE INDEX IF NOT EXISTS idx_set_topics_topic_id          ON set_topics(topic_id);
CREATE INDEX IF NOT EXISTS idx_bit_identities_status        ON bit_identities(status);
CREATE INDEX IF NOT EXISTS idx_quick_notes_created_at       ON quick_notes(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_status                  ON jobs(status);
