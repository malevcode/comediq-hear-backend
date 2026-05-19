import { Hono } from 'hono'

export const statsRoutes = new Hono()

/**
 * GET /stats
 * Aggregate analytics for the full career: sets, bits, trends, top/worst topics.
 */
statsRoutes.get('/', async (c) => {
  const db = c.env.DB
  const now = new Date()
  const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString()
  const twelveWeeksAgo = new Date(now - 84 * 24 * 60 * 60 * 1000).toISOString()

  const [
    setStats,
    recentSetCount,
    bitStats,
    identityCount,
    topTopics,
    worstTopics,
    recentSets,
    scoreHistory,
    topBits,
    needsWorkBits,
    activeIdentities,
  ] = await Promise.all([
    // Overall set stats
    db.prepare(
      `SELECT COUNT(*) AS total,
              AVG(overall_score) AS avg_score,
              AVG(duration_sec) AS avg_duration_sec,
              SUM(total_laugh_count) AS total_laughs
       FROM sets WHERE overall_score IS NOT NULL`,
    ).first(),

    // Sets in last 30 days
    db.prepare(
      `SELECT COUNT(*) AS total FROM sets WHERE created_at >= ?`,
    ).bind(thirtyDaysAgo).first(),

    // Bit performance stats
    db.prepare(
      `SELECT COUNT(*) AS total_performances,
              AVG(analysis_score) AS avg_score,
              AVG(user_rating) AS avg_user_rating
       FROM bit_performances`,
    ).first(),

    // Unique joke count
    db.prepare('SELECT COUNT(*) AS total FROM bit_identities').first(),

    // Top 5 topics by avg_score (min 2 performances)
    db.prepare(
      `SELECT * FROM topics WHERE total_performances >= 2
       ORDER BY avg_score DESC NULLS LAST LIMIT 5`,
    ).all(),

    // Bottom 3 topics (most room for improvement, min 2 performances)
    db.prepare(
      `SELECT * FROM topics WHERE total_performances >= 2 AND avg_score IS NOT NULL
       ORDER BY avg_score ASC LIMIT 3`,
    ).all(),

    // Last 5 sets
    db.prepare(
      `SELECT id, venue, date, overall_score, total_laugh_count, duration_sec, created_at
       FROM sets ORDER BY created_at DESC LIMIT 5`,
    ).all(),

    // Weekly avg scores for the last 12 weeks
    db.prepare(
      `SELECT strftime('%Y-W%W', created_at) AS week,
              ROUND(AVG(overall_score), 2) AS avg_score,
              COUNT(*) AS set_count
       FROM sets
       WHERE created_at >= ? AND overall_score IS NOT NULL
       GROUP BY week ORDER BY week ASC`,
    ).bind(twelveWeeksAgo).all(),

    // Top 5 bits by avg_analysis_score (min 3 performances)
    db.prepare(
      `SELECT id, canonical_name, slug, total_performances,
              avg_analysis_score, avg_user_rating, avg_laugh_proxy, best_score, status
       FROM bit_identities
       WHERE total_performances >= 3 AND avg_analysis_score IS NOT NULL
       ORDER BY avg_analysis_score DESC LIMIT 5`,
    ).all(),

    // Bottom 5 bits (most room for improvement, min 3 performances)
    db.prepare(
      `SELECT id, canonical_name, slug, total_performances,
              avg_analysis_score, avg_user_rating, avg_laugh_proxy, best_score, status
       FROM bit_identities
       WHERE total_performances >= 3 AND avg_analysis_score IS NOT NULL
       ORDER BY avg_analysis_score ASC LIMIT 5`,
    ).all(),

    // Active joke count (performed in last 30 days)
    db.prepare(
      `SELECT COUNT(*) AS total FROM bit_identities WHERE last_performed_at >= ?`,
    ).bind(thirtyDaysAgo).first(),
  ])

  const avgDurationSec = setStats?.avg_duration_sec
  const totalLaughs = setStats?.total_laughs ?? 0
  const totalSets = setStats?.total ?? 0

  return c.json({
    sets: {
      total: totalSets,
      last30Days: recentSetCount?.total ?? 0,
      avgScore: setStats?.avg_score ? +setStats.avg_score.toFixed(2) : null,
      avgDurationSec: avgDurationSec ? +avgDurationSec.toFixed(0) : null,
      avgDurationMin: avgDurationSec ? +(avgDurationSec / 60).toFixed(1) : null,
      totalLaughs,
      avgLaughsPerSet: totalSets ? +(totalLaughs / totalSets).toFixed(1) : null,
    },
    bits: {
      totalPerformances: bitStats?.total_performances ?? 0,
      uniqueIdentities: identityCount?.total ?? 0,
      activeIdentities: activeIdentities?.total ?? 0,
      avgScore: bitStats?.avg_score ? +bitStats.avg_score.toFixed(2) : null,
      avgUserRating: bitStats?.avg_user_rating ? +bitStats.avg_user_rating.toFixed(2) : null,
    },
    topTopics: topTopics.results,
    needsWorkTopics: worstTopics.results,
    recentSets: recentSets.results,
    scoreHistory: scoreHistory.results,
    topBits: topBits.results,
    needsWorkBits: needsWorkBits.results,
  })
})

