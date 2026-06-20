/**
 * Shared utilities used across routes and libs.
 */

export function safeJson(val, fallback) {
  if (val == null) return fallback
  if (typeof val === 'object') return val
  try { return JSON.parse(val) } catch { return fallback }
}

export function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)
}

export function avg(arr) {
  const nums = arr.filter((v) => v != null)
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null
}

/** Haversine distance in miles between two lat/lng points. */
export function distanceMiles(lat1, lng1, lat2, lng2) {
  const R = 3_958.8
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLng = ((lng2 - lng1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}
