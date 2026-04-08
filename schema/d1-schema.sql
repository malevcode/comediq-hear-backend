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
  personal_notes      TEXT,
  captions            TEXT DEFAULT '[]'          -- JSON array of Claude-generated caption strings
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
  id          TEXT PRIMARY KEY,
  status      TEXT DEFAULT 'pending',  -- pending/transcribing/analyzing/saving/done/error
  r2_key      TEXT,
  venue       TEXT,
  error       TEXT,
  source_type TEXT DEFAULT 'audio',    -- audio | video
  set_id      TEXT REFERENCES sets(id) ON DELETE SET NULL,
  created_at  TEXT DEFAULT (datetime('now')),
  updated_at  TEXT DEFAULT (datetime('now'))
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

-- ── USERS & SESSIONS (auth) ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  created_at    TEXT DEFAULT (datetime('now')),
  email         TEXT UNIQUE NOT NULL,
  name          TEXT,
  avatar_r2_key TEXT,                        -- R2 object key for profile photo
  google_sub    TEXT UNIQUE,                 -- stable Google OAuth subject ID
  role          TEXT NOT NULL DEFAULT 'comedian',  -- comedian | booker | audience | admin
  supabase_uid  TEXT                         -- legacy: used for silent migration from Supabase
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,               -- opaque UUID used as Bearer token
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL                   -- 30-day rolling expiry
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id   ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

-- ── OPEN MICS ─────────────────────────────────────────────────────────────────
-- Seeded from comediq.us open_mics_historical; crowd-verified via check-ins.
CREATE TABLE IF NOT EXISTS open_mics (
  id               TEXT PRIMARY KEY,
  created_at       TEXT DEFAULT (datetime('now')),
  name             TEXT NOT NULL,
  venue_name       TEXT,
  address          TEXT,
  city             TEXT,
  state            TEXT,
  lat              REAL,
  lng              REAL,
  day_of_week      TEXT,                     -- Monday … Sunday | varies
  start_time       TEXT,                     -- HH:MM (24h)
  host             TEXT,
  entry_fee        REAL,
  sign_up_type     TEXT,                     -- list | lottery | email | app
  notes            TEXT,
  is_active        INTEGER DEFAULT 1,
  last_verified_at TEXT,
  source           TEXT DEFAULT 'comediq_us' -- comediq_us | user_submitted | manual
);

CREATE TABLE IF NOT EXISTS mic_check_ins (
  id               TEXT PRIMARY KEY,
  created_at       TEXT DEFAULT (datetime('now')),
  user_id          TEXT REFERENCES users(id) ON DELETE SET NULL,
  open_mic_id      TEXT REFERENCES open_mics(id) ON DELETE SET NULL,
  performed_set_id TEXT REFERENCES sets(id) ON DELETE SET NULL,
  notes            TEXT
);

CREATE INDEX IF NOT EXISTS idx_open_mics_city       ON open_mics(city);
CREATE INDEX IF NOT EXISTS idx_open_mics_active     ON open_mics(is_active);
CREATE INDEX IF NOT EXISTS idx_mic_checkins_user    ON mic_check_ins(user_id);
CREATE INDEX IF NOT EXISTS idx_mic_checkins_mic     ON mic_check_ins(open_mic_id);

-- ── SHOWS + TICKETING ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shows (
  id                  TEXT PRIMARY KEY,
  created_at          TEXT DEFAULT (datetime('now')),
  name                TEXT NOT NULL,
  venue               TEXT,
  city                TEXT,
  state               TEXT,
  date_iso            TEXT,                  -- YYYY-MM-DD
  start_time          TEXT,                  -- HH:MM
  capacity            INTEGER,
  ticket_price_cents  INTEGER,               -- base price set by booker
  status              TEXT DEFAULT 'planning', -- planning|on-sale|sold-out|past|cancelled
  description         TEXT,
  booker_id           TEXT REFERENCES users(id) ON DELETE SET NULL,
  is_public           INTEGER DEFAULT 0      -- 1 = visible in ShowTN catalog
);