/**
 * GET /stats/laugh-trend
 * Laugh proxy scores per set over time (for trend charting).
 */
statsRoutes.get('/laugh-trend', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') || '20', 10), 100)

  const { results } = await c.env.DB.prepare(
    `SELECT id, venue, date, total_laugh_count, duration_sec, overall_score, created_at
     FROM sets
     ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(limit)
    .all()

  const data = results.reverse().map((s) => ({
    id: s.id,
    venue: s.venue,
    date: s.date,
    total_laugh_count: s.total_laugh_count,
    duration_sec: s.duration_sec,
    laughs_per_minute: s.duration_sec
      ? +((s.total_laugh_count / (s.duration_sec / 60)).toFixed(2))
      : null,
    overall_score: s.overall_score,
  }))

  return c.json(data)
})

/**
 * GET /stats/bit/:id
 * Full score history for a single joke identity.
 */
statsRoutes.get('/bit/:id', async (c) => {
  const id = c.req.param('id')

  const identity = await c.env.DB.prepare('SELECT * FROM bit_identities WHERE id = ?')
    .bind(id)
    .first()
  if (!identity) return c.json({ error: 'Identity not found' }, 404)

  const { results: performances } = await c.env.DB.prepare(
    `SELECT bp.performance_date, bp.venue, bp.analysis_score, bp.user_rating,
            bp.laugh_proxy_score, bp.likely_laughed, bp.pause_duration_ms,
            s.overall_score AS set_score, s.audience_reception
     FROM bit_performances bp
     LEFT JOIN sets s ON bp.set_id = s.id
     WHERE bp.bit_identity_id = ?
     ORDER BY bp.performance_date_iso ASC`,
  )
    .bind(id)
    .all()

  return c.json({
    identity: {
      id: identity.id,
      canonical_name: identity.canonical_name,
      slug: identity.slug,
      status: identity.status,
      total_performances: identity.total_performances,
      avg_analysis_score: identity.avg_analysis_score,
      best_score: identity.best_score,
    },
    performances,
    trend: computeTrend(performances.map((p) => p.analysis_score).filter((v) => v != null)),
  })
})

// ── Helpers ───────────────────────────────────────────────────────────────────
function computeTrend(scores) {
  if (scores.length < 2) return null
  const n = scores.length
  const recent = scores.slice(-3)
  const earlier = scores.slice(0, -3)
  if (!earlier.length) return null
  const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length
  const earlierAvg = earlier.reduce((a, b) => a + b, 0) / earlier.length
  const delta = recentAvg - earlierAvg
  return {
    direction: delta > 0.5 ? 'improving' : delta < -0.5 ? 'declining' : 'stable',
    delta: +delta.toFixed(2),
    recentAvg: +recentAvg.toFixed(2),
    earlierAvg: +earlierAvg.toFixed(2),
    dataPoints: n,
  }
}
