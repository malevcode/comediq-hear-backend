import { Hono } from 'hono'
import { findOrCreateTopic, recalcTopicStats } from '../lib/topics.js'
import { slugify } from '../lib/utils.js'

export const topicsRoutes = new Hono()

// ── GET /topics ───────────────────────────────────────────────────────────────
topicsRoutes.get('/', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM topics ORDER BY avg_score DESC NULLS LAST, total_performances DESC',
  ).all()

  return c.json(results)
})

// ── POST /topics ──────────────────────────────────────────────────────────────
topicsRoutes.post('/', async (c) => {
  const { name, description } = await c.req.json()
  if (!name?.trim()) return c.json({ error: 'name is required' }, 400)

  // findOrCreateTopic handles fuzzy dedup automatically
  const id = await findOrCreateTopic(c.env.DB, name.trim())

  if (description) {
    await c.env.DB.prepare('UPDATE topics SET description = ? WHERE id = ?')
      .bind(description, id)
      .run()
  }

  const row = await c.env.DB.prepare('SELECT * FROM topics WHERE id = ?').bind(id).first()
  return c.json(row, 201)
})

// ── GET /topics/:id ───────────────────────────────────────────────────────────
topicsRoutes.get('/:id', async (c) => {
  const id = c.req.param('id')

  const topic = await c.env.DB.prepare('SELECT * FROM topics WHERE id = ?').bind(id).first()
  if (!topic) return c.json({ error: 'Topic not found' }, 404)

  const { results: identities } = await c.env.DB.prepare(
    `SELECT bi.*
     FROM bit_identities bi
     JOIN bit_topics bt ON bt.bit_identity_id = bi.id
     WHERE bt.topic_id = ?
     ORDER BY bi.avg_analysis_score DESC NULLS LAST, bi.total_performances DESC`,
  )
    .bind(id)
    .all()

  return c.json({ ...topic, identities })
})

// ── PATCH /topics/:id ─────────────────────────────────────────────────────────
topicsRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id')
  const { name, description } = await c.req.json()

  const existing = await c.env.DB.prepare('SELECT * FROM topics WHERE id = ?').bind(id).first()
  if (!existing) return c.json({ error: 'Topic not found' }, 404)

  const newSlug = name ? slugify(name.trim()) : null

  await c.env.DB.prepare(
    `UPDATE topics SET
       name        = COALESCE(?, name),
       slug        = COALESCE(?, slug),
       description = COALESCE(?, description)
     WHERE id = ?`,
  )
    .bind(name?.trim() ?? null, newSlug, description ?? null, id)
    .run()

  await recalcTopicStats(c.env.DB, id)

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
