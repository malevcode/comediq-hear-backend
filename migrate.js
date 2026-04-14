/**
 * Comediq — Supabase Schema Migration
 *
 * Run this once to add all new columns and tables.
 *
 * SETUP:
 *   1. Go to Supabase dashboard → Settings → Database
 *   2. Copy the "Connection string" (URI format) — it looks like:
 *      postgresql://postgres:[YOUR-PASSWORD]@db.roakmtukscvktwyqfcmh.supabase.co:5432/postgres
 *   3. Run:
 *      DB_URL="postgresql://postgres:YOURPASSWORD@db.roakmtukscvktwyqfcmh.supabase.co:5432/postgres" node migrate.js
 */

const { Client } = require('pg');

const DB_URL = process.env.DB_URL;

if (!DB_URL) {
  console.error('\n❌  DB_URL environment variable is required.');
  console.error('\n   Get it from: Supabase Dashboard → Settings → Database → Connection string (URI)');
  console.error('\n   Run as:');
  console.error('   DB_URL="postgresql://postgres:PASSWORD@db.roakmtukscvktwyqfcmh.supabase.co:5432/postgres" node migrate.js\n');
  process.exit(1);
}

const migrations = [
  // ── New columns on bit_identities ──
  {
    name: 'bit_identities.status',
    sql: `ALTER TABLE bit_identities ADD COLUMN IF NOT EXISTS status text DEFAULT 'premise'`
  },
  {
    name: 'bit_identities.written_text',
    sql: `ALTER TABLE bit_identities ADD COLUMN IF NOT EXISTS written_text text`
  },
  {
    name: 'bit_identities.confidence_history',
    sql: `ALTER TABLE bit_identities ADD COLUMN IF NOT EXISTS confidence_history jsonb DEFAULT '[]'`
  },
  {
    name: 'bit_identities.latest_confidence',
    sql: `ALTER TABLE bit_identities ADD COLUMN IF NOT EXISTS latest_confidence numeric`
  },

  // ── New columns on sets ──
  {
    name: 'sets.confidence_rating',
    sql: `ALTER TABLE sets ADD COLUMN IF NOT EXISTS confidence_rating numeric`
  },
  {
    name: 'sets.personal_notes',
    sql: `ALTER TABLE sets ADD COLUMN IF NOT EXISTS personal_notes text`
  },
  {
    name: 'sets.audience_reception',
    sql: `ALTER TABLE sets ADD COLUMN IF NOT EXISTS audience_reception text`
  },
  {
    name: 'sets.topic_summary',
    sql: `ALTER TABLE sets ADD COLUMN IF NOT EXISTS topic_summary text`
  },
  {
    name: 'sets.total_laugh_count',
    sql: `ALTER TABLE sets ADD COLUMN IF NOT EXISTS total_laugh_count integer DEFAULT 0`
  },
  {
    name: 'sets.set_topics',
    sql: `ALTER TABLE sets ADD COLUMN IF NOT EXISTS set_topics text[] DEFAULT '{}'`
  },
  {
    name: 'sets.overall_summary',
    sql: `ALTER TABLE sets ADD COLUMN IF NOT EXISTS overall_summary text`
  },

  // ── New columns on bits ──
  {
    name: 'bits.personal_notes',
    sql: `ALTER TABLE bits ADD COLUMN IF NOT EXISTS personal_notes text`
  },
  {
    name: 'bits.chunk_id',
    sql: `ALTER TABLE bits ADD COLUMN IF NOT EXISTS chunk_id uuid REFERENCES chunks(id) ON DELETE SET NULL`
  },

  // ── New tables ──
  {
    name: 'table: chunks',
    sql: `
      CREATE TABLE IF NOT EXISTS chunks (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        created_at timestamptz DEFAULT now(),
        set_id uuid REFERENCES sets(id) ON DELETE CASCADE,
        name text NOT NULL,
        position_order integer,
        start_sec numeric,
        end_sec numeric,
        overall_score numeric,
        laugh_count integer DEFAULT 0,
        bit_count integer DEFAULT 0,
        topics text[] DEFAULT '{}'
      )
    `
  },
  {
    name: 'table: topics',
    sql: `
      CREATE TABLE IF NOT EXISTS topics (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        created_at timestamptz DEFAULT now(),
        name text NOT NULL,
        slug text UNIQUE,
        description text,
        total_performances integer DEFAULT 0,
        avg_score numeric,
        best_score numeric,
        last_performed_at timestamptz
      )
    `
  },
  {
    name: 'table: bit_topics',
    sql: `
      CREATE TABLE IF NOT EXISTS bit_topics (
        bit_identity_id uuid REFERENCES bit_identities(id) ON DELETE CASCADE,
        topic_id uuid REFERENCES topics(id) ON DELETE CASCADE,
        PRIMARY KEY (bit_identity_id, topic_id)
      )
    `
  },
  {
    name: 'table: set_topics',
    sql: `
      CREATE TABLE IF NOT EXISTS set_topics (
        set_id uuid REFERENCES sets(id) ON DELETE CASCADE,
        topic_id uuid REFERENCES topics(id) ON DELETE CASCADE,
        PRIMARY KEY (set_id, topic_id)
      )
    `
  },
  {
    name: 'table: review_state',
    sql: `
      CREATE TABLE IF NOT EXISTS review_state (
        id text PRIMARY KEY DEFAULT 'singleton',
        created_at timestamptz DEFAULT now(),
        review_completed boolean DEFAULT false,
        review_completed_at timestamptz,
        request_timestamps jsonb DEFAULT '[]'
      )
    `
  },

  // ── Batch job queue ──
  {
    name: 'table: batch_jobs',
    sql: `
      CREATE TABLE IF NOT EXISTS batch_jobs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        batch_id uuid NOT NULL,
        filename text NOT NULL,
        audio_url text NOT NULL,
        status text NOT NULL DEFAULT 'queued',
        stage text,
        set_id uuid REFERENCES sets(id) ON DELETE SET NULL,
        error text,
        venue text NOT NULL DEFAULT 'Open Mic',
        date_override text,
        detected_date text,
        retry_count integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        started_at timestamptz,
        completed_at timestamptz
      )
    `
  },
  { name: 'idx_batch_jobs_batch_id', sql: `CREATE INDEX IF NOT EXISTS idx_batch_jobs_batch_id ON batch_jobs(batch_id)` },
  { name: 'idx_batch_jobs_status', sql: `CREATE INDEX IF NOT EXISTS idx_batch_jobs_status ON batch_jobs(status)` },
  { name: 'rls: batch_jobs', sql: `ALTER TABLE batch_jobs ENABLE ROW LEVEL SECURITY` },
  { name: 'policy: batch_jobs', sql: `CREATE POLICY IF NOT EXISTS "service_full" ON batch_jobs FOR ALL TO service_role USING (true)` },

  // ── Indexes ──
  { name: 'idx_chunks_set_id', sql: `CREATE INDEX IF NOT EXISTS idx_chunks_set_id ON chunks(set_id)` },
  { name: 'idx_topics_slug', sql: `CREATE INDEX IF NOT EXISTS idx_topics_slug ON topics(slug)` },
  { name: 'idx_bit_topics_bit_identity_id', sql: `CREATE INDEX IF NOT EXISTS idx_bit_topics_bit_identity_id ON bit_topics(bit_identity_id)` },
  { name: 'idx_bit_topics_topic_id', sql: `CREATE INDEX IF NOT EXISTS idx_bit_topics_topic_id ON bit_topics(topic_id)` },
  { name: 'idx_set_topics_set_id', sql: `CREATE INDEX IF NOT EXISTS idx_set_topics_set_id ON set_topics(set_id)` },
  { name: 'idx_set_topics_topic_id', sql: `CREATE INDEX IF NOT EXISTS idx_set_topics_topic_id ON set_topics(topic_id)` },
  { name: 'idx_bits_chunk_id', sql: `CREATE INDEX IF NOT EXISTS idx_bits_chunk_id ON bits(chunk_id)` },
  { name: 'idx_bit_identities_status', sql: `CREATE INDEX IF NOT EXISTS idx_bit_identities_status ON bit_identities(status)` },

  // ── RLS policies ──
  { name: 'rls: chunks', sql: `ALTER TABLE chunks ENABLE ROW LEVEL SECURITY` },
  { name: 'rls: topics', sql: `ALTER TABLE topics ENABLE ROW LEVEL SECURITY` },
  { name: 'rls: bit_topics', sql: `ALTER TABLE bit_topics ENABLE ROW LEVEL SECURITY` },
  { name: 'rls: set_topics', sql: `ALTER TABLE set_topics ENABLE ROW LEVEL SECURITY` },
  { name: 'rls: review_state', sql: `ALTER TABLE review_state ENABLE ROW LEVEL SECURITY` },
  { name: 'policy: chunks', sql: `CREATE POLICY IF NOT EXISTS "service_full" ON chunks FOR ALL TO service_role USING (true)` },
  { name: 'policy: topics', sql: `CREATE POLICY IF NOT EXISTS "service_full" ON topics FOR ALL TO service_role USING (true)` },
  { name: 'policy: bit_topics', sql: `CREATE POLICY IF NOT EXISTS "service_full" ON bit_topics FOR ALL TO service_role USING (true)` },
  { name: 'policy: set_topics', sql: `CREATE POLICY IF NOT EXISTS "service_full" ON set_topics FOR ALL TO service_role USING (true)` },
  { name: 'policy: review_state', sql: `CREATE POLICY IF NOT EXISTS "service_full" ON review_state FOR ALL TO service_role USING (true)` },
];

