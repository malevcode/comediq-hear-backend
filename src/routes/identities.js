import { Hono } from 'hono'
import { recalcIdentityStats } from '../lib/identity.js'
import { safeJson, slugify } from '../lib/utils.js'

export const identitiesRoutes = new Hono()

// ── GET /identities ───────────────────────────────────────────────────────────
// Supports ?status=premise,being_written,retired,shelved (comma-separated)
// and ?search=keyword (fuzzy name search via LIKE)
identitiesRoutes.get('/', async (c) => {
  const statusParam = c.req.query('status')
  const search = c.req.query('search')?.trim()
  const limit = Math.min(parseInt(c.req.query('limit') || '200', 10), 500)
  const offset = parseInt(c.req.query('offset') || '0', 10)

  const conditions = []
  const values = []

  if (statusParam) {
    const statuses = statusParam.split(',').map((s) => s.trim()).filter(Boolean)
    if (statuses.length) {
      conditions.push(`status IN (${statuses.map(() => '?').join(',')})`)
      values.push(...statuses)
    }
  }

  if (search) {
    conditions.push('canonical_name LIKE ?')
    values.push(`%${search}%`)
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  const { results } = await c.env.DB.prepare(
    `SELECT * FROM bit_identities ${where}
     ORDER BY total_performances DESC, created_at DESC
     LIMIT ? OFFSET ?`,
  )
    .bind(...values, limit, offset)
    .all()

  const countRow = await c.env.DB.prepare(
    `SELECT COUNT(*) AS total FROM bit_identities ${where}`,
  )
    .bind(...values)
    .first()

  return c.json({
    identities: results.map(parseIdentity),
    total: countRow?.total ?? 0,
    limit,
    offset,
  })
})

// ── POST /identities/merge ────────────────────────────────────────────────────
// MUST be registered before /:id routes to avoid "merge" being treated as an id.
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

  // Re-point all references from source → target
  await c.env.DB.prepare('UPDATE bits SET bit_identity_id = ? WHERE bit_identity_id = ?')
    .bind(targetId, sourceId)
    .run()
  await c.env.DB.prepare(
    'UPDATE bit_performances SET bit_identity_id = ? WHERE bit_identity_id = ?',
  )
    .bind(targetId, sourceId)
    .run()
  // Merge bit_topics (INSERT OR IGNORE to avoid PK conflicts)
  await c.env.DB.prepare(
    `INSERT OR IGNORE INTO bit_topics (bit_identity_id, topic_id)
     SELECT ?, topic_id FROM bit_topics WHERE bit_identity_id = ?`,
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

// ── POST /identities ──────────────────────────────────────────────────────────
identitiesRoutes.post('/', async (c) => {
  const { name } = await c.req.json()
  if (!name?.trim()) return c.json({ error: 'name is required' }, 400)

  const id = crypto.randomUUID()
  const now = new Date().toISOString()

  await c.env.DB.prepare(
    `INSERT INTO bit_identities (id, canonical_name, slug, status, first_seen_at, created_at)
     VALUES (?, ?, ?, 'premise', ?, ?)`,
  )
    .bind(id, name.trim(), slugify(name.trim()), now, now)
    .run()

  const row = await c.env.DB.prepare('SELECT * FROM bit_identities WHERE id = ?').bind(id).first()
  return c.json(parseIdentity(row), 201)
})

// ── GET /identities/:id ───────────────────────────────────────────────────────
identitiesRoutes.get('/:id', async (c) => {
  const row = await c.env.DB.prepare('SELECT * FROM bit_identities WHERE id = ?')
    .bind(c.req.param('id'))
    .first()

  if (!row) return c.json({ error: 'Identity not found' }, 404)
  return c.json(parseIdentity(row))
})

// ── GET /identities/:id/performances ──────────────────────────────────────────
identitiesRoutes.get('/:id/performances', async (c) => {
  const identityId = c.req.param('id')

  const identity = await c.env.DB.prepare('SELECT * FROM bit_identities WHERE id = ?')
    .bind(identityId)
    .first()
  if (!identity) return c.json({ error: 'Identity not found' }, 404)

  const { results } = await c.env.DB.prepare(
    `SELECT bp.*, s.venue AS set_venue, s.date AS set_date, s.overall_score AS set_score,
            b.name AS bit_name, b.score AS bit_score, b.feedback, b.likely_laughed,
            b.user_rating, b.personal_notes
     FROM bit_performances bp
     LEFT JOIN sets s ON bp.set_id = s.id
     LEFT JOIN bits b ON bp.bit_id = b.id
     WHERE bp.bit_identity_id = ?
     ORDER BY bp.performance_date_iso DESC`,
  )
    .bind(identityId)
    .all()

  return c.json({ identity: parseIdentity(identity), performances: results })
})

// ── PATCH /identities/:id ─────────────────────────────────────────────────────
identitiesRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id')
  const { name, status, written_text, latest_confidence } = await c.req.json()

  const existing = await c.env.DB.prepare('SELECT * FROM bit_identities WHERE id = ?')
    .bind(id)
    .first()
  if (!existing) return c.json({ error: 'Identity not found' }, 404)

  // If renaming, update the slug too
  const newSlug = name ? slugify(name.trim()) : null

  await c.env.DB.prepare(
    `UPDATE bit_identities SET
       canonical_name   = COALESCE(?, canonical_name),
       slug             = COALESCE(?, slug),
       status           = COALESCE(?, status),
       written_text     = COALESCE(?, written_text),
       latest_confidence = COALESCE(?, latest_confidence)
     WHERE id = ?`,
  )
    .bind(
      name?.trim() ?? null,
      newSlug,
      status ?? null,
      written_text ?? null,
      latest_confidence ?? null,
      id,
    )
    .run()

  const row = await c.env.DB.prepare('SELECT * FROM bit_identities WHERE id = ?').bind(id).first()
  return c.json(parseIdentity(row))
})

// ── POST /identities/:id/confidence ───────────────────────────────────────────
identitiesRoutes.post('/:id/confidence', async (c) => {
  const id = c.req.param('id')
  const { score, notes } = await c.req.json()

  if (score == null) return c.json({ error: 'score is required' }, 400)
  if (score < 0 || score > 10) return c.json({ error: 'score must be 0-10' }, 400)

  const row = await c.env.DB.prepare('SELECT confidence_history FROM bit_identities WHERE id = ?')
    .bind(id)
    .first()
  if (!row) return c.json({ error: 'Identity not found' }, 404)

  const history = safeJson(row.confidence_history, [])
  history.push({ score, notes: notes ?? null, recorded_at: new Date().toISOString() })

  await c.env.DB.prepare(
    `UPDATE bit_identities SET latest_confidence = ?, confidence_history = ? WHERE id = ?`,
  )
    .bind(score, JSON.stringify(history), id)
    .run()

  return c.json({ ok: true, latest_confidence: score })
})

// ── DELETE /identities/:id ────────────────────────────────────────────────────
identitiesRoutes.delete('/:id', async (c) => {
  const result = await c.env.DB.prepare('DELETE FROM bit_identities WHERE id = ?')
    .bind(c.req.param('id'))
    .run()

  if (!result.meta.changes) return c.json({ error: 'Identity not found' }, 404)
  return c.json({ ok: true })
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
