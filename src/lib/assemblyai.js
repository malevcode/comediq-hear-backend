/**
 * AssemblyAI integration helpers.
 */

export async function uploadAudio(audioBuffer, apiKey) {
  const res = await fetch('https://api.assemblyai.com/v2/upload', {
    method: 'POST',
    headers: {
      Authorization: apiKey,
      'Content-Type': 'application/octet-stream',
    },
    body: audioBuffer,
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`AssemblyAI upload failed (${res.status}): ${text}`)
  }

  const { upload_url } = await res.json()
  return upload_url
}

export async function requestTranscript(audioUrl, apiKey) {
  const res = await fetch('https://api.assemblyai.com/v2/transcript', {
    method: 'POST',
    headers: {
      Authorization: apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      audio_url: audioUrl,
      punctuate: true,
      format_text: true,
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`AssemblyAI transcript request failed (${res.status}): ${text}`)
  }

  const { id } = await res.json()
  return id
}

export async function checkTranscript(transcriptId, apiKey) {
  const res = await fetch(`https://api.assemblyai.com/v2/transcript/${transcriptId}`, {
    headers: { Authorization: apiKey },
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`AssemblyAI status check failed (${res.status}): ${text}`)
  }

  return res.json()
}

/**
 * Detect pauses > 800 ms between consecutive words.
 * Returns an array of pause objects compatible with the original schema.
 */
export function detectPauses(words) {
  if (!words || words.length < 2) return []

  const pauses = []
  for (let i = 1; i < words.length; i++) {
    const prev = words[i - 1]
    const curr = words[i]
    const gapMs = curr.start - prev.end
    if (gapMs > 800) {
      const precedingWords = words.slice(Math.max(0, i - 15), i)
      pauses.push({
        after_word: prev.text,
        after_time_ms: prev.end,
        pause_duration_ms: gapMs,
        laugh_proxy_score: Math.min(10, gapMs / 200),
        preceding_text: precedingWords.map((w) => w.text).join(' '),
      })
    }
  }
  return pauses
}