async function runMigrations() {
  const client = new Client({
    connectionString: DB_URL,
    ssl: { rejectUnauthorized: false }
  });

  console.log('\n🎤 Comediq Schema Migration\n');
  console.log('Connecting to Supabase...');

  try {
    await client.connect();
    console.log('✅ Connected\n');
  } catch (err) {
    console.error('❌ Connection failed:', err.message);
    console.error('\nMake sure your DB_URL is correct. Get it from:');
    console.error('Supabase Dashboard → Settings → Database → Connection string (URI)');
    process.exit(1);
  }

  let passed = 0;
  let failed = 0;

  for (const migration of migrations) {
    try {
      await client.query(migration.sql);
      console.log(`  ✅ ${migration.name}`);
      passed++;
    } catch (err) {
      // Some errors are fine (already exists, etc.)
      if (err.message.includes('already exists') || err.message.includes('IF NOT EXISTS')) {
        console.log(`  ⟳  ${migration.name} (already exists)`);
        passed++;
      } else {
        console.log(`  ❌ ${migration.name}: ${err.message}`);
        failed++;
      }
    }
  }

  await client.end();

  console.log(`\n─────────────────────────────`);
  console.log(`✅ ${passed} migrations applied`);
  if (failed > 0) console.log(`❌ ${failed} failed`);
  console.log(`\nDone. You can now record sets with the full post-set flow.\n`);
}

runMigrations();
