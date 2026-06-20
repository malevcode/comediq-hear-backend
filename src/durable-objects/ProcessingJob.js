import { uploadAudio, requestTranscript, checkTranscript, detectPauses } from '../lib/assemblyai.js'
import { analyzeSet } from '../lib/claude.js'
import { saveAnalysis } from '../lib/save-set.js'

/**
 * ProcessingJob Durable Object
 *
 * Coordinates the full upload → transcription → analysis → save pipeline
 * for a single recording. Uses DO alarms so the job survives beyond a
 * single request's lifetime.
 *
 * State machine:
 *   pending → transcribing → analyzing → saving → done
 *                                                ↘ error (any stage)
 *
 * Alarm schedule:
 *   1. On POST /start  → alarm fires in 1 s  (uploads to AssemblyAI)
 *   2. After upload    → alarm fires in 8 s  (polls transcript status)
 *   3. Repeat step 2 until transcript ready, then run Claude + save inline.
 */
export class ProcessingJob {
  constructor(state, env) {
    this.state = state
    this.env = env
  }

  // ── Fetch handler (called by the Worker to kick off the job) ───────────────
  async fetch(request) {
    const url = new URL(request.url)

    if (request.method === 'POST' && url.pathname === '/start') {
      const { jobId, r2Key, venue, duration } = await request.json()

      await Promise.all([
        this.state.storage.put('jobId', jobId),
        this.state.storage.put('r2Key', r2Key),
        this.state.storage.put('venue', venue || ''),
        this.state.storage.put('duration', duration || 0),
        this.state.storage.put('status', 'pending'),
        this.state.storage.put('startedAt', new Date().toISOString()),
      ])

      await this.state.storage.setAlarm(Date.now() + 1_000)
      return Response.json({ ok: true })
    }

    return new Response('Not found', { status: 404 })
  }

  // ── Alarm handler (background processing) ─────────────────────────────────
  async alarm() {
    const status = await this.state.storage.get('status')

    try {
      if (status === 'pending') {
        await this.doUploadToAssemblyAI()
      } else if (status === 'transcribing') {
        await this.doPollTranscription()
      }
    } catch (err) {
      console.error('[ProcessingJob] error in status', status, err)
      await this.markError(err.message)
    }
  }

  // ── Stage 1: upload audio from R2 → AssemblyAI ────────────────────────────
  async doUploadToAssemblyAI() {
    const r2Key = await this.state.storage.get('r2Key')
    const jobId = await this.state.storage.get('jobId')

    const obj = await this.env.R2.get(r2Key)
    if (!obj) throw new Error('Audio file not found in R2')

    const audioBuffer = await obj.arrayBuffer()
    const uploadUrl = await uploadAudio(audioBuffer, this.env.ASSEMBLYAI_KEY)
    const transcriptId = await requestTranscript(uploadUrl, this.env.ASSEMBLYAI_KEY)

    await this.state.storage.put('transcriptId', transcriptId)
    await this.state.storage.put('status', 'transcribing')
    await this.updateJobStatus(jobId, 'transcribing')

    // First poll in 8 s (transcription typically takes 30–120 s)
    await this.state.storage.setAlarm(Date.now() + 8_000)
  }

  // ── Stage 2: poll AssemblyAI until transcript ready ───────────────────────
  async doPollTranscription() {
    const transcriptId = await this.state.storage.get('transcriptId')
    const jobId = await this.state.storage.get('jobId')

    const data = await checkTranscript(transcriptId, this.env.ASSEMBLYAI_KEY)

    if (data.status === 'error') {
      throw new Error(`AssemblyAI transcription error: ${data.error}`)
    }

    if (data.status !== 'completed') {
      // Still processing — poll again in 8 s
      await this.state.storage.setAlarm(Date.now() + 8_000)
      return
    }

    const words = data.words || []
    const transcript = data.text
    const pauses = detectPauses(words)

    await this.state.storage.put('status', 'analyzing')
    await this.updateJobStatus(jobId, 'analyzing')

    await this.doAnalyzeAndSave(transcript, words, pauses)
  }

  // ── Stage 3: Claude analysis + Stage 4: save to D1 + Stage 5: cleanup ─────
  async doAnalyzeAndSave(transcript, words, pauses) {
    const jobId = await this.state.storage.get('jobId')
    const r2Key = await this.state.storage.get('r2Key')
    const venue = await this.state.storage.get('venue')
    const duration = await this.state.storage.get('duration')

    const analysis = await analyzeSet(transcript, pauses, venue, duration, this.env.ANTHROPIC_KEY)

    await this.state.storage.put('status', 'saving')
    await this.updateJobStatus(jobId, 'saving')

    const setId = crypto.randomUUID()
    await saveAnalysis(this.env.DB, setId, transcript, words, pauses, venue, duration, analysis, false)

    // Mark complete in DO state before cleanup (so setId is always recoverable)
    await this.state.storage.put('status', 'done')
    await this.state.storage.put('setId', setId)

    const now = new Date().toISOString()
    await this.env.DB.prepare(
      `UPDATE jobs SET status = 'done', set_id = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(setId, now, jobId)
      .run()

    // Delete temp R2 file after the DB write succeeds
    await this.env.R2.delete(r2Key).catch((err) =>
      console.warn('[ProcessingJob] R2 cleanup failed (non-fatal):', err.message),
    )
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  async markError(message) {
    const jobId = await this.state.storage.get('jobId')
    await this.state.storage.put('status', 'error')
    await this.state.storage.put('error', message)
    await this.updateJobStatus(jobId, 'error', message)
  }

  async updateJobStatus(jobId, status, error = null) {
    const now = new Date().toISOString()
    if (error) {
      await this.env.DB.prepare(
        'UPDATE jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?',
      )
        .bind(status, error, now, jobId)
        .run()
    } else {
      await this.env.DB.prepare('UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?')
        .bind(status, now, jobId)
        .run()
    }
  }
}
