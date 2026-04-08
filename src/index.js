import { Hono } from 'hono'
import { cors } from 'hono/cors'

import { processRoutes } from './routes/process.js'
import { setsRoutes } from './routes/sets.js'
import { bitsRoutes } from './routes/bits.js'
import { identitiesRoutes } from './routes/identities.js'
import { chunksRoutes } from './routes/chunks.js'
import { topicsRoutes } from './routes/topics.js'
import { quickNotesRoutes } from './routes/quick-notes.js'
import { setPlansRoutes } from './routes/set-plans.js'
import { reviewRoutes } from './routes/review.js'
import { authRoutes } from './routes/auth.js'

// Re-export the Durable Object class so Cloudflare can find it
export { ProcessingJob } from './durable-objects/ProcessingJob.js'

const app = new Hono()

app.use('*', cors())

// ── Routes ────────────────────────────────────────────────────────────────────
app.route('/auth', authRoutes)
app.route('/sets', setsRoutes)
app.route('/bits', bitsRoutes)
app.route('/identities', identitiesRoutes)
app.route('/chunks', chunksRoutes)
app.route('/topics', topicsRoutes)
app.route('/quick-notes', quickNotesRoutes)
app.route('/set-plans', setPlansRoutes)
app.route('/review', reviewRoutes)
app.route('/', processRoutes)   // /upload and /jobs/:id

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (c) => c.json({ ok: true, service: 'comediq-hear', runtime: 'cloudflare-workers' }))

app.notFound((c) => c.json({ error: 'Not found' }, 404))
app.onError((err, c) => {
  console.error('[worker error]', err)
  return c.json({ error: err.message }, 500)
})

export default app
