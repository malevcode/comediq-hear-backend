import { similarity } from './similarity.js'

function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)
}

/**
 * Find topic by exact slug or fuzzy name match (Dice > 0.8),
 * or create a new one. Returns topic id.
 */
export async function findOrCreateTopic(db, topicName) {
  const slug = slugify(topicName)

  const exact = await db.prepare('SELECT id FROM topics WHERE slug = ?').bind(slug).first()
  if (exact) return exact.id

  const { results } = await db.prepare('SELECT id, name FROM topics').all()
  let bestId = null
  let bestScore = 0

  for (const row of results) {
    const score = similarity(topicName, row.name)
    if (score > bestScore) {
      bestScore = score
      bestId = row.id
    }
  }

  if (bestScore > 0.8 && bestId) return bestId

  const id = crypto.randomUUID()
  const now = new Date().toISOString()

  await db
    .prepare('INSERT INTO topics (id, name, slug, created_at) VALUES (?, ?, ?, ?)')
    .bind(id, topicName, slug, now)
    .run()

  return id
}

/**
 * Recompute denormalized stats on a topic from sets linked via set_topics.
 */
export async function recalcTopicStats(db, topicId) {
  const { results } = await db
    .prepare(
      `SELECT s.overall_score, s.created_at
       FROM set_topics st JOIN sets s ON st.set_id = s.id
       WHERE st.topic_id = ?`
    )
    .bind(topicId)
    .all()

  if (!results.length) return

  const scores = results.map((r) => r.overall_score).filter((v) => v != null)
  const dates = results.map((r) => r.created_at).filter(Boolean).sort()
  const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null
  const best = scores.length ? Math.max(...scores) : null
  const last = dates.at(-1) ?? null

  await db
    .prepare(
      `UPDATE topics SET total_performances = ?, avg_score = ?, best_score = ?, last_performed_at = ?
       WHERE id = ?`
    )
    .bind(results.length, avg, best, last, topicId)
    .run()
}
