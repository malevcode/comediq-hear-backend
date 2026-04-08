import { Hono } from 'hono'

export const processRoutes = new Hono()

/**
 * POST /upload
 * Accepts a multipart form with an `audio` file field (+ optional `venue`, `duration`).
 * Stores the file in R2, creates a jobs row in D1, and kicks off the ProcessingJob DO.
 * Returns { jobId } immediately — client polls GET /jobs/:id for status.
 */
processRoutes.post('/upload', async (c) => {
  let formData
  try {
    formData = await c.req.formData()
  } catch {
    return c.json({ error: 'Expected multipart/form-data' }, 400)
  }

  const audio = formData.get('audio')
  if (!audio || !(audio instanceof File)) {
    return c.json({ error: 'audio file is required' }, 400)
  }

  const venue = (formData.get('venue') || '').toString().slice(0, 200)
  const duration = parseFloat(formData.get('duration') || '0') || 0

  const ext = (audio.name.split('.').pop() || 'webm').toLowerCase()
  const jobId = crypto.randomUUID()
  const r2Key = `audio/temp/${jobId}.${ext}`

  // Store audio in R2 (temporary — deleted after processing)
  const audioBuffer = await audio.arrayBuffer()
  await c.env.R2.put(r2Key, audioBuffer, {
    httpMetadata: { contentType: audio.type || 'audio/webm' },
  })

  // Create job record in D1
  await c.env.DB.prepare(
    `INSERT INTO jobs (id, status, r2_key, venue, created_at, updated_at)
     VALUES (?, 'pending', ?, ?, datetime('now'), datetime('now'))`
  )
    .bind(jobId, r2Key, venue)
    .run()

  // Kick off the Durable Object — its /start handler is fast (just writes state + sets alarm)
  const doId = c.env.PROCESSING_JOB.idFromName(jobId)
  const stub = c.env.PROCESSING_JOB.get(doId)

  await stub.fetch('https://internal.fake/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId, r2Key, venue, duration }),
  })

  return c.json({ jobId }, 202)
})

/**
 * GET /jobs/:id
 * Returns current processing status for a job.
 */
processRoutes.get('/jobs/:id', async (c) => {
  const id = c.req.param('id')
  const job = await c.env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(id).first()

  if (!job) return c.json({ error: 'Job not found' }, 404)

  return c.json({
    id: job.id,
    status: job.status,
    setId: job.set_id ?? null,
    error: job.error ?? null,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
  })
})