CREATE TABLE IF NOT EXISTS show_lineups (
  id             TEXT PRIMARY KEY,
  show_id        TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  comedian_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  comedian_name  TEXT,
  set_time_min   INTEGER,
  order_position INTEGER,
  notes          TEXT
);

CREATE TABLE IF NOT EXISTS tickets (
  id                       TEXT PRIMARY KEY,
  created_at               TEXT DEFAULT (datetime('now')),
  show_id                  TEXT NOT NULL REFERENCES shows(id) ON DELETE RESTRICT,
  buyer_name               TEXT,
  buyer_email              TEXT NOT NULL,
  quantity                 INTEGER DEFAULT 1,
  ticket_price_cents       INTEGER,
  service_fee_cents        INTEGER,          -- 3.7% of ticket price + $1.79
  processing_fee_cents     INTEGER,          -- 2.9% of subtotal + $0.30 (Stripe)
  stripe_payment_intent_id TEXT,
  status                   TEXT DEFAULT 'pending',  -- pending|paid|refunded|cancelled
  ticket_code              TEXT UNIQUE,      -- generated on payment confirmation
  source                   TEXT DEFAULT 'direct',   -- direct | showtn
  purchased_at             TEXT
);

CREATE TABLE IF NOT EXISTS audience_check_ins (
  id            TEXT PRIMARY KEY,
  created_at    TEXT DEFAULT (datetime('now')),
  show_id       TEXT REFERENCES shows(id) ON DELETE SET NULL,
  ticket_code   TEXT,
  buyer_email   TEXT,
  checked_in_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_shows_date       ON shows(date_iso);
CREATE INDEX IF NOT EXISTS idx_shows_status     ON shows(status);
CREATE INDEX IF NOT EXISTS idx_shows_booker     ON shows(booker_id);
CREATE INDEX IF NOT EXISTS idx_shows_public     ON shows(is_public);
CREATE INDEX IF NOT EXISTS idx_lineups_show     ON show_lineups(show_id);
CREATE INDEX IF NOT EXISTS idx_tickets_show     ON tickets(show_id);
CREATE INDEX IF NOT EXISTS idx_tickets_email    ON tickets(buyer_email);
CREATE INDEX IF NOT EXISTS idx_tickets_code     ON tickets(ticket_code);
CREATE INDEX IF NOT EXISTS idx_tickets_status   ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_checkins_show    ON audience_check_ins(show_id);

-- ── SHOWTN SUBSCRIPTIONS ──────────────────────────────────────────────────────
-- Audience members subscribe monthly and receive one free show ticket per month.
CREATE TABLE IF NOT EXISTS showtn_subscribers (
  id                      TEXT PRIMARY KEY,
  created_at              TEXT DEFAULT (datetime('now')),
  user_id                 TEXT REFERENCES users(id) ON DELETE SET NULL,
  stripe_customer_id      TEXT,
  stripe_subscription_id  TEXT,
  status                  TEXT DEFAULT 'active',  -- active | paused | cancelled
  subscribed_at           TEXT,
  cancelled_at            TEXT
);

CREATE TABLE IF NOT EXISTS showtn_allocations (
  id              TEXT PRIMARY KEY,
  subscriber_id   TEXT NOT NULL REFERENCES showtn_subscribers(id) ON DELETE CASCADE,
  month           TEXT NOT NULL,             -- YYYY-MM
  show_id         TEXT REFERENCES shows(id) ON DELETE SET NULL,
  redeemed_at     TEXT,
  ticket_code     TEXT UNIQUE,               -- generated on redemption
  UNIQUE(subscriber_id, month)
);

CREATE INDEX IF NOT EXISTS idx_showtn_sub_user    ON showtn_subscribers(user_id);
CREATE INDEX IF NOT EXISTS idx_showtn_sub_status  ON showtn_subscribers(status);
CREATE INDEX IF NOT EXISTS idx_showtn_alloc_sub   ON showtn_allocations(subscriber_id);
CREATE INDEX IF NOT EXISTS idx_showtn_alloc_month ON showtn_allocations(month);
