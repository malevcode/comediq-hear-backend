import { Hono } from 'hono'

export const bitsRoutes = new Hono()

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

  // Sync rating to the bit_performance row for this bit
  await c.env.DB.prepare('UPDATE bit_performances SET user_rating = ? WHERE bit_id = ?')
    .bind(rating, id)
    .run()

  // Recalc identity stats so avg_user_rating stays fresh
  const bit = await c.env.DB.prepare('SELECT bit_identity_id FROM bits WHERE id = ?').bind(id).first()
  if (bit?.bit_identity_id) {
    const { results } = await c.env.DB.prepare(
      'SELECT user_rating FROM bit_performances WHERE bit_identity_id = ?'
    )
      .bind(bit.bit_identity_id)
      .all()

    const ratings = results.map((r) => r.user_rating).filter((v) => v != null)
    const avg = ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : null

    await c.env.DB.prepare('UPDATE bit_identities SET avg_user_rating = ? WHERE id = ?')
      .bind(avg, bit.bit_identity_id)
      .run()
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
// All performances of the same joke, via bit_identity_id
bitsRoutes.get('/:id/history', async (c) => {
  const id = c.req.param('id')

  const bit = await c.env.DB.prepare('SELECT bit_identity_id FROM bits WHERE id = ?').bind(id).first()
  if (!bit) return c.json({ error: 'Bit not found' }, 404)
  if (!bit.bit_identity_id) return c.json([])

  const { results } = await c.env.DB.prepare(
    `SELECT bp.*, s.venue AS set_venue, s.date AS set_date
     FROM bit_performances bp
     LEFT JOIN sets s ON bp.set_id = s.id
     WHERE bp.bit_identity_id = ?
     ORDER BY bp.performance_date_iso DESC`
  )
    .bind(bit.bit_identity_id)
    .all()

  return c.json(results)
})
