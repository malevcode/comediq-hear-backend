import { Hono } from 'hono'
import { recalcIdentityStats } from '../lib/identity.js'

export const identitiesRoutes = new Hono()

// ── GET /identities ───────────────────────────────────────────────────────────
identitiesRoutes.get('/', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM bit_identities ORDER BY total_performances DESC, created_at DESC`
  ).all()

  return c.json(results.map(parseIdentity))
})

// ── POST /identities ──────────────────────────────────────────────────────────
identitiesRoutes.post('/', async (c) => {
  const { name } = await c.req.json()
  if (!name) return c.json({ error: 'name is required' }, 400)

  const id = crypto.randomUUID()
  const slug = slugify(name)
  const now = new Date().toISOString()

  await c.env.DB.prepare(
    `INSERT INTO bit_identities (id, canonical_name, slug, status, first_seen_at, created_at)
     VALUES (?, ?, ?, 'premise', ?, ?)`
  )
    .bind(id, name, slug, now, now)
    .run()

  const row = await c.env.DB.prepare('SELECT * FROM bit_identities WHERE id = ?').bind(id).first()
  return c.json(parseIdentity(row), 201)
})

// ── GET /identities/:id/performances ──────────────────────────────────────────
identitiesRoutes.get('/:id/performances', async (c) => {
  const identityId = c.req.param('id')

  const { results } = await c.env.DB.prepare(
    `SELECT bp.*, s.venue AS set_venue
     FROM bit_performances bp
     LEFT JOIN sets s ON bp.set_id = s.id
     WHERE bp.bit_identity_id = ?
     ORDER BY bp.performance_date_iso DESC`
  )
    .bind(identityId)
    .all()

  return c.json(results)
})

// ── PATCH /identities/:id ─────────────────────────────────────────────────────
identitiesRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id')
  const { status, written_text, latest_confidence } = await c.req.json()

  const result = await c.env.DB.prepare(
    `UPDATE bit_identities SET status = COALESCE(?, status),
       written_text = COALESCE(?, written_text),
       latest_confidence = COALESCE(?, latest_confidence)
     WHERE id = ?`
  )
    .bind(status ?? null, written_text ?? null, latest_confidence ?? null, id)
    .run()

  if (!result.meta.changes) return c.json({ error: 'Identity not found' }, 404)

  const row = await c.env.DB.prepare('SELECT * FROM bit_identities WHERE id = ?').bind(id).first()
  return c.json(parseIdentity(row))
})

// ── POST /identities/:id/confidence ───────────────────────────────────────────
identitiesRoutes.post('/:id/confidence', async (c) => {
  const id = c.req.param('id')
  const { score, notes } = await c.req.json()

  if (score == null) return c.json({ error: 'score is required' }, 400)

  const row = await c.env.DB.prepare('SELECT confidence_history FROM bit_identities WHERE id = ?')
    .bind(id)
    .first()
  if (!row) return c.json({ error: 'Identity not found' }, 404)

  const history = safeJson(row.confidence_history, [])
  history.push({ score, notes: notes ?? null, recorded_at: new Date().toISOString() })

  await c.env.DB.prepare(
    `UPDATE bit_identities SET latest_confidence = ?, confidence_history = ? WHERE id = ?`
  )
    .bind(score, JSON.stringify(history), id)
    .run()

  return c.json({ ok: true })
})

// ── DELETE /identities/:id ────────────────────────────────────────────────────
identitiesRoutes.delete('/:id', async (c) => {
  const result = await c.env.DB.prepare('DELETE FROM bit_identities WHERE id = ?')
    .bind(c.req.param('id'))
    .run()

  if (!result.meta.changes) return c.json({ error: 'Identity not found' }, 404)
  return c.json({ ok: true })
})

// ── POST /identities/merge ────────────────────────────────────────────────────
// Merge sourceId into targetId. All references to source are re-pointed to target.
identitiesRoutes.post('/merge', async (c) => {
  const { sourceId, targetId } = await c.req.json()
  if (!sourceId || !targetId) return c.json({ error: 'sourceId and targetId are required' }, 400)
  if (sourceId === targetId) return c.json({ error: 'sourceId and targetId must differ' }, 400)

  const source = await c.env.DB.prepare('SELECT * FROM bit_identities WHERE id = ?')
    .bind(sourceId)
    .first()
  const target = await c.env.DB.prepare('SELECT * FROM bit_identities WHERE id = ?')
    .bind(targetId)
    .first()
  if (!source || !target) return c.json({ error: 'One or both identities not found' }, 404)

  // Re-point all references
  await c.env.DB.prepare('UPDATE bits SET bit_identity_id = ? WHERE bit_identity_id = ?')
    .bind(targetId, sourceId)
    .run()
  await c.env.DB.prepare(
    'UPDATE bit_performances SET bit_identity_id = ? WHERE bit_identity_id = ?'
  )
    .bind(targetId, sourceId)
    .run()
  // Merge bit_topics (ignore conflicts — target may already have the topic)
  await c.env.DB.prepare(
    `INSERT OR IGNORE INTO bit_topics (bit_identity_id, topic_id)
     SELECT ?, topic_id FROM bit_topics WHERE bit_identity_id = ?`
  )
    .bind(targetId, sourceId)
    .run()

  await c.env.DB.prepare('DELETE FROM bit_identities WHERE id = ?').bind(sourceId).run()
  await recalcIdentityStats(c.env.DB, targetId)

  const merged = await c.env.DB.prepare('SELECT * FROM bit_identities WHERE id = ?')
    .bind(targetId)
    .first()
  return c.json(parseIdentity(merged))
})

// ── Helpers ───────────────────────────────────────────────────────────────────
function parseIdentity(row) {
  if (!row) return null
  return {
    id: row.id,
    canonical_name: row.canonical_name,
    slug: row.slug,
    topic_tags: safeJson(row.topic_tags, []),
    total_performances: row.total_performances,
    avg_analysis_score: row.avg_analysis_score,
    avg_user_rating: row.avg_user_rating,
    avg_laugh_proxy: row.avg_laugh_proxy,
    best_score: row.best_score,
    first_seen_at: row.first_seen_at,
    last_performed_at: row.last_performed_at,
    status: row.status,
    written_text: row.written_text,
    latest_confidence: row.latest_confidence,
    confidence_history: safeJson(row.confidence_history, []),
    created_at: row.created_at,
  }
}

function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)
}

function safeJson(val, fallback) {
  if (val == null) return fallback
  if (typeof val === 'object') return val
  try { return JSON.parse(val) } catch { return fallback }
}
