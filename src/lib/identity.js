import { similarity } from './similarity.js'

/**
 * Find an existing bit identity by name similarity (Dice > 0.75),
 * or create a new one. Returns the identity id.
 */
export async function findOrCreateIdentity(db, bitName) {
  const { results } = await db.prepare('SELECT id, canonical_name FROM bit_identities').all()

  let bestId = null
  let bestScore = 0

  for (const row of results) {
    const score = similarity(bitName, row.canonical_name)
    if (score > bestScore) {
      bestScore = score
      bestId = row.id
    }
  }

  if (bestScore > 0.75 && bestId) return bestId

  const id = crypto.randomUUID()
  const slug = slugify(bitName)
  const now = new Date().toISOString()

  await db
    .prepare(
      `INSERT INTO bit_identities (id, canonical_name, slug, status, first_seen_at, last_performed_at, created_at)
       VALUES (?, ?, ?, 'premise', ?, ?, ?)`
    )
    .bind(id, bitName, slug, now, now, now)
    .run()

  return id
}

/**
 * Recompute denormalized stats on a bit_identity from its performances.
 */
export async function recalcIdentityStats(db, identityId) {
  const { results } = await db
    .prepare(
      `SELECT analysis_score, user_rating, laugh_proxy_score, likely_laughed, performance_date_iso
       FROM bit_performances WHERE bit_identity_id = ?`
    )
    .bind(identityId)
    .all()

  if (!results.length) return

  const scores = results.map((r) => r.analysis_score).filter((v) => v != null)
  const ratings = results.map((r) => r.user_rating).filter((v) => v != null)
  const proxies = results.map((r) => r.laugh_proxy_score).filter((v) => v != null)
  const dates = results.map((r) => r.performance_date_iso).filter(Boolean).sort()
  const lastPerformed = dates.at(-1) ?? null

  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null)
  const best = scores.length ? Math.max(...scores) : null

  let statusClause = ''
  const extraValues = []
  if (lastPerformed) {
    const daysSince = (Date.now() - new Date(lastPerformed).getTime()) / 86_400_000
    if (daysSince > 30) {
      statusClause = ', status = ?'
      extraValues.push('retired')
    }
  }

  await db
    .prepare(
      `UPDATE bit_identities
       SET total_performances = ?, avg_analysis_score = ?, avg_user_rating = ?,
           avg_laugh_proxy = ?, best_score = ?, last_performed_at = ?
           ${statusClause}
       WHERE id = ?`
    )
    .bind(results.length, avg(scores), avg(ratings), avg(proxies), best, lastPerformed, ...extraValues, identityId)
    .run()
}

function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)
}
