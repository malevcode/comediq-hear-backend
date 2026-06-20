/**
 * Shared D1 save logic for a processed set.
 * Called by ProcessingJob (new sets) and the reanalyze endpoint (existing sets).
 */
import { findOrCreateIdentity, recalcIdentityStats } from './identity.js'
import { findOrCreateTopic, recalcTopicStats } from './topics.js'

/**
 * Persist a full set analysis to D1.
 *
 * @param {D1Database} db
 * @param {string} setId - UUID (caller generates; for existing sets pass the current id)
 * @param {string} transcript
 * @param {object[]} words - word-level timestamps from AssemblyAI
 * @param {object[]} pauses - detected pauses from detectPauses()
 * @param {string|null} venue
 * @param {number|null} durationSec
 * @param {object} analysis - output of analyzeSet()
 * @param {boolean} [existingSet=false] - if true, UPDATE the set row instead of INSERT
 */
export async function saveAnalysis(db, setId, transcript, words, pauses, venue, durationSec, analysis, existingSet = false) {
  const now = new Date().toISOString()
  const allBits = (analysis.chunks || []).flatMap((c) => c.bits || [])
  const totalLaughCount = allBits.filter((b) => b.likelyLaughed).length

  if (existingSet) {
    await db
      .prepare(
        `UPDATE sets
         SET overall_score = ?, overall_summary = ?, strongest_bit = ?,
             audience_reception = ?, topic_summary = ?, total_laugh_count = ?,
             set_topics = ?, transcript = ?, pause_points = ?, words = ?
         WHERE id = ?`,
      )
      .bind(
        analysis.overallScore ?? null,
        analysis.overallSummary ?? null,
        analysis.strongestBit ?? null,
        analysis.audienceReception ?? null,
        analysis.topicSummary ?? null,
        totalLaughCount,
        JSON.stringify(analysis.setTopics || []),
        transcript,
        JSON.stringify(pauses),
        JSON.stringify(words),
        setId,
      )
      .run()
  } else {
    await db
      .prepare(
        `INSERT INTO sets (
           id, venue, date, date_iso, duration_sec, transcript,
           overall_score, overall_summary, strongest_bit,
           context, laugh_data, pause_points, words,
           audience_reception, topic_summary, total_laugh_count, set_topics, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        setId,
        venue || null,
        now.split('T')[0],
        now,
        durationSec || null,
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
        now,
      )
      .run()
  }

  // Set-level topics (clear + re-link)
  await db.prepare('DELETE FROM set_topics WHERE set_id = ?').bind(setId).run()

  const setTopicIds = []
  for (const name of analysis.setTopics || []) {
    const id = await findOrCreateTopic(db, name)
    setTopicIds.push(id)
    await db
      .prepare('INSERT OR IGNORE INTO set_topics (set_id, topic_id) VALUES (?, ?)')
      .bind(setId, id)
      .run()
  }

  // Chunks → bits → performances
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
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        chunkId, setId, chunk.name, chunkOrder++,
        chunk.startSec ?? null, chunk.endSec ?? null,
        avgScore, laughCount, chunkBits.length,
        JSON.stringify(chunk.topics || []), now,
      )
      .run()

    for (const bit of chunkBits) {
      const bitId = crypto.randomUUID()
      const identityId = await findOrCreateIdentity(db, bit.name)

      // Best-effort pause match by timestamp proximity (±5 s)
      const pauseMatch = pauses.find(
        (p) => bit.timestampSec != null && Math.abs(p.after_time_ms / 1000 - bit.timestampSec) < 5,
      )
      const pauseMs = bit.pauseDurationMs ?? pauseMatch?.pause_duration_ms ?? null
      const laughProxy = pauseMs != null ? Math.min(10, pauseMs / 200) : null

      await db
        .prepare(
          `INSERT INTO bits (
             id, set_id, bit_identity_id, chunk_id, name, score, setup, punchline,
             feedback, tags, positives, improvements, likely_laughed,
             timestamp_sec, pause_duration_ms, chunk_name, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          chunk.name, now,
        )
        .run()

      await db
        .prepare(
          `INSERT INTO bit_performances (
             id, bit_id, bit_identity_id, set_id, performance_date,
             performance_date_iso, venue, analysis_score, laugh_proxy_score,
             likely_laughed, pause_duration_ms, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(), bitId, identityId, setId,
          now.split('T')[0], now, venue || null,
          bit.score ?? null, laughProxy,
          bit.likelyLaughed ? 1 : 0, pauseMs, now,
        )
        .run()

      await db
        .prepare('UPDATE bit_identities SET last_performed_at = ? WHERE id = ?')
        .bind(now, identityId)
        .run()

      await recalcIdentityStats(db, identityId)

      for (const topicName of bit.topics || []) {
        const topicId = await findOrCreateTopic(db, topicName)
        await db
          .prepare('INSERT OR IGNORE INTO bit_topics (bit_identity_id, topic_id) VALUES (?, ?)')
          .bind(identityId, topicId)
          .run()
      }
    }
  }

  for (const topicId of setTopicIds) {
    await recalcTopicStats(db, topicId)
  }

  return setId
}
