/**
 * Dice coefficient using bigrams for string similarity.
 * Returns a score from 0 (no overlap) to 1 (identical).
 */
function bigrams(str) {
  const s = str.toLowerCase().trim()
  const set = new Set()
  for (let i = 0; i < s.length - 1; i++) {
    set.add(s.slice(i, i + 2))
  }
  return set
}

export function similarity(a, b) {
  if (!a || !b) return 0
  const setA = bigrams(a)
  const setB = bigrams(b)
  if (setA.size === 0 && setB.size === 0) return 1
  if (setA.size === 0 || setB.size === 0) return 0

  let intersection = 0
  for (const gram of setA) {
    if (setB.has(gram)) intersection++
  }

  return (2 * intersection) / (setA.size + setB.size)
}
