import { Hono } from 'hono'

export const chunksRoutes = new Hono()

// ── GET /chunks/:id ───────────────────────────────────────────────────────────
// Returns a single chunk with its bits (and identity data joined in)
chunksRoutes.get('/:id', async (c) => {
  const id = c.req.param('id')

  const chunk = await c.env.DB.prepare('SELECT * FROM chunks WHERE id = ?').bind(id).first()
  if (!chunk) return c.json({ error: 'Chunk not found' }, 404)

  const { results: bits } = await c.env.DB.prepare(
    `SELECT b.*, bi.canonical_name, bi.slug, bi.status, bi.total_performances,
            bi.avg_analysis_score, bi.avg_user_rating, bi.avg_laugh_proxy, bi.best_score
     FROM bits b
     LEFT JOIN bit_identities bi ON b.bit_identity_id = bi.id
     WHERE b.chunk_id = ?
     ORDER BY b.timestamp_sec ASC`
  )
    .bind(id)
    .all()

  return c.json({
    id: chunk.id,
    set_id: chunk.set_id,
    name: chunk.name,
    position_order: chunk.position_order,
    start_sec: chunk.start_sec,
    end_sec: chunk.end_sec,
    overall_score: chunk.overall_score,
    laugh_count: chunk.laugh_count,
    bit_count: chunk.bit_count,
    topics: safeJson(chunk.topics, []),
    created_at: chunk.created_at,
    bits: bits.map(parseBit),
  })
})

function parseBit(row) {
  return {
    id: row.id,
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
    personal_notes: row.personal_notes,
    bit_identity_id: row.bit_identity_id,
    canonical_name: row.canonical_name,
    identity_slug: row.slug,
    identity_status: row.status,
    total_performances: row.total_performances,
    avg_analysis_score: row.avg_analysis_score,
    avg_user_rating: row.avg_user_rating,
    avg_laugh_proxy: row.avg_laugh_proxy,
    best_score: row.best_score,
  }
}

function safeJson(val, fallback) {
  if (val == null) return fallback
  if (typeof val === 'object') return val
  try { return JSON.parse(val) } catch { return fallback }
}
