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
    .select('*, bit_identities(canonical_name, total_performances, avg_analysis_score, avg_user_rating, status, latest_confidence)')
    .eq('set_id', req.params.id)
    .order('timestamp_sec', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── PATCH /bits/:id/rating ──
app.patch('/bits/:id/rating', async (req, res) => {
  const { user_rating } = req.body;
  const { data, error } = await supabase
    .from('bits')
    .update({ user_rating })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });

  await supabase
    .from('bit_performances')
    .update({ user_rating })
    .eq('bit_id', req.params.id);

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

  if (crowd_size || crowd_type) {
    await supabase
      .from('bit_performances')
      .update({ crowd_size, crowd_type, audience_notes: notes, context_notes: audience })
      .eq('set_id', req.params.id);
  }

  res.json(data);
});

// ── GET /bits/:id/history ──
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

// ── GET /identities ──
app.get('/identities', async (req, res) => {
  const { data, error } = await supabase
    .from('bit_identities')
    .select('*')
    .order('total_performances', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── DELETE /identities/:id ──
app.delete('/identities/:id', async (req, res) => {
  await supabase.from('bit_performances').delete().eq('bit_identity_id', req.params.id);
  await supabase.from('bits').update({ bit_identity_id: null }).eq('bit_identity_id', req.params.id);
  const { error } = await supabase.from('bit_identities').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── POST /identities/merge ── merge two jokes into one
app.post('/identities/merge', async (req, res) => {
  const { keepId, mergeId } = req.body;
  if (!keepId || !mergeId) return res.status(400).json({ error: 'keepId and mergeId required' });

  // Reassign all bits and performances from mergeId → keepId
  await supabase.from('bits').update({ bit_identity_id: keepId }).eq('bit_identity_id', mergeId);
  await supabase.from('bit_performances').update({ bit_identity_id: keepId }).eq('bit_identity_id', mergeId);

  // Delete the merged identity
  await supabase.from('bit_identities').delete().eq('id', mergeId);

  // Recalc stats for the keeper
  await recalcIdentityStats(keepId);

  const { data, error } = await supabase.from('bit_identities').select('*').eq('id', keepId).single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── DELETE /sets/:id ──
app.delete('/sets/:id', async (req, res) => {
  const { error } = await supabase.from('sets').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── PATCH /identities/:id ──
app.patch('/identities/:id', async (req, res) => {
  const { status, written_text, latest_confidence } = req.body;
  const updates = {};
  if (status !== undefined) updates.status = status;
  if (written_text !== undefined) updates.written_text = written_text;
  if (latest_confidence !== undefined) updates.latest_confidence = latest_confidence;

  const { data, error } = await supabase
    .from('bit_identities')
    .update(updates)
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── POST /identities/:id/confidence ──
app.post('/identities/:id/confidence', async (req, res) => {
  const { score } = req.body;
  if (score === undefined) return res.status(400).json({ error: 'score required' });

  const { data: identity, error: fetchErr } = await supabase
    .from('bit_identities')
    .select('confidence_history')
    .eq('id', req.params.id)
    .single();
  if (fetchErr) return res.status(404).json({ error: fetchErr.message });

  const history = identity.confidence_history || [];
  history.push({ score, timestamp: new Date().toISOString() });

  const { data, error } = await supabase
    .from('bit_identities')
    .update({ confidence_history: history, latest_confidence: score })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── GET /quick-notes ──
app.get('/quick-notes', async (req, res) => {
  const { data, error } = await supabase
    .from('quick_notes')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── POST /quick-notes ──
app.post('/quick-notes', async (req, res) => {
  const { text, captured_during_set, set_id } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });
  const { data, error } = await supabase
    .from('quick_notes')
    .insert({ text, captured_during_set: captured_during_set || false, set_id: set_id || null })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── PATCH /quick-notes/:id ──
app.patch('/quick-notes/:id', async (req, res) => {
  const { processed, text } = req.body;
  const updates = {};
  if (processed !== undefined) updates.processed = processed;
  if (text !== undefined) updates.text = text;
  const { data, error } = await supabase
    .from('quick_notes')
    .update(updates)
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── DELETE /quick-notes/:id ──
app.delete('/quick-notes/:id', async (req, res) => {
  const { error } = await supabase
    .from('quick_notes')
    .delete()
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── GET /set-plans ──
app.get('/set-plans', async (req, res) => {
  const { data, error } = await supabase
    .from('set_plans')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── POST /set-plans ──
app.post('/set-plans', async (req, res) => {
  const { name, items } = req.body;
  const { data, error } = await supabase
    .from('set_plans')
    .insert({ name: name || 'Set Plan', items: items || [] })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── GET /set-plans/:id ──
app.get('/set-plans/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('set_plans')
    .select('*')
    .eq('id', req.params.id)
    .single();
  if (error) return res.status(404).json({ error: error.message });
  res.json(data);
});

// ── PATCH /set-plans/:id ──
app.patch('/set-plans/:id', async (req, res) => {
  const { name, items, used_in_set_id } = req.body;
  const updates = {};
  if (name !== undefined) updates.name = name;
  if (items !== undefined) updates.items = items;
  if (used_in_set_id !== undefined) updates.used_in_set_id = used_in_set_id;
  const { data, error } = await supabase
    .from('set_plans')
    .update(updates)
    .eq('id', req.params.id)
    .select()
    .single();
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
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        messages: [{
          role: 'user',
          content: `You are a sharp, honest comedy writing analyst and coach analyzing a stand-up set.

VENUE: ${venue}
DURATION: ${durationMins} minutes

FULL TRANSCRIPT:
"""${transcript}"""

SIGNIFICANT PAUSES (gaps > 800ms -- likely laugh or reaction moments):
${pauseSummary || 'No significant pauses detected'}

Analyze this set thoroughly. Group bits into thematic chunks. Use pause data to determine if a punchline likely got a laugh.

For each bit, also identify:
- Tags that were added ON STAGE that made the bit FUNNIER (tagType: "funny")
- Tags that were added ON STAGE that were FLUFF with no payoff (tagType: "fluff")
- Any deviation between what was likely written vs. what was actually said on stage (tagType: "said_on_stage")

Detect comedy techniques: callbacks, impressions, rule_of_threes, misdirection, crowd_work, act_out, tag, topper, blue_material, self_deprecation, observational, physical, one_liner.

Return ONLY valid JSON, no markdown:
{
  "overallScore": <1-10 one decimal>,
  "overallSummary": "<2 honest coaching sentences>",
  "strongestBit": "<best bit name>",
  "totalDuration": "${durationMins} min",
  "topicSummary": "<2-3 sentences describing the themes and subjects covered in this set>",
  "audienceReception": "<one of: great|good|mixed|tough — based on laugh frequency and pause patterns>",
  "setTopics": ["<broad topic name>"],
  "metrics": {
    "totalWords": <count>,
    "totalJokes": <count>,
    "totalTopics": <count>,
    "totalSegues": <count>,
    "laughsDetected": <count based on pause data>,
    "laughsPerMinute": <float one decimal>,
    "longestGapBetweenLaughs_sec": <float>,
    "techniquesUsed": ["<technique>"]
  },
  "chunks": [
    {
      "name": "<theme name 2-5 words>",
      "score": <1-10 avg of bits in this chunk>,
      "topics": ["<topic tag>"],
      "startSec": <seconds into recording where this chunk begins or null>,
      "endSec": <seconds into recording where this chunk ends or null>,
      "bits": [
        {
          "name": "<bit name 3-6 words>",
          "score": <1-10>,
          "setup": "<setup line>",
          "punchline": "<punchline — the exact payoff line>",
          "feedback": "<1-2 sentences coaching>",
          "tags": [
            { "text": "<tag text>", "tagType": "funny|fluff|said_on_stage" }
          ],
          "positives": ["<what worked 5 words>"],
          "improvements": ["<fix 6 words>"],
          "likelyLaughed": <true/false>,
          "timestampSec": <seconds or null>,
          "pauseDurationMs": <ms of pause after punchline or null>,
          "topics": ["<topic tag>"]
        }
      ]
    }
  ]
}

setTopics should be 3-8 broad thematic labels (e.g. "dating", "work", "family", "technology", "self-deprecation").
Each chunk.topics and bit.topics should be a subset of setTopics.`
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
    const totalLaughCount = pausePoints.length;
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
        topic_summary: analysis.topicSummary || null,
        audience_reception: analysis.audienceReception || null,
        set_topics: analysis.setTopics || [],
        total_laugh_count: totalLaughCount,
        context: {},
        pause_points: pausePoints,
        words: words.map(w => ({ text: w.text, start: w.start, end: w.end })),
        laugh_data: analysis.metrics || {}
      })
      .select()
      .single();

    if (setError) throw new Error('Set insert failed: ' + setError.message);

    // Step 6a: Save chunks and build name → DB id map
    const chunkIdMap = {}; // chunkName → uuid
    for (const [idx, chunk] of (analysis.chunks || []).entries()) {
      const chunkBits = chunk.bits || [];
      const scores = chunkBits.map(b => b.score).filter(Boolean);
      const chunkScore = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;

      const { data: chunkRow, error: chunkErr } = await supabase
        .from('chunks')
        .insert({
          set_id: setRow.id,
          name: chunk.name,
          position_order: idx + 1,
          start_sec: chunk.startSec || null,
          end_sec: chunk.endSec || null,
          overall_score: chunkScore ? parseFloat(chunkScore.toFixed(1)) : null,
          laugh_count: chunkBits.filter(b => b.likelyLaughed).length,
          bit_count: chunkBits.length,
          topics: chunk.topics || []
        })
        .select()
        .single();

      if (!chunkErr && chunkRow) chunkIdMap[chunk.name] = chunkRow.id;
      else if (chunkErr) console.error('Chunk insert error:', chunkErr.message);
    }

    // Step 6b: Upsert topics and build name → DB id map
    const topicIdMap = {}; // topicName → uuid
    for (const topicName of (analysis.setTopics || [])) {
      const topicId = await findOrCreateTopic(topicName);
      topicIdMap[topicName] = topicId;
      // Link topic to this set
      await supabase.from('set_topics')
        .upsert({ set_id: setRow.id, topic_id: topicId });
    }

    // Step 6c: Save bits with identity + chunk + topic linking
    const allBits = (analysis.chunks || []).flatMap(chunk =>
      (chunk.bits || []).map(b => ({
        ...b,
        chunkName: chunk.name,
        chunkId: chunkIdMap[chunk.name] || null,
        bitTopics: b.topics || chunk.topics || []
      }))
    );

    for (const bit of allBits) {
      const identityId = await findOrCreateIdentity(bit.name);

      // Normalize tags: support both old string[] and new [{text, tagType}] formats
      const normalizedTags = (bit.tags || []).map(t =>
        typeof t === 'string' ? { text: t, tagType: 'said_on_stage' } : t
      );
      const tagStrings = normalizedTags.map(t => t.text);

      const { data: bitRow, error: bitError } = await supabase
        .from('bits')
        .insert({
          set_id: setRow.id,
          bit_identity_id: identityId,
          chunk_id: bit.chunkId,
          name: bit.name,
          score: bit.score,
          setup: bit.setup,
          punchline: bit.punchline,
          feedback: bit.feedback,
          tags: tagStrings,
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

      await recalcIdentityStats(identityId);

      // Link this bit identity to its topics
      for (const topicName of bit.bitTopics) {
        const topicId = topicIdMap[topicName] || await findOrCreateTopic(topicName);
        if (topicId) {
          await supabase.from('bit_topics')
            .upsert({ bit_identity_id: identityId, topic_id: topicId });
        }
      }
    }

    // Step 6d: Recalc stats for all topics touched in this set
    for (const topicId of Object.values(topicIdMap)) {
      await recalcTopicStats(topicId);
    }

    // Auto-retire jokes not performed in 30+ days
    await autoRetireStaleJokes();

    console.log(`Saved set ${setRow.id} -- ${venue} -- score ${analysis.overallScore} -- ${totalLaughCount} laughs`);

    const [{ data: bits }, { data: savedChunks }] = await Promise.all([
      supabase.from('bits').select('*').eq('set_id', setRow.id).order('timestamp_sec', { ascending: true }),
      supabase.from('chunks').select('*').eq('set_id', setRow.id).order('position_order', { ascending: true })
    ]);

    res.json({
      ...setRow,
      topic_summary: analysis.topicSummary,
      audience_reception: analysis.audienceReception,
      set_topics: analysis.setTopics || [],
      total_laugh_count: totalLaughCount,
      chunks: savedChunks || [],
      metrics: analysis.metrics,
      bits: bits || []
    });

  } catch (err) {
    console.error('Process error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── SET LOGGING ──

// PATCH /sets/:id/log
// Post-show reflection: confidence, personal notes, audience reception.
// Call this from the mobile app after the comedian has had a moment to reflect.
app.patch('/sets/:id/log', async (req, res) => {
  const { confidence_rating, personal_notes, audience_reception } = req.body;
  const updates = {};
  if (confidence_rating !== undefined) updates.confidence_rating = confidence_rating;
  if (personal_notes !== undefined) updates.personal_notes = personal_notes;
  if (audience_reception !== undefined) updates.audience_reception = audience_reception;

  const { data, error } = await supabase
    .from('sets')
    .update(updates)
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// PATCH /bits/:id/notes
// Per-bit personal notes for this specific performance (e.g. "crowd was cold here",
// "forgot the callback", "nailed the act-out"). Distinct from user_rating.
app.patch('/bits/:id/notes', async (req, res) => {
  const { personal_notes } = req.body;
  if (personal_notes === undefined) return res.status(400).json({ error: 'personal_notes required' });

  const { data, error } = await supabase
    .from('bits')
    .update({ personal_notes })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── HIERARCHY READ ENDPOINTS ──

// GET /sets/:id/full
// Full structured breakdown of a set: metadata → chunks → bits (nested).
// Also includes set-level laugh stats and topic list.
app.get('/sets/:id/full', async (req, res) => {
  const id = req.params.id;

  const [
    { data: set, error: setErr },
    { data: chunks, error: chunksErr },
    { data: bits, error: bitsErr },
    { data: setTopicLinks }
  ] = await Promise.all([
    supabase.from('sets').select('*').eq('id', id).single(),
    supabase.from('chunks').select('*').eq('set_id', id).order('position_order', { ascending: true }),
    supabase.from('bits').select('*, bit_identities(canonical_name, total_performances, avg_analysis_score, avg_user_rating, avg_laugh_proxy, status, latest_confidence)')
      .eq('set_id', id).order('timestamp_sec', { ascending: true }),
    supabase.from('set_topics').select('topic_id, topics(id, name, avg_score, total_performances)').eq('set_id', id)
  ]);

  if (setErr) return res.status(404).json({ error: setErr.message });
  if (chunksErr || bitsErr) return res.status(500).json({ error: (chunksErr || bitsErr).message });

  // Nest bits inside their chunk
  const bitsForChunk = (chunkId) =>
    (bits || []).filter(b => b.chunk_id === chunkId);

  // Bits not yet assigned to a chunk (legacy or unmatched)
  const unassignedBits = (bits || []).filter(b => !b.chunk_id);

  const fullChunks = (chunks || []).map(chunk => ({
    ...chunk,
    bits: bitsForChunk(chunk.id)
  }));

  // Set-level laugh stats derived from pause_points
  const pausePoints = Array.isArray(set.pause_points) ? set.pause_points : [];
  const laughsByMinute = {};
  pausePoints.forEach(p => {
    const min = Math.floor((p.after_time_ms || 0) / 60000);
    laughsByMinute[min] = (laughsByMinute[min] || 0) + 1;
  });

  res.json({
    ...set,
    chunks: fullChunks,
    unassigned_bits: unassignedBits,
    topics: (setTopicLinks || []).map(l => l.topics).filter(Boolean),
    laugh_timeline: laughsByMinute,
    laugh_distribution: {
      total: set.total_laugh_count || pausePoints.length,
      per_minute: set.duration_sec
        ? parseFloat(((set.total_laugh_count || pausePoints.length) / (set.duration_sec / 60)).toFixed(1))
        : null
    }
  });
});

// GET /sets/:id/chunks
// Lightweight list of chunks for a set (without nested bits).
app.get('/sets/:id/chunks', async (req, res) => {
  const { data, error } = await supabase
    .from('chunks')
    .select('*')
    .eq('set_id', req.params.id)
    .order('position_order', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// GET /chunks/:id
// Single chunk with its bits and identity data.
app.get('/chunks/:id', async (req, res) => {
  const [{ data: chunk, error: chunkErr }, { data: bits, error: bitsErr }] = await Promise.all([
    supabase.from('chunks').select('*, sets(venue, date, overall_score, audience_reception)').eq('id', req.params.id).single(),
    supabase.from('bits').select('*, bit_identities(canonical_name, total_performances, avg_analysis_score, avg_user_rating, status)')
      .eq('chunk_id', req.params.id).order('timestamp_sec', { ascending: true })
  ]);
  if (chunkErr) return res.status(404).json({ error: chunkErr.message });
  if (bitsErr) return res.status(500).json({ error: bitsErr.message });
  res.json({ ...chunk, bits: bits || [] });
});

// GET /topics
// All topics ordered by avg_score desc.
app.get('/topics', async (req, res) => {
  const { data, error } = await supabase
    .from('topics')
    .select('*')
    .order('avg_score', { ascending: false, nullsLast: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// GET /topics/:id
// Topic detail with all bit identities linked to it (and their stats).
app.get('/topics/:id', async (req, res) => {
  const [{ data: topic, error: topicErr }, { data: bitLinks, error: linksErr }] = await Promise.all([
    supabase.from('topics').select('*').eq('id', req.params.id).single(),
    supabase.from('bit_topics')
      .select('bit_identity_id, bit_identities(id, canonical_name, total_performances, avg_analysis_score, avg_user_rating, avg_laugh_proxy, best_score, status, last_performed_at)')
      .eq('topic_id', req.params.id)
  ]);
  if (topicErr) return res.status(404).json({ error: topicErr.message });
  if (linksErr) return res.status(500).json({ error: linksErr.message });

  const bits = (bitLinks || []).map(l => l.bit_identities).filter(Boolean);
  // Sort by avg score desc
  bits.sort((a, b) => (b.avg_analysis_score || 0) - (a.avg_analysis_score || 0));

  res.json({ ...topic, bits });
});

// PATCH /topics/:id
// Update topic name or description.
app.patch('/topics/:id', async (req, res) => {
  const { name, description } = req.body;
  const updates = {};
  if (name !== undefined) {
    updates.name = name;
    updates.slug = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + Date.now();
  }
  if (description !== undefined) updates.description = description;

  const { data, error } = await supabase
    .from('topics')
    .update(updates)
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// DELETE /topics/:id
app.delete('/topics/:id', async (req, res) => {
  await supabase.from('bit_topics').delete().eq('topic_id', req.params.id);
  await supabase.from('set_topics').delete().eq('topic_id', req.params.id);
  const { error } = await supabase.from('topics').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── IN-APP REVIEW ──
//
// The mobile app calls these endpoints to decide when to show the native
// review prompt and to persist the outcome so we never over-ask.
//
// Rules enforced here (not in the client) so they survive app reinstalls:
//   1. Only prompt at set-count milestones: 5, 10, 20  (REVIEW_MILESTONES)
//   2. Never prompt more than 3 times per calendar year (MAX_REQUESTS_PER_YEAR)
//   3. Stop prompting once the user has already left a review
//
// All state lives in a single "singleton" row in the review_state table.

const REVIEW_MILESTONES = [5, 10, 20];
const MAX_REQUESTS_PER_YEAR = 3;

// Returns the review_state singleton, creating it if it doesn't exist yet.
async function getReviewState() {
  const { data, error } = await supabase
    .from('review_state')
    .select('*')
    .eq('id', 'singleton')
    .maybeSingle();

  if (error) throw new Error(error.message);

  if (!data) {
    const { data: created, error: createErr } = await supabase
      .from('review_state')
      .insert({ id: 'singleton' })
      .select()
      .single();
    if (createErr) throw new Error(createErr.message);
    return created;
  }

  return data;
}

// ── GET /review/status ──
// Call after each set is processed.  Returns { eligible, reason, sets_count }.
// The mobile app should only show the prompt when eligible === true.
app.get('/review/status', async (req, res) => {
  try {
    // Count how many sets the user has recorded.
    const { count, error: countErr } = await supabase
      .from('sets')
      .select('id', { count: 'exact', head: true });
    if (countErr) return res.status(500).json({ error: countErr.message });

    const setsCount = count || 0;

    // Only eligible at the specific milestone numbers.
    if (!REVIEW_MILESTONES.includes(setsCount)) {
      return res.json({ eligible: false, reason: 'not_a_milestone', sets_count: setsCount });
    }

    const state = await getReviewState();

    if (state.review_completed) {
      return res.json({ eligible: false, reason: 'already_reviewed', sets_count: setsCount });
    }

    // Count requests made in the current calendar year.
    const thisYear = new Date().getFullYear();
    const timestamps = Array.isArray(state.request_timestamps) ? state.request_timestamps : [];
    const requestsThisYear = timestamps.filter(ts => new Date(ts).getFullYear() === thisYear).length;

    if (requestsThisYear >= MAX_REQUESTS_PER_YEAR) {
      return res.json({ eligible: false, reason: 'rate_limited', sets_count: setsCount });
    }

    // Check we haven't already prompted at this exact milestone.
    // We compare the number of past requests to the milestone index so each
    // milestone can only fire once regardless of year resets.
    const milestoneIndex = REVIEW_MILESTONES.indexOf(setsCount);
    if (timestamps.length > milestoneIndex) {
      return res.json({ eligible: false, reason: 'milestone_used', sets_count: setsCount });
    }

    res.json({ eligible: true, reason: 'ok', sets_count: setsCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /review/requested ──
// Call immediately after the native review prompt is shown (or the fallback
// deep-link is opened).  Logs the timestamp so we can enforce rate limiting.
app.post('/review/requested', async (req, res) => {
  try {
    const state = await getReviewState();
    const timestamps = Array.isArray(state.request_timestamps) ? state.request_timestamps : [];
    timestamps.push(new Date().toISOString());

    const { error } = await supabase
      .from('review_state')
      .update({ request_timestamps: timestamps })
      .eq('id', 'singleton');

    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, total_requests: timestamps.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /review/completed ──
// Call when you have a strong signal the user left a review (e.g. they tapped
// "Rate" in your own UI before the native sheet, or returned from the Store).
// Once set, /review/status will never return eligible again.
app.post('/review/completed', async (req, res) => {
  try {
    const { error } = await supabase
      .from('review_state')
      .update({
        review_completed: true,
        review_completed_at: new Date().toISOString()
      })
      .eq('id', 'singleton');

    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── HELPERS ──

async function findOrCreateIdentity(bitName) {
  const normalized = bitName.toLowerCase().trim();

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

  const slug = normalized.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const { data: newIdentity } = await supabase
    .from('bit_identities')
    .insert({
      canonical_name: bitName,
      slug: slug + '-' + Date.now(),
      total_performances: 0,
      status: 'premise'
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

async function autoRetireStaleJokes() {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  await supabase
    .from('bit_identities')
    .update({ status: 'retired' })
    .lt('last_performed_at', thirtyDaysAgo)
    .not('status', 'in', '("retired","shelved")');
}

// Find or create a topic by name, deduplicating via slug + Dice similarity.
async function findOrCreateTopic(topicName) {
  const normalized = topicName.toLowerCase().trim();
  const slug = normalized.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  // Exact slug match
  const { data: existing } = await supabase
    .from('topics')
    .select('id')
    .eq('slug', slug)
    .maybeSingle();
  if (existing) return existing.id;

  // Fuzzy name match
  const { data: allTopics } = await supabase.from('topics').select('id, name');
  if (allTopics) {
    for (const t of allTopics) {
      if (similarity(normalized, t.name.toLowerCase()) > 0.8) return t.id;
    }
  }

  // Create new
  const { data: newTopic, error } = await supabase
    .from('topics')
    .insert({ name: topicName, slug: `${slug}-${Date.now()}` })
    .select()
    .single();
  if (error) { console.error('Topic create error:', error.message); return null; }
  return newTopic.id;
}

// Recalculate aggregate stats for a topic from its linked bit performances.
async function recalcTopicStats(topicId) {
  const [{ data: setLinks }, { data: bitLinks }] = await Promise.all([
    supabase.from('set_topics').select('set_id').eq('topic_id', topicId),
    supabase.from('bit_topics').select('bit_identity_id').eq('topic_id', topicId)
  ]);

  const totalPerformances = setLinks ? setLinks.length : 0;

  if (!bitLinks || !bitLinks.length) {
    await supabase.from('topics').update({ total_performances: totalPerformances }).eq('id', topicId);
    return;
  }

  const identityIds = bitLinks.map(l => l.bit_identity_id);
  const { data: perfs } = await supabase
    .from('bit_performances')
    .select('analysis_score, performance_date_iso')
    .in('bit_identity_id', identityIds);

  if (!perfs || !perfs.length) return;

  const scores = perfs.map(p => p.analysis_score).filter(Boolean);
  const avgScore = scores.length ? parseFloat((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2)) : null;
  const bestScore = scores.length ? Math.max(...scores) : null;
  const lastPerformed = perfs.reduce((latest, p) =>
    (p.performance_date_iso || '') > (latest || '') ? p.performance_date_iso : latest, null);

  await supabase.from('topics').update({
    total_performances: totalPerformances,
    avg_score: avgScore,
    best_score: bestScore,
    last_performed_at: lastPerformed
  }).eq('id', topicId);
}

// Simple Dice coefficient on bigrams
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
