import { uploadAudio, requestTranscript, checkTranscript, detectPauses } from '../lib/assemblyai.js'
import { analyzeSet } from '../lib/claude.js'
import { findOrCreateIdentity, recalcIdentityStats } from '../lib/identity.js'
import { findOrCreateTopic, recalcTopicStats } from '../lib/topics.js'

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

      // The /start handler is fast — actual work happens in the alarm.
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
      await this.state.storage.setAlarm(Date.now() + 8_000)
      return
    }

    // Transcript ready — continue to analysis (same alarm invocation)
    const words = data.words || []
    const transcript = data.text
    const pauses = detectPauses(words)

    await this.state.storage.put('status', 'analyzing')
    await this.updateJobStatus(jobId, 'analyzing')

    await this.doAnalyzeAndSave(transcript, words, pauses)
  }

  // ── Stage 3: Claude analysis ── Stage 4: save to D1 ── Stage 5: cleanup ──
  async doAnalyzeAndSave(transcript, words, pauses) {
    const jobId = await this.state.storage.get('jobId')
    const r2Key = await this.state.storage.get('r2Key')
    const venue = await this.state.storage.get('venue')
    const duration = await this.state.storage.get('duration')

    const analysis = await analyzeSet(transcript, pauses, venue, duration, this.env.ANTHROPIC_KEY)

    await this.state.storage.put('status', 'saving')
    await this.updateJobStatus(jobId, 'saving')

    const setId = await this.saveToD1(transcript, words, pauses, venue, duration, analysis)

    // Delete temp R2 file now that processing is complete
    await this.env.R2.delete(r2Key)

    await this.state.storage.put('status', 'done')
    await this.state.storage.put('setId', setId)

    const now = new Date().toISOString()
    await this.env.DB.prepare(
      `UPDATE jobs SET status = 'done', set_id = ?, updated_at = ? WHERE id = ?`
    )
      .bind(setId, now, jobId)
      .run()
  }

  // ── Persist the full set + bits + chunks + topics ─────────────────────────
  async saveToD1(transcript, words, pauses, venue, duration, analysis) {
    const db = this.env.DB
    const now = new Date().toISOString()
    const setId = crypto.randomUUID()

    const allBits = (analysis.chunks || []).flatMap((c) => c.bits || [])
    const totalLaughCount = allBits.filter((b) => b.likelyLaughed).length

    // 1. Insert set row
    await db
      .prepare(
        `INSERT INTO sets (
           id, venue, date, date_iso, duration_sec, transcript,
           overall_score, overall_summary, strongest_bit,
           context, laugh_data, pause_points, words,
           audience_reception, topic_summary, total_laugh_count, set_topics, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        setId,
        venue || null,
        now.split('T')[0],
        now,
        duration || null,
        transcript,
        analysis.overallScore ?? null,
        analysis.overallSummary ?? null,
        analysis.strongestBit ?? null,
        JSON.stringify({}),
        JSON.stringify({ pauses_detected: pauses.length }),
        JSON.stringify(pauses),
        JSON.stringify(words),
        analysis.audienceReception ?? null,
        analysis.topicSummary ?? null,
        totalLaughCount,
        JSON.stringify(analysis.setTopics || []),
        now
      )
      .run()

    // 2. Topics
    const topicIds = []
    for (const name of analysis.setTopics || []) {
      const id = await findOrCreateTopic(db, name)
      topicIds.push(id)
      await db
        .prepare('INSERT OR IGNORE INTO set_topics (set_id, topic_id) VALUES (?, ?)')
        .bind(setId, id)
        .run()
    }

    // 3. Chunks → bits → performances
    let chunkOrder = 1
    for (const chunk of analysis.chunks || []) {
      const chunkId = crypto.randomUUID()
      const chunkBits = chunk.bits || []
      const laughCount = chunkBits.filter((b) => b.likelyLaughed).length
      const scores = chunkBits.map((b) => b.score).filter((v) => v != null)
      const avgScore = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null

      await db
        .prepare(
          `INSERT INTO chunks (id, set_id, name, position_order, start_sec, end_sec,
             overall_score, laugh_count, bit_count, topics, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          chunkId, setId, chunk.name, chunkOrder++,
          chunk.startSec ?? null, chunk.endSec ?? null,
          avgScore, laughCount, chunkBits.length,
          JSON.stringify(chunk.topics || []), now
        )
        .run()

      for (const bit of chunkBits) {
        const bitId = crypto.randomUUID()
        const identityId = await findOrCreateIdentity(db, bit.name)

        // Best-effort pause match by timestamp proximity (±5 s)
        const pauseMatch = pauses.find(
          (p) => bit.timestampSec != null && Math.abs(p.after_time_ms / 1000 - bit.timestampSec) < 5
        )
        const pauseMs = bit.pauseDurationMs ?? pauseMatch?.pause_duration_ms ?? null
        const laughProxy = pauseMs != null ? Math.min(10, pauseMs / 200) : null

        await db
          .prepare(
            `INSERT INTO bits (
               id, set_id, bit_identity_id, chunk_id, name, score, setup, punchline,
               feedback, tags, positives, improvements, likely_laughed,
               timestamp_sec, pause_duration_ms, chunk_name, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            bitId, setId, identityId, chunkId,
            bit.name, bit.score ?? null,
            bit.setup ?? null, bit.punchline ?? null, bit.feedback ?? null,
            JSON.stringify(bit.tags || []),
            JSON.stringify(bit.positives || []),
            JSON.stringify(bit.improvements || []),
            bit.likelyLaughed ? 1 : 0,
            bit.timestampSec ?? null, pauseMs,
            chunk.name, now
          )
          .run()

        // Bit performance record
        await db
          .prepare(
            `INSERT INTO bit_performances (
               id, bit_id, bit_identity_id, set_id, performance_date,
               performance_date_iso, venue, analysis_score, laugh_proxy_score,
               likely_laughed, pause_duration_ms, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            crypto.randomUUID(), bitId, identityId, setId,
            now.split('T')[0], now, venue || null,
            bit.score ?? null, laughProxy,
            bit.likelyLaughed ? 1 : 0, pauseMs, now
          )
          .run()

        await db
          .prepare('UPDATE bit_identities SET last_performed_at = ? WHERE id = ?')
          .bind(now, identityId)
          .run()

        await recalcIdentityStats(db, identityId)

        // Bit topics
        for (const topicName of bit.topics || []) {
          const topicId = await findOrCreateTopic(db, topicName)
          await db
            .prepare('INSERT OR IGNORE INTO bit_topics (bit_identity_id, topic_id) VALUES (?, ?)')
            .bind(identityId, topicId)
            .run()
        }
      }
    }

    // Recalc stats for all set-level topics
    for (const topicId of topicIds) {
      await recalcTopicStats(db, topicId)
    }

    return setId
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
        'UPDATE jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?'
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
