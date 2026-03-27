require('dotenv').config();
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const AAI_KEY = process.env.ASSEMBLYAI_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;

if (!AAI_KEY || !ANTHROPIC_KEY) {
  console.error('Missing ASSEMBLYAI_KEY or ANTHROPIC_KEY in .env');
  process.exit(1);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function transcribeFile(filePath) {
  const label = path.basename(filePath);
  console.log(`\n[${label}] Reading file...`);
  const buffer = fs.readFileSync(filePath);

  console.log(`[${label}] Uploading to AssemblyAI...`);
  const upload = await fetch('https://api.assemblyai.com/v2/upload', {
    method: 'POST',
    headers: { authorization: AAI_KEY, 'content-type': 'application/octet-stream' },
    body: buffer
  });
  if (!upload.ok) throw new Error('Upload failed: ' + upload.status);
  const { upload_url } = await upload.json();

  console.log(`[${label}] Transcribing...`);
  const txReq = await fetch('https://api.assemblyai.com/v2/transcript', {
    method: 'POST',
    headers: { authorization: AAI_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ audio_url: upload_url, punctuate: true, format_text: true })
  });
  if (!txReq.ok) throw new Error('Transcript request failed');
  const { id: txId } = await txReq.json();

  for (let i = 0; i < 150; i++) {
    await sleep(3000);
    const poll = await fetch(`https://api.assemblyai.com/v2/transcript/${txId}`, {
      headers: { authorization: AAI_KEY }
    });
    const pd = await poll.json();
    if (pd.status === 'completed') {
      console.log(`[${label}] Transcription done!`);
      return pd;
    }
    if (pd.status === 'error') throw new Error('Transcription error: ' + pd.error);
    process.stdout.write('.');
  }
  throw new Error('Transcription timed out');
}

async function analyzeWithClaude(transcript, words, durationMins, label) {
  const pausePoints = [];
  for (let i = 0; i < words.length - 1; i++) {
    const gap = words[i + 1].start - words[i].end;
    if (gap > 800) {
      pausePoints.push({
        after_word: words[i].text,
        after_time_ms: words[i].end,
        pause_duration_ms: gap,
        preceding_text: words.slice(Math.max(0, i - 15), i + 1).map(w => w.text).join(' ')
      });
    }
  }

  const pauseSummary = pausePoints.slice(0, 25).map(p =>
    `[${(p.after_time_ms / 1000).toFixed(1)}s] ${p.pause_duration_ms}ms pause after: "...${p.preceding_text}"`
  ).join('\n');

  console.log(`\n[${label}] Analyzing with Claude... (${pausePoints.length} pauses detected)`);

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: `You are a sharp, honest comedy coach analyzing a stand-up set.

DURATION: ${durationMins} minutes

FULL TRANSCRIPT:
"""${transcript}"""

SIGNIFICANT PAUSES (gaps > 800ms -- likely laugh or reaction moments):
${pauseSummary || 'No significant pauses detected'}

Analyze this set. Group bits into thematic chunks. Use pause data to determine if a punchline likely got a laugh.

Return ONLY valid JSON, no markdown:
{"overallScore":<1-10 one decimal>,"overallSummary":"<2 honest coaching sentences>","strongestBit":"<best bit name>","totalDuration":"${durationMins} min","chunks":[{"name":"<theme name 2-5 words>","bits":[{"name":"<bit name 3-6 words>","score":<1-10>,"setup":"<setup line>","punchline":"<punchline>","feedback":"<1-2 sentences coaching>","tags":["<2-4 tags>"],"positives":["<what worked 5 words>"],"improvements":["<fix 6 words>"],"likelyLaughed":<true/false>,"timestampSec":<seconds or null>,"pauseDurationMs":<ms of pause after punchline or null>}]}]}`
      }]
    })
  });

  if (!res.ok) {
    const e = await res.json();
    throw new Error('Claude error: ' + JSON.stringify(e));
  }

  const data = await res.json();
  const text = data.content.map(c => c.text || '').join('');
  let cleaned = text.replace(/```json|```/g, '').trim();
  // If JSON is truncated, try to close it gracefully
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // Try to find the last complete bit and close the JSON
    const lastGoodBit = cleaned.lastIndexOf(',"likelyLaughed"');
    if (lastGoodBit > 0) {
      // Find end of that bit's object
      let depth = 0, endIdx = lastGoodBit;
      for (let i = lastGoodBit; i < cleaned.length; i++) {
        if (cleaned[i] === '{') depth++;
        if (cleaned[i] === '}') { depth--; if (depth < 0) { endIdx = i; break; } }
      }
      cleaned = cleaned.slice(0, endIdx + 1) + ']}]}';
    }
    return JSON.parse(cleaned);
  }
}

