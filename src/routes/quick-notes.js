import { Hono } from 'hono'

export const quickNotesRoutes = new Hono()

// ── GET /quick-notes ──────────────────────────────────────────────────────────
quickNotesRoutes.get('/', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM quick_notes ORDER BY created_at DESC'
  ).all()

  return c.json(results.map(parseNote))
})

// ── POST /quick-notes ─────────────────────────────────────────────────────────
quickNotesRoutes.post('/', async (c) => {
  const { text, captured_during_set, set_id } = await c.req.json()
  if (!text) return c.json({ error: 'text is required' }, 400)

  const id = crypto.randomUUID()
  const now = new Date().toISOString()

  await c.env.DB.prepare(
    `INSERT INTO quick_notes (id, text, captured_during_set, set_id, processed, created_at)
     VALUES (?, ?, ?, ?, 0, ?)`
  )
    .bind(id, text, captured_during_set ? 1 : 0, set_id ?? null, now)
    .run()

  const row = await c.env.DB.prepare('SELECT * FROM quick_notes WHERE id = ?').bind(id).first()
  return c.json(parseNote(row), 201)
})

// ── PATCH /quick-notes/:id ────────────────────────────────────────────────────
quickNotesRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id')
  const { text, processed } = await c.req.json()

  const result = await c.env.DB.prepare(
    `UPDATE quick_notes
     SET text = COALESCE(?, text), processed = COALESCE(?, processed)
     WHERE id = ?`
  )
    .bind(text ?? null, processed != null ? (processed ? 1 : 0) : null, id)
    .run()

  if (!result.meta.changes) return c.json({ error: 'Note not found' }, 404)

  const row = await c.env.DB.prepare('SELECT * FROM quick_notes WHERE id = ?').bind(id).first()
  return c.json(parseNote(row))
})

// ── DELETE /quick-notes/:id ───────────────────────────────────────────────────
quickNotesRoutes.delete('/:id', async (c) => {
  const result = await c.env.DB.prepare('DELETE FROM quick_notes WHERE id = ?')
    .bind(c.req.param('id'))
    .run()

  if (!result.meta.changes) return c.json({ error: 'Note not found' }, 404)
  return c.json({ ok: true })
})

function parseNote(row) {
  return {
    ...row,
    captured_during_set: !!row.captured_during_set,
    processed: !!row.processed,
  }
}
