import { Hono } from 'hono'
import { distanceMiles } from '../lib/utils.js'

export const openMicsRoutes = new Hono()

// ── GET /open-mics ────────────────────────────────────────────────────────────
// Filters: ?city=Nashville &state=TN &day=Monday &active=1
// Proximity: ?lat=36.16&lng=-86.78&radius=25 (miles, defaults to 25)
openMicsRoutes.get('/', async (c) => {
  const { city, state, day, active, lat, lng } = c.req.query()

  const conditions = []
  const values = []

  if (city) {
    conditions.push('LOWER(city) LIKE ?')
    values.push(`%${city.toLowerCase()}%`)
  }
  if (state) {
    conditions.push('UPPER(state) = ?')
    values.push(state.toUpperCase())
  }
  if (day) {
    conditions.push('LOWER(day_of_week) = ?')
    values.push(day.toLowerCase())
  }
  if (active !== undefined) {
    conditions.push('is_active = ?')
    values.push(active === '0' ? 0 : 1)
  } else {
    conditions.push('is_active = 1')
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : 'WHERE is_active = 1'
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM open_mics ${where} ORDER BY day_of_week, start_time`,
  )
    .bind(...values)
    .all()

  // If lat/lng provided, sort by proximity and filter by radius
  if (lat && lng) {
    const userLat = parseFloat(lat)
    const userLng = parseFloat(lng)
    const radius = parseFloat(c.req.query('radius') || '25')

    const withDistance = results
      .filter((m) => m.lat != null && m.lng != null)
      .map((m) => ({
        ...m,
        distance_miles: +distanceMiles(userLat, userLng, m.lat, m.lng).toFixed(1),
      }))
      .filter((m) => m.distance_miles <= radius)
      .sort((a, b) => a.distance_miles - b.distance_miles)

    // Append mics without coordinates at the end
    const noCoords = results.filter((m) => m.lat == null || m.lng == null)
    return c.json([...withDistance, ...noCoords])
  }

  return c.json(results)
})

// ── GET /open-mics/check-ins ──────────────────────────────────────────────────
// MUST be before /:id to avoid "check-ins" matching as an id param.
openMicsRoutes.get('/check-ins', async (c) => {
  const userId = c.req.query('user_id')
  const limit = Math.min(parseInt(c.req.query('limit') || '20', 10), 100)

  const where = userId ? 'WHERE mci.user_id = ?' : ''
  const values = userId ? [userId] : []

  const { results } = await c.env.DB.prepare(
    `SELECT mci.*, om.name AS mic_name, om.venue_name, om.city, om.day_of_week,
            s.overall_score AS set_score, s.date AS set_date
     FROM mic_check_ins mci
     LEFT JOIN open_mics om ON mci.open_mic_id = om.id
     LEFT JOIN sets s ON mci.performed_set_id = s.id
     ${where}
     ORDER BY mci.created_at DESC LIMIT ?`,
  )
    .bind(...values, limit)
    .all()

  return c.json(results)
})

// ── POST /open-mics ───────────────────────────────────────────────────────────
openMicsRoutes.post('/', async (c) => {
  const body = await c.req.json()
  const {
    name, venue_name, address, city, state, lat, lng,
    day_of_week, start_time, host, entry_fee, sign_up_type, notes,
  } = body

  if (!name?.trim()) return c.json({ error: 'name is required' }, 400)

  const id = crypto.randomUUID()
  const now = new Date().toISOString()

  await c.env.DB.prepare(
    `INSERT INTO open_mics (
       id, name, venue_name, address, city, state, lat, lng,
       day_of_week, start_time, host, entry_fee, sign_up_type, notes,
       is_active, last_verified_at, source, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'manual', ?)`,
  )
    .bind(
      id, name.trim(), venue_name ?? null, address ?? null,
      city ?? null, state ?? null, lat ?? null, lng ?? null,
      day_of_week ?? null, start_time ?? null, host ?? null,
      entry_fee ?? null, sign_up_type ?? null, notes ?? null,
      now, now,
    )
    .run()

  const row = await c.env.DB.prepare('SELECT * FROM open_mics WHERE id = ?').bind(id).first()
  return c.json(row, 201)
})

// ── GET /open-mics/:id ────────────────────────────────────────────────────────
openMicsRoutes.get('/:id', async (c) => {
  const id = c.req.param('id')
  const mic = await c.env.DB.prepare('SELECT * FROM open_mics WHERE id = ?').bind(id).first()
  if (!mic) return c.json({ error: 'Open mic not found' }, 404)

  const { results: checkIns } = await c.env.DB.prepare(
    `SELECT mci.*, s.overall_score AS set_score, s.date AS set_date
     FROM mic_check_ins mci
     LEFT JOIN sets s ON mci.performed_set_id = s.id
     WHERE mci.open_mic_id = ?
     ORDER BY mci.created_at DESC LIMIT 10`,
  )
    .bind(id)
    .all()

  return c.json({ ...mic, recent_check_ins: checkIns })
})

// ── PATCH /open-mics/:id ──────────────────────────────────────────────────────
openMicsRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json()

  const existing = await c.env.DB.prepare('SELECT id FROM open_mics WHERE id = ?').bind(id).first()
  if (!existing) return c.json({ error: 'Open mic not found' }, 404)

  const fields = [
    'name', 'venue_name', 'address', 'city', 'state', 'lat', 'lng',
    'day_of_week', 'start_time', 'host', 'entry_fee', 'sign_up_type', 'notes', 'is_active',
  ]

  const updates = []
  const values = []
  for (const field of fields) {
    if (body[field] !== undefined) {
      updates.push(`${field} = ?`)
      values.push(body[field])
    }
  }

  if (!updates.length) return c.json({ error: 'Nothing to update' }, 400)

  updates.push('last_verified_at = ?')
  values.push(new Date().toISOString())

  await c.env.DB.prepare(`UPDATE open_mics SET ${updates.join(', ')} WHERE id = ?`)
    .bind(...values, id)
    .run()

  const row = await c.env.DB.prepare('SELECT * FROM open_mics WHERE id = ?').bind(id).first()
  return c.json(row)
})

// ── POST /open-mics/:id/check-in ──────────────────────────────────────────────
// Log that the comedian performed at this mic (optionally linked to a set).
openMicsRoutes.post('/:id/check-in', async (c) => {
  const micId = c.req.param('id')
  const { performed_set_id, notes, user_id } = await c.req.json()

  const mic = await c.env.DB.prepare('SELECT id FROM open_mics WHERE id = ?').bind(micId).first()
  if (!mic) return c.json({ error: 'Open mic not found' }, 404)

  const id = crypto.randomUUID()
  const now = new Date().toISOString()

  await c.env.DB.prepare(
    `INSERT INTO mic_check_ins (id, user_id, open_mic_id, performed_set_id, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, user_id ?? null, micId, performed_set_id ?? null, notes ?? null, now)
    .run()

  await c.env.DB.prepare('UPDATE open_mics SET last_verified_at = ? WHERE id = ?')
    .bind(now, micId)
    .run()

  const row = await c.env.DB.prepare('SELECT * FROM mic_check_ins WHERE id = ?').bind(id).first()
  return c.json(row, 201)
})
