/**
 * Anthropic Claude integration for comedy set analysis.
 */

const COMEDY_TECHNIQUES = [
  'callbacks', 'impressions', 'rule_of_threes', 'misdirection', 'crowd_work',
  'act_out', 'tag', 'topper', 'blue_material', 'self_deprecation',
  'observational', 'physical', 'one_liner',
]

export async function analyzeSet(transcript, pauses, venue, durationSec, apiKey) {
  const pauseSummary = pauses
    .slice(0, 20)
    .map((p) => `"${p.after_word}" — pause: ${p.pause_duration_ms}ms (laugh proxy ${p.laugh_proxy_score.toFixed(1)}/10)`)
    .join('\n')

  const prompt = `You are analyzing a stand-up comedy open mic set. Return ONLY valid JSON — no markdown, no commentary.

TRANSCRIPT:
${transcript}

PERFORMANCE INFO:
- Venue: ${venue || 'unknown'}
- Duration: ${durationSec ? Math.round(durationSec / 60) + ' minutes' : 'unknown'}
- Detected pauses (potential laugh moments):
${pauseSummary || 'None detected'}

Comedy techniques to detect: ${COMEDY_TECHNIQUES.join(', ')}

Return a JSON object matching this exact schema:
{
  "overallScore": number (1-10),
  "overallSummary": string (2-3 honest sentences),
  "strongestBit": string (name of best performing bit),
  "topicSummary": string (1-2 sentences on recurring themes),
  "audienceReception": "great" | "good" | "mixed" | "tough",
  "setTopics": string[] (3-6 thematic tags),
  "metrics": {
    "totalWords": number,
    "totalJokes": number,
    "laughsDetected": number,
    "laughsPerMinute": number,
    "techniquesUsed": string[]
  },
  "chunks": [
    {
      "name": string (thematic section name),
      "score": number (1-10),
      "topics": string[],
      "startSec": number,
      "endSec": number,
      "bits": [
        {
          "name": string (short descriptive name for this joke),
          "score": number (1-10),
          "setup": string,
          "punchline": string,
          "feedback": string (2-3 sentences, honest critique),
          "tags": [{ "text": string, "tagType": "funny" | "fluff" | "said_on_stage" }],
          "positives": string[],
          "improvements": string[],
          "likelyLaughed": boolean,
          "timestampSec": number,
          "pauseDurationMs": number,
          "topics": string[]
        }
      ]
    }
  ]
}

Rules:
- Group bits into 2-5 thematic chunks
- Each chunk should have 1-6 bits
- Be honest and critical — not everything deserves a high score
- "said_on_stage" tags mark deviations from written material
- Score 1-10 fairly: premise strength, punchline payoff, structure, originality`

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }],
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Claude API error (${res.status}): ${text}`)
  }

  const data = await res.json()
  const content = data.content[0].text

  const jsonMatch = content.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('Claude did not return parseable JSON')

  return JSON.parse(jsonMatch[0])
}
