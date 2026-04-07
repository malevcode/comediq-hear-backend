-- ============================================
-- comediq.hear database schema v2
-- ============================================

-- 1. SETS
create table if not exists sets (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  venue text,
  date text,
  date_iso timestamptz,
  duration_sec numeric,
  audio_url text,
  transcript text,
  overall_score numeric,
  overall_summary text,
  strongest_bit text,
  total_duration text,
  context jsonb default '{}',
  laugh_data jsonb default '{}',
  pause_points jsonb default '[]',
  words jsonb default '[]'
);

-- 2. BIT IDENTITIES
create table if not exists bit_identities (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  canonical_name text not null,
  slug text unique,
  topic_tags text[] default '{}',
  total_performances integer default 0,
  avg_analysis_score numeric,
  avg_user_rating numeric,
  avg_laugh_proxy numeric,
  best_score numeric,
  first_seen_at timestamptz default now(),
  last_performed_at timestamptz
);

-- 3. BITS
create table if not exists bits (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  set_id uuid references sets(id) on delete cascade,
  bit_identity_id uuid references bit_identities(id),
  name text,
  score numeric,
  setup text,
  punchline text,
  feedback text,
  tags text[] default '{}',
  positives text[] default '{}',
  improvements text[] default '{}',
  transcript_excerpt text,
  likely_laughed boolean default false,
  timestamp_sec numeric,
  pause_duration_ms numeric,
  user_rating numeric,
  chunk_name text
);

-- 4. BIT PERFORMANCES
create table if not exists bit_performances (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  bit_id uuid references bits(id) on delete cascade,
  bit_identity_id uuid references bit_identities(id),
  set_id uuid references sets(id) on delete cascade,
  performance_date text,
  performance_date_iso timestamptz,
  venue text,
  user_rating numeric,
  analysis_score numeric,
  laugh_proxy_score numeric,
  likely_laughed boolean,
  pause_duration_ms numeric,
  context_notes text,
  crowd_size integer,
  crowd_type text,
  audience_notes text
);

-- 5. QUICK NOTES
create table if not exists quick_notes (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  text text not null,
  captured_during_set boolean default false,
  set_id uuid references sets(id) on delete set null,
  processed boolean default false
);

-- 6. SET PLANS
create table if not exists set_plans (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  name text,
  items jsonb default '[]',
  used_in_set_id uuid references sets(id) on delete set null
);

-- 8. CHUNKS
-- A named section of a single set (opener / middle / closer / theme block).
-- Auto-populated from Claude analysis; one row per chunk per set.
create table if not exists chunks (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  set_id uuid references sets(id) on delete cascade,
  name text not null,
  position_order integer,       -- 1-based order within the set
  start_sec numeric,            -- approximate start time in the recording
  end_sec numeric,              -- approximate end time
  overall_score numeric,        -- avg analysis score of bits in this chunk
  laugh_count integer default 0,-- bits that likely got a laugh
  bit_count integer default 0,
  topics text[] default '{}'    -- topic tags for this chunk
);

-- 9. TOPICS
-- Persistent thematic tags (e.g. "dating apps", "work", "family") that
-- span many sets and aggregate performance across all linked bits.
create table if not exists topics (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  name text not null,
  slug text unique,
  description text,
  total_performances integer default 0,  -- sets this topic appeared in
  avg_score numeric,
  best_score numeric,
  last_performed_at timestamptz
);

-- 10. BIT_TOPICS  (many-to-many: bit identities ↔ topics)
create table if not exists bit_topics (
  bit_identity_id uuid references bit_identities(id) on delete cascade,
  topic_id uuid references topics(id) on delete cascade,
  primary key (bit_identity_id, topic_id)
);

-- 11. SET_TOPICS  (many-to-many: sets ↔ topics, for per-set topic coverage)
create table if not exists set_topics (
  set_id uuid references sets(id) on delete cascade,
  topic_id uuid references topics(id) on delete cascade,
  primary key (set_id, topic_id)
);

-- SCHEMA MIGRATIONS (run after initial schema if tables already exist)
alter table bit_identities add column if not exists status text default 'premise';
alter table bit_identities add column if not exists written_text text;
alter table bit_identities add column if not exists confidence_history jsonb default '[]';
alter table bit_identities add column if not exists latest_confidence numeric;

-- Set-level reflection fields (filled by the comedian after the show)
alter table sets add column if not exists confidence_rating numeric;    -- 1-10 overall confidence
alter table sets add column if not exists personal_notes text;          -- free-text post-show notes
alter table sets add column if not exists audience_reception text;      -- great/good/mixed/tough
alter table sets add column if not exists topic_summary text;           -- auto-generated topic overview
alter table sets add column if not exists total_laugh_count integer default 0;
alter table sets add column if not exists set_topics text[] default '{}'; -- topic names for quick display

-- Per-bit personal notes for a specific performance
alter table bits add column if not exists personal_notes text;

-- Link bits to their DB chunk row (in addition to chunk_name string)
alter table bits add column if not exists chunk_id uuid references chunks(id) on delete set null;

-- INDEXES
create index if not exists idx_chunks_set_id on chunks(set_id);
create index if not exists idx_topics_slug on topics(slug);
create index if not exists idx_bit_topics_bit_identity_id on bit_topics(bit_identity_id);
create index if not exists idx_bit_topics_topic_id on bit_topics(topic_id);
create index if not exists idx_set_topics_set_id on set_topics(set_id);
create index if not exists idx_set_topics_topic_id on set_topics(topic_id);
create index if not exists idx_bits_chunk_id on bits(chunk_id);
create index if not exists idx_bits_set_id on bits(set_id);
create index if not exists idx_bits_identity_id on bits(bit_identity_id);
create index if not exists idx_bit_performances_identity_id on bit_performances(bit_identity_id);
create index if not exists idx_bit_performances_set_id on bit_performances(set_id);
create index if not exists idx_sets_created_at on sets(created_at desc);
create index if not exists idx_quick_notes_created_at on quick_notes(created_at desc);
create index if not exists idx_bit_identities_status on bit_identities(status);

-- 7. REVIEW STATE
-- Single-row table tracking in-app review prompts.
-- id is always 'singleton' — upserted, never inserted fresh.
create table if not exists review_state (
  id text primary key default 'singleton',
  created_at timestamptz default now(),
  -- True once the user has actually left a review (stop prompting forever).
  review_completed boolean default false,
  review_completed_at timestamptz,
  -- JSON array of ISO-8601 timestamps, one entry per time we showed the prompt.
  -- Used to enforce the ≤3 requests-per-calendar-year rule.
  request_timestamps jsonb default '[]'
);

-- RLS
alter table review_state enable row level security;
create policy "service_full" on review_state for all to service_role using (true);

-- RLS
alter table sets enable row level security;
alter table bits enable row level security;
alter table bit_identities enable row level security;
alter table bit_performances enable row level security;
alter table quick_notes enable row level security;
alter table set_plans enable row level security;

create policy "service_full" on sets for all to service_role using (true);
create policy "service_full" on bits for all to service_role using (true);
create policy "service_full" on bit_identities for all to service_role using (true);
create policy "service_full" on bit_performances for all to service_role using (true);
create policy "service_full" on quick_notes for all to service_role using (true);
create policy "service_full" on set_plans for all to service_role using (true);
create policy "service_full" on chunks for all to service_role using (true);
create policy "service_full" on topics for all to service_role using (true);
create policy "service_full" on bit_topics for all to service_role using (true);
create policy "service_full" on set_topics for all to service_role using (true);
