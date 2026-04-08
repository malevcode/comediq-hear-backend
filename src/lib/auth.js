/**
 * Auth helpers for Comediq Cloudflare Workers API.
 * Uses opaque session tokens (UUID) stored in D1 — no external JWT library.
 * Tokens are issued after Google OAuth and sent as: Authorization: Bearer <token>
 */

/**
 * Hono middleware that requires a valid session.
 * On success, sets c.get('user') = { id, email, name, role }
 * On failure, returns 401 JSON.
 */
export async function requireAuth(c, next) {
  const header = c.req.header('Authorization')
  if (!header?.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  const token = header.slice(7).trim()
  if (!token) return c.json({ error: 'Unauthorized' }, 401)

  const row = await c.env.DB.prepare(
    `SELECT s.user_id, u.email, u.name, u.role
     FROM sessions s
     JOIN users u ON s.user_id = u.id
     WHERE s.token = ? AND s.expires_at > ?`
  ).bind(token, new Date().toISOString()).first()

  if (!row) return c.json({ error: 'Unauthorized' }, 401)

  c.set('user', { id: row.user_id, email: row.email, name: row.name, role: row.role })
  await next()
}

/**
 * Creates a session row in D1 for the given user and returns the opaque token.
 * Sessions expire after 30 days.
 */
export async function createSession(db, userId) {
  const token = crypto.randomUUID()
  const now = new Date()
  const expires = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000) // 30 days

  await db.prepare(
    'INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ).bind(token, userId, now.toISOString(), expires.toISOString()).run()

  return token
}
