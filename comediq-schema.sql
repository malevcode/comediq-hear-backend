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

-- INDEXES
create index if not exists idx_bits_set_id on bits(set_id);
create index if not exists idx_bits_identity_id on bits(bit_identity_id);
create index if not exists idx_bit_performances_identity_id on bit_performances(bit_identity_id);
create index if not exists idx_bit_performances_set_id on bit_performances(set_id);
create index if not exists idx_sets_created_at on sets(created_at desc);

-- RLS
alter table sets enable row level security;
alter table bits enable row level security;
alter table bit_identities enable row level security;
alter table bit_performances enable row level security;

create policy "service_full" on sets for all to service_role using (true);
create policy "service_full" on bits for all to service_role using (true);
create policy "service_full" on bit_identities for all to service_role using (true);
create policy "service_full" on bit_performances for all to service_role using (true);
