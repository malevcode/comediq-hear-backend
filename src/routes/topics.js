import { Hono } from 'hono'

export const topicsRoutes = new Hono()

// ── GET /topics ───────────────────────────────────────────────────────────────
topicsRoutes.get('/', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM topics ORDER BY avg_score DESC NULLS LAST, total_performances DESC'
  ).all()

  return c.json(results)
})

// ── GET /topics/:id ───────────────────────────────────────────────────────────
// Topic detail with all bit identities linked via bit_topics
topicsRoutes.get('/:id', async (c) => {
  const id = c.req.param('id')

  const topic = await c.env.DB.prepare('SELECT * FROM topics WHERE id = ?').bind(id).first()
  if (!topic) return c.json({ error: 'Topic not found' }, 404)

  const { results: identities } = await c.env.DB.prepare(
    `SELECT bi.*
     FROM bit_identities bi
     JOIN bit_topics bt ON bt.bit_identity_id = bi.id
     WHERE bt.topic_id = ?
     ORDER BY bi.total_performances DESC`
  )
    .bind(id)
    .all()

  return c.json({ ...topic, identities })
})

// ── PATCH /topics/:id ─────────────────────────────────────────────────────────
topicsRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id')
  const { name, description } = await c.req.json()

  const result = await c.env.DB.prepare(
    `UPDATE topics SET name = COALESCE(?, name), description = COALESCE(?, description)
     WHERE id = ?`
  )
    .bind(name ?? null, description ?? null, id)
    .run()

  if (!result.meta.changes) return c.json({ error: 'Topic not found' }, 404)

  const row = await c.env.DB.prepare('SELECT * FROM topics WHERE id = ?').bind(id).first()
  return c.json(row)
})

// ── DELETE /topics/:id ────────────────────────────────────────────────────────
topicsRoutes.delete('/:id', async (c) => {
  const result = await c.env.DB.prepare('DELETE FROM topics WHERE id = ?')
    .bind(c.req.param('id'))
    .run()

  if (!result.meta.changes) return c.json({ error: 'Topic not found' }, 404)
  return c.json({ ok: true })
})
