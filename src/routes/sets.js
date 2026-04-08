import { Hono } from 'hono'

export const setsRoutes = new Hono()

// ── GET /sets ─────────────────────────────────────────────────────────────────
setsRoutes.get('/', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, venue, date, date_iso, duration_sec, audio_url, overall_score,
            overall_summary, strongest_bit, audience_reception, topic_summary,
            total_laugh_count, set_topics, confidence_rating, created_at
     FROM sets ORDER BY created_at DESC`
  ).all()

  return c.json(results.map(parseSet))
})

// ── GET /sets/:id ─────────────────────────────────────────────────────────────
setsRoutes.get('/:id', async (c) => {
  const set = await c.env.DB.prepare('SELECT * FROM sets WHERE id = ?')
    .bind(c.req.param('id'))
    .first()

  if (!set) return c.json({ error: 'Set not found' }, 404)
  return c.json(parseSet(set, true))
})

// ── GET /sets/:id/bits ────────────────────────────────────────────────────────
setsRoutes.get('/:id/bits', async (c) => {
  const setId = c.req.param('id')

  const { results: bits } = await c.env.DB.prepare(
    `SELECT b.*, bi.canonical_name, bi.slug, bi.status, bi.total_performances,
            bi.avg_analysis_score, bi.avg_user_rating, bi.avg_laugh_proxy, bi.best_score
     FROM bits b
     LEFT JOIN bit_identities bi ON b.bit_identity_id = bi.id
     WHERE b.set_id = ?
     ORDER BY b.timestamp_sec ASC`
  )
    .bind(setId)
    .all()

  return c.json(bits.map(parseBit))
})

// ── GET /sets/:id/chunks ──────────────────────────────────────────────────────
setsRoutes.get('/:id/chunks', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM chunks WHERE set_id = ? ORDER BY position_order ASC`
  )
    .bind(c.req.param('id'))
    .all()

  return c.json(results.map(parseChunk))
})

// ── GET /sets/:id/full ────────────────────────────────────────────────────────
// Full nested response: set → chunks → bits (with identity data)
setsRoutes.get('/:id/full', async (c) => {
  const setId = c.req.param('id')

  const set = await c.env.DB.prepare('SELECT * FROM sets WHERE id = ?').bind(setId).first()
  if (!set) return c.json({ error: 'Set not found' }, 404)

  const { results: chunks } = await c.env.DB.prepare(
    'SELECT * FROM chunks WHERE set_id = ? ORDER BY position_order ASC'
  )
    .bind(setId)
    .all()

  const { results: bits } = await c.env.DB.prepare(
    `SELECT b.*, bi.canonical_name, bi.slug, bi.status, bi.total_performances,
            bi.avg_analysis_score, bi.avg_user_rating, bi.avg_laugh_proxy, bi.best_score
     FROM bits b
     LEFT JOIN bit_identities bi ON b.bit_identity_id = bi.id
     WHERE b.set_id = ?
     ORDER BY b.timestamp_sec ASC`
  )
    .bind(setId)
    .all()

  const bitsByChunk = {}
  for (const bit of bits) {
    const key = bit.chunk_id ?? '__none__'
    if (!bitsByChunk[key]) bitsByChunk[key] = []
    bitsByChunk[key].push(parseBit(bit))
  }

  const fullChunks = chunks.map((ch) => ({
    ...parseChunk(ch),
    bits: bitsByChunk[ch.id] || [],
  }))

  const laughStats = {
    total: bits.filter((b) => b.likely_laughed).length,
    laughsPerMinute: set.duration_sec
      ? +((bits.filter((b) => b.likely_laughed).length / (set.duration_sec / 60)).toFixed(2))
      : null,
  }

  return c.json({ ...parseSet(set, true), chunks: fullChunks, laughStats })
})

// ── POST /sets/:id/context ────────────────────────────────────────────────────
setsRoutes.post('/:id/context', async (c) => {
  const setId = c.req.param('id')
  const { venue, crowd_size, crowd_type, notes } = await c.req.json()

  const existing = await c.env.DB.prepare('SELECT context FROM sets WHERE id = ?')
    .bind(setId)
    .first()
  if (!existing) return c.json({ error: 'Set not found' }, 404)

  const context = { ...safeJson(existing.context, {}), venue, crowd_size, crowd_type, notes }

  await c.env.DB.prepare('UPDATE sets SET context = ? WHERE id = ?')
    .bind(JSON.stringify(context), setId)
    .run()

  return c.json({ ok: true })
})

// ── PATCH /sets/:id/log ───────────────────────────────────────────────────────
setsRoutes.patch('/:id/log', async (c) => {
  const setId = c.req.param('id')
  const { confidence_rating, personal_notes, audience_reception } = await c.req.json()

  const result = await c.env.DB.prepare(
    `UPDATE sets SET confidence_rating = ?, personal_notes = ?, audience_reception = ?
     WHERE id = ?`
  )
    .bind(confidence_rating ?? null, personal_notes ?? null, audience_reception ?? null, setId)
    .run()

  if (!result.meta.changes) return c.json({ error: 'Set not found' }, 404)
  return c.json({ ok: true })
})

// ── DELETE /sets/:id ──────────────────────────────────────────────────────────
setsRoutes.delete('/:id', async (c) => {
  const result = await c.env.DB.prepare('DELETE FROM sets WHERE id = ?')
    .bind(c.req.param('id'))
    .run()

  if (!result.meta.changes) return c.json({ error: 'Set not found' }, 404)
  return c.json({ ok: true })
})

// ── Helpers ───────────────────────────────────────────────────────────────────
function parseSet(row, full = false) {
  const out = {
    id: row.id,
    venue: row.venue,
    date: row.date,
    date_iso: row.date_iso,
    duration_sec: row.duration_sec,
    audio_url: row.audio_url,
    overall_score: row.overall_score,
    overall_summary: row.overall_summary,
    strongest_bit: row.strongest_bit,
    audience_reception: row.audience_reception,
    topic_summary: row.topic_summary,
    total_laugh_count: row.total_laugh_count,
    set_topics: safeJson(row.set_topics, []),
    confidence_rating: row.confidence_rating,
    created_at: row.created_at,
  }
  if (full) {
    out.transcript = row.transcript
    out.pause_points = safeJson(row.pause_points, [])
    out.laugh_data = safeJson(row.laugh_data, {})
    out.context = safeJson(row.context, {})
    out.personal_notes = row.personal_notes
  }
  return out
}

function parseChunk(row) {
  return {
    id: row.id,
    set_id: row.set_id,
    name: row.name,
    position_order: row.position_order,
    start_sec: row.start_sec,
    end_sec: row.end_sec,
    overall_score: row.overall_score,
    laugh_count: row.laugh_count,
    bit_count: row.bit_count,
    topics: safeJson(row.topics, []),
    created_at: row.created_at,
  }
}

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
    // Identity fields (joined)
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
  try {
    return JSON.parse(val)
  } catch {
    return fallback
  }
}
