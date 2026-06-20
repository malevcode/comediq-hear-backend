import { Hono } from 'hono'
import { recalcIdentityStats } from '../lib/identity.js'
import { safeJson } from '../lib/utils.js'

export const bitsRoutes = new Hono()

// ── GET /bits/:id ─────────────────────────────────────────────────────────────
bitsRoutes.get('/:id', async (c) => {
  const id = c.req.param('id')

  const bit = await c.env.DB.prepare(
    `SELECT b.*, bi.canonical_name, bi.slug, bi.status AS identity_status,
            bi.total_performances, bi.avg_analysis_score, bi.avg_user_rating,
            bi.avg_laugh_proxy, bi.best_score
     FROM bits b
     LEFT JOIN bit_identities bi ON b.bit_identity_id = bi.id
     WHERE b.id = ?`,
  )
    .bind(id)
    .first()

  if (!bit) return c.json({ error: 'Bit not found' }, 404)
  return c.json(parseBit(bit))
})

// ── PATCH /bits/:id ───────────────────────────────────────────────────────────
// Combined update: rating, notes, or both in one call.
bitsRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json()
  const { rating, personal_notes } = body

  if (rating != null && (rating < 1 || rating > 10)) {
    return c.json({ error: 'rating must be between 1 and 10' }, 400)
  }

  const bit = await c.env.DB.prepare('SELECT * FROM bits WHERE id = ?').bind(id).first()
  if (!bit) return c.json({ error: 'Bit not found' }, 404)

  const updates = []
  const values = []

  if (rating != null) {
    updates.push('user_rating = ?')
    values.push(rating)
  }
  if (personal_notes !== undefined) {
    updates.push('personal_notes = ?')
    values.push(personal_notes ?? null)
  }

  if (updates.length === 0) return c.json({ error: 'Nothing to update' }, 400)

  await c.env.DB.prepare(`UPDATE bits SET ${updates.join(', ')} WHERE id = ?`)
    .bind(...values, id)
    .run()

  if (rating != null) {
    await c.env.DB.prepare('UPDATE bit_performances SET user_rating = ? WHERE bit_id = ?')
      .bind(rating, id)
      .run()

    if (bit.bit_identity_id) {
      await recalcIdentityStats(c.env.DB, bit.bit_identity_id)
    }
  }

  const updated = await c.env.DB.prepare(
    `SELECT b.*, bi.canonical_name, bi.slug, bi.status AS identity_status,
            bi.total_performances, bi.avg_analysis_score, bi.avg_user_rating,
            bi.avg_laugh_proxy, bi.best_score
     FROM bits b
     LEFT JOIN bit_identities bi ON b.bit_identity_id = bi.id
     WHERE b.id = ?`,
  )
    .bind(id)
    .first()

  return c.json(parseBit(updated))
})

// ── PATCH /bits/:id/rating ────────────────────────────────────────────────────
bitsRoutes.patch('/:id/rating', async (c) => {
  const id = c.req.param('id')
  const { rating } = await c.req.json()

  if (rating == null || rating < 1 || rating > 10) {
    return c.json({ error: 'rating must be between 1 and 10' }, 400)
  }

  const result = await c.env.DB.prepare('UPDATE bits SET user_rating = ? WHERE id = ?')
    .bind(rating, id)
    .run()

  if (!result.meta.changes) return c.json({ error: 'Bit not found' }, 404)

  await c.env.DB.prepare('UPDATE bit_performances SET user_rating = ? WHERE bit_id = ?')
    .bind(rating, id)
    .run()

  const bit = await c.env.DB.prepare('SELECT bit_identity_id FROM bits WHERE id = ?').bind(id).first()
  if (bit?.bit_identity_id) {
    await recalcIdentityStats(c.env.DB, bit.bit_identity_id)
  }

  return c.json({ ok: true })
})

// ── PATCH /bits/:id/notes ─────────────────────────────────────────────────────
bitsRoutes.patch('/:id/notes', async (c) => {
  const id = c.req.param('id')
  const { personal_notes } = await c.req.json()

  const result = await c.env.DB.prepare('UPDATE bits SET personal_notes = ? WHERE id = ?')
    .bind(personal_notes ?? null, id)
    .run()

  if (!result.meta.changes) return c.json({ error: 'Bit not found' }, 404)
  return c.json({ ok: true })
})

// ── GET /bits/:id/history ─────────────────────────────────────────────────────
bitsRoutes.get('/:id/history', async (c) => {
  const id = c.req.param('id')

  const bit = await c.env.DB.prepare('SELECT bit_identity_id FROM bits WHERE id = ?').bind(id).first()
  if (!bit) return c.json({ error: 'Bit not found' }, 404)
  if (!bit.bit_identity_id) return c.json([])

  const { results } = await c.env.DB.prepare(
    `SELECT bp.*, s.venue AS set_venue, s.date AS set_date, s.overall_score AS set_score
     FROM bit_performances bp
     LEFT JOIN sets s ON bp.set_id = s.id
     WHERE bp.bit_identity_id = ?
     ORDER BY bp.performance_date_iso DESC`,
  )
    .bind(bit.bit_identity_id)
    .all()

  return c.json(results)
})

// ── Helpers ───────────────────────────────────────────────────────────────────
function parseBit(row) {
  return {
    id: row.id,
    set_id: row.set_id,
    bit_identity_id: row.bit_identity_id,
    chunk_id: row.chunk_id,
    name: row.name,
    score: row.score,
    setup: row.setup,
    punchline: row.punchline,
    feedback: row.feedback,
    tags: safeJson(row.tags, []),
    positives: safeJson(row.positives, []),
    improvements: safeJson(row.improvements, []),
    likely_laughed: !!row.likely_laughed,
    timestamp_sec: row.timestamp_sec,
    pause_duration_ms: row.pause_duration_ms,
    user_rating: row.user_rating,
    chunk_name: row.chunk_name,
    personal_notes: row.personal_notes,
    created_at: row.created_at,
    // Identity fields (joined)
    canonical_name: row.canonical_name,
    identity_slug: row.slug,
    identity_status: row.identity_status,
    total_performances: row.total_performances,
    avg_analysis_score: row.avg_analysis_score,
    avg_user_rating: row.avg_user_rating,
    avg_laugh_proxy: row.avg_laugh_proxy,
    best_score: row.best_score,
  }
}
