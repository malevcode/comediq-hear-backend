import { Hono } from 'hono'
import { requireAuth, createSession } from '../lib/auth.js'

export const authRoutes = new Hono()

// ── GET /auth/google ───────────────────────────────────────────────────────────
// Redirects the browser to Google's OAuth consent screen.
// The client should navigate to this URL (not fetch it).
authRoutes.get('/google', (c) => {
  const clientId = c.env.GOOGLE_CLIENT_ID
  if (!clientId) return c.json({ error: 'Google OAuth not configured' }, 500)

  const redirectUri = `${new URL(c.req.url).origin}/auth/google/callback`
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'online',
    prompt: 'select_account',
  })

  return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`)
})

// ── GET /auth/google/callback ─────────────────────────────────────────────────
// Called by Google after the user consents. Exchanges the code for a token,
// upserts the user in D1, creates a session, and redirects to the frontend.
authRoutes.get('/google/callback', async (c) => {
  const code = c.req.query('code')
  const error = c.req.query('error')

  if (error || !code) {
    const frontendUrl = c.env.FRONTEND_URL || 'http://localhost:8081'
    return c.redirect(`${frontendUrl}?auth_error=${encodeURIComponent(error || 'no_code')}`)
  }

  const redirectUri = `${new URL(c.req.url).origin}/auth/google/callback`

  // 1. Exchange authorization code for tokens
  let googleTokens
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: c.env.GOOGLE_CLIENT_ID,
        client_secret: c.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    })
    googleTokens = await tokenRes.json()
    if (!googleTokens.access_token) throw new Error(googleTokens.error || 'no access_token')
  } catch (err) {
    console.error('[auth] token exchange failed', err)
    return c.json({ error: 'Google token exchange failed' }, 502)
  }

  // 2. Fetch user profile from Google
  let profile
  try {
    const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${googleTokens.access_token}` },
    })
    profile = await profileRes.json()
    if (!profile.email) throw new Error('no email in profile')
  } catch (err) {
    console.error('[auth] profile fetch failed', err)
    return c.json({ error: 'Failed to fetch Google profile' }, 502)
  }

  const db = c.env.DB
  const now = new Date().toISOString()
  let userId

  // 3. Upsert user — look up by google_sub first, then email (Supabase migration path)
  const existingBySub = await db.prepare(
    'SELECT id FROM users WHERE google_sub = ?'
  ).bind(profile.sub).first()

  if (existingBySub) {
    userId = existingBySub.id
    // Refresh name in case it changed
    await db.prepare('UPDATE users SET name = ? WHERE id = ?')
      .bind(profile.name || null, userId).run()
  } else {
    const existingByEmail = await db.prepare(
      'SELECT id, google_sub FROM users WHERE email = ?'
    ).bind(profile.email).first()

    if (existingByEmail) {
      // Existing Supabase account — silently link google_sub
      userId = existingByEmail.id
      await db.prepare('UPDATE users SET google_sub = ?, name = ? WHERE id = ?')
        .bind(profile.sub, profile.name || null, userId).run()
    } else {
      // Brand new user
      userId = crypto.randomUUID()
      await db.prepare(
        `INSERT INTO users (id, created_at, email, name, google_sub, role)
         VALUES (?, ?, ?, ?, ?, 'comedian')`
      ).bind(userId, now, profile.email, profile.name || null, profile.sub).run()
    }
  }

  // 4. Create session and redirect to frontend with token
  const token = await createSession(db, userId)
  const frontendUrl = c.env.FRONTEND_URL || 'http://localhost:8081'
  return c.redirect(`${frontendUrl}?token=${token}`)
})

// ── GET /auth/me ───────────────────────────────────────────────────────────────
// Returns the current authenticated user.
authRoutes.get('/me', requireAuth, (c) => {
  return c.json(c.get('user'))
})

// ── DELETE /auth/session ───────────────────────────────────────────────────────
// Signs out by deleting the session row.
authRoutes.delete('/session', requireAuth, async (c) => {
  const token = c.req.header('Authorization').slice(7).trim()
  await c.env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run()
  return c.json({ ok: true })
})