function generateHTML(results) {
  const date = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  const setCards = results.map(({ label, analysis, transcript }, si) => {
    const allBits = (analysis.chunks || []).flatMap(c =>
      (c.bits || []).map(b => ({ ...b, chunkName: c.name }))
    ).sort((a, b) => b.score - a.score);

    const bitsHTML = allBits.map((bit, i) => `
      <div class="bit ${bit.likelyLaughed ? 'laughed' : ''}">
        <div class="bit-header">
          <span class="bit-rank">#${i + 1}</span>
          <span class="bit-name">${bit.name}</span>
          <span class="bit-score score-${Math.round(bit.score)}">${bit.score}</span>
          ${bit.likelyLaughed ? '<span class="laugh-badge">😂 LAUGHED</span>' : ''}
        </div>
        <div class="bit-chunk">from: ${bit.chunkName}</div>
        <div class="bit-lines">
          <div class="setup"><b>Setup:</b> ${bit.setup || '—'}</div>
          <div class="punchline"><b>Punchline:</b> ${bit.punchline || '—'}</div>
        </div>
        <div class="bit-feedback">${bit.feedback}</div>
        ${bit.positives && bit.positives.length ? `<div class="positives">✅ ${bit.positives.join(' &bull; ')}</div>` : ''}
        ${bit.improvements && bit.improvements.length ? `<div class="improvements">💡 ${bit.improvements.join(' &bull; ')}</div>` : ''}
        ${bit.tags && bit.tags.length ? `<div class="tags">${bit.tags.map(t => `<span class="tag">${t}</span>`).join('')}</div>` : ''}
      </div>
    `).join('');

    return `
      <div class="set-card">
        <div class="set-header">
          <div class="set-title">${label}</div>
          <div class="set-meta">
            <span class="overall-score">${analysis.overallScore}/10</span>
            <span class="duration">${analysis.totalDuration}</span>
          </div>
        </div>
        <div class="set-summary">${analysis.overallSummary}</div>
        <div class="strongest">⭐ Strongest bit: <b>${analysis.strongestBit}</b></div>
        <details class="transcript-toggle">
          <summary>📝 Full Transcript</summary>
          <div class="transcript">${transcript}</div>
        </details>
        <h3>Bits (ranked by score)</h3>
        <div class="bits">${bitsHTML}</div>
      </div>
    `;
  }).join('');

  // Find top bits across both sets
  const allBitsFlat = results.flatMap(({ label, analysis }) =>
    (analysis.chunks || []).flatMap(c =>
      (c.bits || []).map(b => ({ ...b, setLabel: label }))
    )
  ).sort((a, b) => b.score - a.score).slice(0, 5);

  const topBitsHTML = allBitsFlat.map((bit, i) => `
    <div class="top-bit">
      <span class="top-rank">#${i + 1}</span>
      <div>
        <div class="top-bit-name">${bit.name} ${bit.likelyLaughed ? '😂' : ''}</div>
        <div class="top-bit-set">${bit.setLabel}</div>
        <div class="top-bit-punchline">"${bit.punchline}"</div>
      </div>
      <span class="top-score score-${Math.round(bit.score)}">${bit.score}</span>
    </div>
  `).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Comedy Set Analysis — ${date}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f0f13; color: #e8e8f0; min-height: 100vh; padding: 16px; }
  h1 { font-size: 22px; font-weight: 700; color: #fff; margin-bottom: 4px; }
  .date { color: #888; font-size: 14px; margin-bottom: 20px; }
  h2 { font-size: 18px; font-weight: 600; color: #fff; margin: 20px 0 12px; }
  h3 { font-size: 16px; font-weight: 600; color: #ccc; margin: 16px 0 10px; }
  .top-bits { background: #1a1a24; border-radius: 12px; padding: 16px; margin-bottom: 24px; }
  .top-bit { display: flex; align-items: flex-start; gap: 12px; padding: 10px 0; border-bottom: 1px solid #2a2a38; }
  .top-bit:last-child { border-bottom: none; }
  .top-rank { font-size: 20px; font-weight: 700; color: #f0c040; min-width: 32px; text-align: center; padding-top: 2px; }
  .top-bit-name { font-weight: 600; font-size: 15px; }
  .top-bit-set { font-size: 12px; color: #888; margin: 2px 0; }
  .top-bit-punchline { font-size: 13px; color: #aaa; font-style: italic; }
  .top-score { font-size: 20px; font-weight: 700; min-width: 36px; text-align: center; margin-left: auto; padding-top: 2px; border-radius: 8px; padding: 4px 8px; }
  .set-card { background: #1a1a24; border-radius: 12px; padding: 16px; margin-bottom: 20px; }
  .set-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 10px; }
  .set-title { font-size: 15px; font-weight: 700; color: #fff; max-width: 200px; line-height: 1.3; }
  .set-meta { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
  .overall-score { font-size: 28px; font-weight: 700; color: #f0c040; }
  .duration { font-size: 12px; color: #888; }
  .set-summary { font-size: 14px; color: #bbb; margin-bottom: 10px; line-height: 1.5; }
  .strongest { font-size: 13px; color: #88d88a; margin-bottom: 12px; }
  .transcript-toggle { margin-bottom: 12px; }
  .transcript-toggle summary { font-size: 13px; color: #888; cursor: pointer; padding: 6px 0; }
  .transcript { font-size: 13px; color: #999; line-height: 1.6; margin-top: 8px; padding: 10px; background: #12121a; border-radius: 8px; }
  .bits { display: flex; flex-direction: column; gap: 10px; }
  .bit { background: #12121a; border-radius: 10px; padding: 12px; border-left: 3px solid #333; }
  .bit.laughed { border-left-color: #88d88a; }
  .bit-header { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; flex-wrap: wrap; }
  .bit-rank { font-size: 12px; font-weight: 700; color: #888; min-width: 24px; }
  .bit-name { font-size: 14px; font-weight: 600; flex: 1; }
  .bit-score { font-size: 16px; font-weight: 700; padding: 2px 8px; border-radius: 6px; }
  .laugh-badge { font-size: 11px; background: #1e3d1e; color: #88d88a; padding: 2px 6px; border-radius: 10px; }
  .bit-chunk { font-size: 11px; color: #666; margin-bottom: 8px; }
  .bit-lines { font-size: 13px; color: #ccc; margin-bottom: 8px; line-height: 1.5; }
  .setup { margin-bottom: 4px; }
  .punchline { color: #e0e0a0; }
  .bit-feedback { font-size: 13px; color: #aaa; margin-bottom: 8px; font-style: italic; }
  .positives { font-size: 12px; color: #88d88a; margin-bottom: 4px; }
  .improvements { font-size: 12px; color: #d8a840; margin-bottom: 6px; }
  .tags { display: flex; flex-wrap: wrap; gap: 4px; }
  .tag { font-size: 11px; background: #2a2a38; color: #888; padding: 2px 8px; border-radius: 10px; }
  .score-10, .score-9 { background: #1e3d1e; color: #88d88a; }
  .score-8, .score-7 { background: #2a3520; color: #aad860; }
  .score-6, .score-5 { background: #35300a; color: #d8c040; }
  .score-4, .score-3 { background: #35200a; color: #d87040; }
  .score-2, .score-1 { background: #350a0a; color: #d84040; }
</style>
</head>
<body>
<h1>🎤 Comedy Set Analysis</h1>
<div class="date">${date}</div>

<h2>🏆 Top Bits Across Both Sets</h2>
<div class="top-bits">${topBitsHTML}</div>

<h2>📊 Full Set Breakdowns</h2>
${setCards}

<p style="text-align:center;color:#444;font-size:12px;margin-top:24px;padding-bottom:20px">Generated by Comediq.Hear</p>
</body>
</html>`;
}

async function main() {
  const files = [
    { path: "C:/Users/adamm/Downloads/3.26.26 Rodney\u2019s eh Mets\uD83D\uDC4D, 3uncs, jpay eh, tsa eh,\uD83C\uDDEE\uD83C\uDDF7 eh, jewy\uD83D\uDC4D.m4a", label: "Rodney's — Mar 26" },
    { path: "C:/Users/adamm/Downloads/St Mks👨_💼🎪 🚇🚪, 📦🔝, 👀🦜❌🐦_⬛,3 uncs, Jpay kyles.m4a", label: "St. Marks — Mar 26" }
  ];

  const results = [];

  for (const file of files) {
    if (!fs.existsSync(file.path)) {
      console.error(`File not found: ${file.path}`);
      continue;
    }

    try {
      const txData = await transcribeFile(file.path);
      const words = txData.words || [];
      const durationMs = txData.audio_duration ? txData.audio_duration * 1000 : null;
      const durationMins = durationMs ? (durationMs / 60000).toFixed(1) : 'unknown';

      const analysis = await analyzeWithClaude(txData.text, words, durationMins, file.label);
      results.push({ label: file.label, analysis, transcript: txData.text });

      console.log(`\n✅ ${file.label}: Score ${analysis.overallScore}/10 — ${analysis.strongestBit}`);
    } catch (err) {
      console.error(`\n❌ Error processing ${file.label}:`, err.message);
    }
  }

  if (results.length === 0) {
    console.error('No files processed successfully.');
    process.exit(1);
  }

  const outputPath = path.join('C:/Users/adamm/comediq-hear-backend', 'set-analysis.html');
  fs.writeFileSync(outputPath, generateHTML(results));
  console.log(`\n✨ Done! Open this file in your browser (or share to phone):\n${outputPath}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
