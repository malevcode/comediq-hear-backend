/**
 * Anthropic Claude integration for comedy set analysis.
 * Uses tool_use to guarantee structured JSON output.
 */

const COMEDY_TECHNIQUES = [
  'callbacks', 'impressions', 'rule_of_threes', 'misdirection', 'crowd_work',
  'act_out', 'tag', 'topper', 'blue_material', 'self_deprecation',
  'observational', 'physical', 'one_liner',
]

const ANALYSIS_TOOL = {
  name: 'submit_analysis',
  description: 'Submit the complete structured analysis of a stand-up comedy set.',
  input_schema: {
    type: 'object',
    properties: {
      overallScore: { type: 'number', description: '1-10 score for the full set' },
      overallSummary: { type: 'string', description: '2-3 honest sentences summarizing the set' },
      strongestBit: { type: 'string', description: 'Name of the best performing bit' },
      topicSummary: { type: 'string', description: '1-2 sentences on recurring themes' },
      audienceReception: { type: 'string', enum: ['great', 'good', 'mixed', 'tough'] },
      setTopics: {
        type: 'array',
        items: { type: 'string' },
        description: '3-6 thematic tags (e.g. "relationships", "self-deprecation", "tech")',
      },
      metrics: {
        type: 'object',
        properties: {
          totalWords: { type: 'number' },
          totalJokes: { type: 'number' },
          laughsDetected: { type: 'number', description: 'Estimated from pause data' },
          laughsPerMinute: { type: 'number' },
          techniquesUsed: {
            type: 'array',
            items: { type: 'string' },
            description: 'Subset of detected comedy techniques from the provided list',
          },
        },
        required: ['totalWords', 'totalJokes', 'laughsDetected', 'laughsPerMinute', 'techniquesUsed'],
      },
      chunks: {
        type: 'array',
        description: '2-5 thematic sections of the set',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Short thematic section name' },
            score: { type: 'number', description: '1-10 section score' },
            topics: { type: 'array', items: { type: 'string' } },
            startSec: { type: 'number', description: 'Approximate start time in seconds' },
            endSec: { type: 'number', description: 'Approximate end time in seconds' },
            bits: {
              type: 'array',
              description: '1-6 individual jokes in this section',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: 'Short unique descriptive name for this joke (3-6 words)' },
                  score: { type: 'number', description: '1-10 score: premise strength, punchline payoff, structure, originality' },
                  setup: { type: 'string', description: 'The setup as performed' },
                  punchline: { type: 'string', description: 'The punchline as performed' },
                  feedback: { type: 'string', description: '2-3 direct, specific sentences. What worked, what to fix, and exactly how.' },
                  tags: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        text: { type: 'string' },
                        tagType: {
                          type: 'string',
                          enum: ['funny', 'fluff', 'said_on_stage'],
                          description: 'said_on_stage = deviated from written material',
                        },
                      },
                      required: ['text', 'tagType'],
                    },
                  },
                  positives: { type: 'array', items: { type: 'string' }, description: '1-3 specific strengths' },
                  improvements: { type: 'array', items: { type: 'string' }, description: '1-3 specific actionable fixes' },
                  likelyLaughed: { type: 'boolean', description: 'True if pause data suggests the audience laughed' },
                  timestampSec: { type: 'number', description: 'Approximate timestamp in seconds' },
                  pauseDurationMs: { type: 'number', description: 'Duration of post-punchline pause if detected' },
                  topics: { type: 'array', items: { type: 'string' }, description: '1-3 topic tags for this bit' },
                },
                required: [
                  'name', 'score', 'setup', 'punchline', 'feedback',
                  'positives', 'improvements', 'likelyLaughed', 'topics',
                ],
              },
            },
          },
          required: ['name', 'score', 'topics', 'bits'],
        },
      },
    },
    required: ['overallScore', 'overallSummary', 'strongestBit', 'topicSummary', 'audienceReception', 'setTopics', 'metrics', 'chunks'],
  },
}

export async function analyzeSet(transcript, pauses, venue, durationSec, apiKey) {
  const pauseSummary = pauses
    .slice(0, 30)
    .map(
      (p) =>
        `"${p.after_word}" — ${p.pause_duration_ms}ms pause (laugh proxy ${p.laugh_proxy_score.toFixed(1)}/10)`,
    )
    .join('\n')

  const durationStr = durationSec ? `${Math.round(durationSec / 60)} minutes` : 'unknown'

  const prompt = `You are analyzing a stand-up comedy open mic set. The performer is Adam, a working comedian who wants direct, honest, actionable feedback — not flattery.

TRANSCRIPT:
${transcript}

PERFORMANCE CONTEXT:
- Venue: ${venue || 'unknown open mic'}
- Duration: ${durationStr}
- Detected audience response moments (pauses ≥ 800ms — likely laughs or dead air):
${pauseSummary || 'None detected'}

Comedy techniques to identify: ${COMEDY_TECHNIQUES.join(', ')}

Analysis rules:
- Be honest and critical — a mediocre set deserves a 5, not an 8
- Group bits into 2-5 thematic chunks by topic or energy shift
- Each chunk has 1-6 bits; name bits with short, memorable phrases (not the punchline)
- Use pause data to inform likelyLaughed — long pauses after a punchline = probable laugh
- Feedback must be specific: "the misdirection works but the callback feels forced" not "good job"
- Score rubric: 1-3 = not working, 4-5 = needs work, 6-7 = solid, 8-9 = strong, 10 = exceptional
- Tag any moments that sound improvised or off-script as "said_on_stage"`

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,
      tools: [ANALYSIS_TOOL],
      tool_choice: { type: 'auto' },
      messages: [{ role: 'user', content: prompt }],
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Claude API error (${res.status}): ${text}`)
  }

  const data = await res.json()

  // Prefer tool_use block (guaranteed structured output)
  const toolBlock = data.content?.find((b) => b.type === 'tool_use')
  if (toolBlock?.input) return toolBlock.input

  // Fallback: parse text response
  const textBlock = data.content?.find((b) => b.type === 'text')
  if (textBlock?.text) {
    const cleaned = textBlock.text.replace(/```json\n?|```\n?/g, '').trim()
    const match = cleaned.match(/\{[\s\S]*\}/)
    if (match) return JSON.parse(match[0])
  }

  throw new Error(`Claude returned no parseable content (stop_reason: ${data.stop_reason})`)
}
