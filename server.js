require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

const AAI_KEY = process.env.ASSEMBLYAI_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!AAI_KEY || !ANTHROPIC_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing required environment variables');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Temp storage for uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 }
});

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── GET /sets ──
app.get('/sets', async (req, res) => {
  const { data, error } = await supabase
    .from('sets')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── GET /sets/:id ──
app.get('/sets/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('sets')
    .select('*')
    .eq('id', req.params.id)
    .single();
  if (error) return res.status(404).json({ error: error.message });
  res.json(data);
});

// ── GET /identities/:id/performances ──
app.get('/identities/:id/performances', async (req, res) => {
  const { data, error } = await supabase
    .from('bit_performances')
    .select('*')
    .eq('bit_identity_id', req.params.id)
    .order('performance_date_iso', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// ── GET /sets/:id/bits ──
app.get('/sets/:id/bits', async (req, res) => {
  const { data, error } = await supabase
    .from('bits')
    .select('*, bit_identities(canonical_name, total_performances, avg_analysis_score, avg_user_rating)')
    .eq('set_id', req.params.id)
    .order('timestamp_sec', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── PATCH /bits/:id/rating ── auto-save user rating
app.patch('/bits/:id/rating', async (req, res) => {
  const { user_rating } = req.body;
  const { data, error } = await supabase
    .from('bits')
    .update({ user_rating })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });

  // Also update the bit_performance record
  await supabase
    .from('bit_performances')
    .update({ user_rating })
    .eq('bit_id', req.params.id);

  // Recalculate avg_user_rating for this bit_identity
  if (data.bit_identity_id) {
    await recalcIdentityStats(data.bit_identity_id);
  }

  res.json(data);
});

// ── POST /sets/:id/context ──
app.post('/sets/:id/context', async (req, res) => {
  const { venue, audience, notes, crowd_size, crowd_type } = req.body;
  const context = { venue, audience, notes, crowd_size, crowd_type };
  const { data, error } = await supabase
    .from('sets')
    .update({ context, ...(venue ? { venue } : {}) })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });

  // Update bit_performances with crowd context
  if (crowd_size || crowd_type) {
    await supabase
      .from('bit_performances')
      .update({ crowd_size, crowd_type, audience_notes: notes, context_notes: audience })
      .eq('set_id', req.params.id);
  }

  res.json(data);
});

// ── GET /bits/:id/history ── get all performances of the same joke
app.get('/bits/:id/history', async (req, res) => {
  const { data: bit } = await supabase
    .from('bits')
    .select('bit_identity_id')
    .eq('id', req.params.id)
    .single();

  if (!bit || !bit.bit_identity_id) return res.json([]);

  const { data, error } = await supabase
    .from('bit_performances')
    .select('*, sets(venue, date)')
    .eq('bit_identity_id', bit.bit_identity_id)
    .order('performance_date_iso', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── GET /identities ── all known jokes
app.get('/identities', async (req, res) => {
  const { data, error } = await supabase
    .from('bit_identities')
    .select('*')
    .order('total_performances', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── POST /process ── main pipeline
app.post('/process', upload.single('audio'), async (req, res) => {
  const venue = req.body.venue || 'Open Mic';
  const audioBuffer = req.file.buffer;
  const mimeType = req.file.mimetype || 'audio/mp4';
  const origName = req.file.originalname || '';
  const ext = origName.endsWith('.m4a') ? 'm4a'
    : mimeType.includes('mp4') || mimeType.includes('m4a') ? 'm4a'
    : mimeType.includes('ogg') ? 'ogg'
    : mimeType.includes('webm') ? 'webm'
    : 'mp4';
  const audioFilename = `${Date.now()}.${ext}`;

  try {
    // Step 1: Upload audio to Supabase Storage
    const { data: storageData, error: storageError } = await supabase.storage
      .from('audio')
      .upload(audioFilename, audioBuffer, { contentType: mimeType, upsert: false });

    if (storageError) throw new Error('Storage upload failed: ' + storageError.message);

    const { data: { publicUrl } } = supabase.storage
      .from('audio')
      .getPublicUrl(audioFilename);

    // Step 2: Upload to AssemblyAI
    const aaiUpload = await fetch('https://api.assemblyai.com/v2/upload', {
      method: 'POST',
      headers: { authorization: AAI_KEY, 'content-type': 'application/octet-stream' },
      body: audioBuffer
    });
    if (!aaiUpload.ok) throw new Error('AAI upload failed: ' + aaiUpload.status);
    const { upload_url } = await aaiUpload.json();

    // Step 3: Transcribe
    const txReq = await fetch('https://api.assemblyai.com/v2/transcript', {
      method: 'POST',
      headers: { authorization: AAI_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ audio_url: upload_url, punctuate: true, format_text: true })
    });
    if (!txReq.ok) throw new Error('AAI transcript request failed');
    const { id: txId } = await txReq.json();

    let txData = null;
    for (let i = 0; i < 150; i++) {
      await sleep(3000);
      const poll = await fetch(`https://api.assemblyai.com/v2/transcript/${txId}`, {
        headers: { authorization: AAI_KEY }
      });
      const pd = await poll.json();
      if (pd.status === 'completed') { txData = pd; break; }
      if (pd.status === 'error') throw new Error('Transcription error: ' + pd.error);
    }
    if (!txData) throw new Error('Transcription timed out');

    const transcript = txData.text;
    const words = txData.words || [];
    const durationMs = txData.audio_duration ? txData.audio_duration * 1000 : null;
    const durationMins = durationMs ? (durationMs / 60000).toFixed(1) : 'unknown';

    // Detect pauses > 800ms
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

    // Step 4: Claude analysis
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: `You are a sharp, honest comedy coach analyzing a stand-up set.

VENUE: ${venue}
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

    if (!claudeRes.ok) {
      const e = await claudeRes.json();
      throw new Error('Claude error: ' + JSON.stringify(e));
    }

    const claudeData = await claudeRes.json();
    const analysisText = claudeData.content.map(c => c.text || '').join('');
    const analysis = JSON.parse(analysisText.replace(/```json|```/g, '').trim());

    // Step 5: Save set to Supabase
    const { data: setRow, error: setError } = await supabase
      .from('sets')
      .insert({
        venue,
        date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
        date_iso: new Date().toISOString(),
        duration_sec: durationMs ? durationMs / 1000 : null,
        audio_url: publicUrl,
        transcript,
        overall_score: analysis.overallScore,
        overall_summary: analysis.overallSummary,
        strongest_bit: analysis.strongestBit,
        total_duration: analysis.totalDuration,
        context: {},
        pause_points: pausePoints,
        words: words.map(w => ({ text: w.text, start: w.start, end: w.end }))
      })
      .select()
      .single();

    if (setError) throw new Error('Set insert failed: ' + setError.message);

    // Step 6: Save bits with identity matching
    const allBits = (analysis.chunks || []).flatMap(chunk =>
      (chunk.bits || []).map(b => ({ ...b, chunkName: chunk.name }))
    );

    for (const bit of allBits) {
      // Find or create bit identity by fuzzy name match
      const identityId = await findOrCreateIdentity(bit.name);

      // Insert bit
      const { data: bitRow, error: bitError } = await supabase
        .from('bits')
        .insert({
          set_id: setRow.id,
          bit_identity_id: identityId,
          name: bit.name,
          score: bit.score,
          setup: bit.setup,
          punchline: bit.punchline,
          feedback: bit.feedback,
          tags: bit.tags || [],
          positives: bit.positives || [],
          improvements: bit.improvements || [],
          transcript_excerpt: bit.transcript_excerpt || bit.punchline,
          likely_laughed: bit.likelyLaughed || false,
          timestamp_sec: bit.timestampSec || null,
          pause_duration_ms: bit.pauseDurationMs || null,
          chunk_name: bit.chunkName
        })
        .select()
        .single();

      if (bitError) { console.error('Bit insert error:', bitError.message); continue; }

      // Insert bit performance
      await supabase.from('bit_performances').insert({
        bit_id: bitRow.id,
        bit_identity_id: identityId,
        set_id: setRow.id,
        performance_date: setRow.date,
        performance_date_iso: setRow.date_iso,
        venue,
        analysis_score: bit.score,
        laugh_proxy_score: bit.likelyLaughed ? (bit.pauseDurationMs ? Math.min(10, bit.pauseDurationMs / 200) : 5) : 1,
        likely_laughed: bit.likelyLaughed || false,
        pause_duration_ms: bit.pauseDurationMs || null
      });

      // Recalc identity stats
      await recalcIdentityStats(identityId);
    }

    console.log(`Saved set ${setRow.id} -- ${venue} -- score ${analysis.overallScore}`);

    // Return full set with bits
    const { data: bits } = await supabase
      .from('bits')
      .select('*')
      .eq('set_id', setRow.id)
      .order('timestamp_sec', { ascending: true });

    res.json({ ...setRow, chunks: analysis.chunks, bits });

  } catch (err) {
    console.error('Process error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── HELPERS ──

async function findOrCreateIdentity(bitName) {
  const normalized = bitName.toLowerCase().trim();

  // Get all existing identities and do fuzzy match
  const { data: identities } = await supabase
    .from('bit_identities')
    .select('id, canonical_name, slug');

  if (identities) {
    for (const identity of identities) {
      if (similarity(normalized, identity.canonical_name.toLowerCase()) > 0.75) {
        return identity.id;
      }
    }
  }

  // Create new identity
  const slug = normalized.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const { data: newIdentity } = await supabase
    .from('bit_identities')
    .insert({
      canonical_name: bitName,
      slug: slug + '-' + Date.now(),
      total_performances: 0
    })
    .select()
    .single();

  return newIdentity.id;
}

async function recalcIdentityStats(identityId) {
  const { data: perfs } = await supabase
    .from('bit_performances')
    .select('analysis_score, user_rating, laugh_proxy_score')
    .eq('bit_identity_id', identityId);

  if (!perfs || !perfs.length) return;

  const avg = arr => arr.filter(Boolean).length
    ? arr.filter(Boolean).reduce((a, b) => a + b, 0) / arr.filter(Boolean).length
    : null;

  await supabase.from('bit_identities').update({
    total_performances: perfs.length,
    avg_analysis_score: avg(perfs.map(p => p.analysis_score)),
    avg_user_rating: avg(perfs.map(p => p.user_rating)),
    avg_laugh_proxy: avg(perfs.map(p => p.laugh_proxy_score)),
    best_score: Math.max(...perfs.map(p => p.analysis_score).filter(Boolean)),
    last_performed_at: new Date().toISOString()
  }).eq('id', identityId);
}

// Simple similarity score (Dice coefficient on bigrams)
function similarity(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const getBigrams = str => {
    const bigrams = new Set();
    for (let i = 0; i < str.length - 1; i++) bigrams.add(str[i] + str[i + 1]);
    return bigrams;
  };
  const aB = getBigrams(a), bB = getBigrams(b);
  let intersection = 0;
  aB.forEach(bg => { if (bB.has(bg)) intersection++; });
  return (2.0 * intersection) / (aB.size + bB.size);
}

app.listen(PORT, () => console.log(`Comediq.Hear server running on port ${PORT}`));
