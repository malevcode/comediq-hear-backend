import { Hono } from 'hono'

export const reviewRoutes = new Hono()

const MILESTONES = [5, 25]
const MAX_REQUESTS_PER_YEAR = 3

// ── GET /review/status ────────────────────────────────────────────────────────
reviewRoutes.get('/status', async (c) => {
  const state = await c.env.DB.prepare("SELECT * FROM review_state WHERE id = 'singleton'").first()

  if (state?.review_completed) {
    return c.json({ eligible: false, reason: 'already_completed' })
  }

  // Count sets to check milestone
  const { results: countResult } = await c.env.DB.prepare(
    'SELECT COUNT(*) AS total FROM sets'
  ).all()
  const total = countResult[0]?.total ?? 0

  const hitMilestone =
    MILESTONES.includes(total) || (total > 25 && total % 50 === 0)

  if (!hitMilestone) {
    return c.json({ eligible: false, reason: 'no_milestone', sets_count: total })
  }

  // Rate limit: ≤ MAX_REQUESTS_PER_YEAR in the rolling calendar year
  const timestamps = safeJson(state?.request_timestamps, [])
  const yearAgo = new Date()
  yearAgo.setFullYear(yearAgo.getFullYear() - 1)
  const recentRequests = timestamps.filter((t) => new Date(t) > yearAgo)

  if (recentRequests.length >= MAX_REQUESTS_PER_YEAR) {
    return c.json({ eligible: false, reason: 'rate_limited' })
  }

  return c.json({ eligible: true, sets_count: total })
})

// ── POST /review/requested ────────────────────────────────────────────────────
reviewRoutes.post('/requested', async (c) => {
  const now = new Date().toISOString()

  const state = await c.env.DB.prepare("SELECT * FROM review_state WHERE id = 'singleton'").first()
  const timestamps = safeJson(state?.request_timestamps, [])
  timestamps.push(now)

  await c.env.DB.prepare(
    `INSERT INTO review_state (id, request_timestamps, created_at)
     VALUES ('singleton', ?, ?)
     ON CONFLICT(id) DO UPDATE SET request_timestamps = excluded.request_timestamps`
  )
    .bind(JSON.stringify(timestamps), now)
    .run()

  return c.json({ ok: true })
})

// ── POST /review/completed ────────────────────────────────────────────────────
reviewRoutes.post('/completed', async (c) => {
  const now = new Date().toISOString()

  await c.env.DB.prepare(
    `INSERT INTO review_state (id, review_completed, review_completed_at, created_at)
     VALUES ('singleton', 1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET review_completed = 1, review_completed_at = excluded.review_completed_at`
  )
    .bind(now, now)
    .run()

  return c.json({ ok: true })
})

function safeJson(val, fallback) {
  if (val == null) return fallback
  if (typeof val === 'object') return val
  try { return JSON.parse(val) } catch { return fallback }
}
