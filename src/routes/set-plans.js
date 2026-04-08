import { Hono } from 'hono'

export const setPlansRoutes = new Hono()

// ── GET /set-plans ────────────────────────────────────────────────────────────
setPlansRoutes.get('/', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM set_plans ORDER BY created_at DESC'
  ).all()

  return c.json(results.map(parsePlan))
})

// ── POST /set-plans ───────────────────────────────────────────────────────────
setPlansRoutes.post('/', async (c) => {
  const { name, items } = await c.req.json()

  const id = crypto.randomUUID()
  const now = new Date().toISOString()

  await c.env.DB.prepare(
    'INSERT INTO set_plans (id, name, items, created_at) VALUES (?, ?, ?, ?)'
  )
    .bind(id, name ?? null, JSON.stringify(items ?? []), now)
    .run()

  const row = await c.env.DB.prepare('SELECT * FROM set_plans WHERE id = ?').bind(id).first()
  return c.json(parsePlan(row), 201)
})

// ── GET /set-plans/:id ────────────────────────────────────────────────────────
setPlansRoutes.get('/:id', async (c) => {
  const row = await c.env.DB.prepare('SELECT * FROM set_plans WHERE id = ?')
    .bind(c.req.param('id'))
    .first()

  if (!row) return c.json({ error: 'Set plan not found' }, 404)
  return c.json(parsePlan(row))
})

// ── PATCH /set-plans/:id ──────────────────────────────────────────────────────
setPlansRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id')
  const { name, items, used_in_set_id } = await c.req.json()

  const result = await c.env.DB.prepare(
    `UPDATE set_plans
     SET name = COALESCE(?, name),
         items = COALESCE(?, items),
         used_in_set_id = COALESCE(?, used_in_set_id)
     WHERE id = ?`
  )
    .bind(
      name ?? null,
      items != null ? JSON.stringify(items) : null,
      used_in_set_id ?? null,
      id
    )
    .run()

  if (!result.meta.changes) return c.json({ error: 'Set plan not found' }, 404)

  const row = await c.env.DB.prepare('SELECT * FROM set_plans WHERE id = ?').bind(id).first()
  return c.json(parsePlan(row))
})

function parsePlan(row) {
  return {
    id: row.id,
    name: row.name,
    items: safeJson(row.items, []),
    used_in_set_id: row.used_in_set_id,
    created_at: row.created_at,
  }
}

function safeJson(val, fallback) {
  if (val == null) return fallback
  if (typeof val === 'object') return val
  try { return JSON.parse(val) } catch { return fallback }
}
