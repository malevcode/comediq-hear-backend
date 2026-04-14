require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { randomUUID } = require('crypto');

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

// ── BATCH JOB QUEUE ──
// Supabase is the source of truth (survives server restarts).
// jobQueue is an in-memory work list that gets rebuilt on startup.
const MAX_CONCURRENT_JOBS = parseInt(process.env.BATCH_CONCURRENCY || '5', 10);
const jobQueue = []; // array of batch_job UUIDs waiting to be picked up
let activeWorkers = 0;

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

// ── POST /identities ── create a new bit manually
app.post('/identities', async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const slug = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + Date.now();
  const { data, error } = await supabase
    .from('bit_identities')
    .insert({ canonical_name: name, slug, status: 'being_written', total_performances: 0 })
    .select().single();
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

// ── POST /process ── single file, synchronous (real-time recording → immediate result)
app.post('/process', upload.single('audio'), async (req, res) => {
  const venue = req.body.venue || 'Open Mic';
  try {
    const audioUrl = await uploadToSupabase(req.file.buffer, req.file.mimetype || 'audio/mp4', req.file.originalname || '');
    const result = await runPipeline(audioUrl, venue, new Date());
    res.json(result);
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

// ── BATCH UPLOAD ──

// POST /upload-batch
// Accept up to 20 audio files per request. Files are immediately uploaded to
// Supabase Storage and queued for overnight processing. Clients may call this
// multiple times with the same batch_id to stream a large library in chunks.
//
// Multipart fields:
//   audio[]         — audio files
//   batch_id        — (optional) reuse an existing batch
//   venue           — default venue for all files in this request
//   metadata        — JSON string: { defaultVenue, files: { "<name>": { venue, date_override } } }
app.post('/upload-batch', upload.array('audio', 20), async (req, res) => {
  if (!req.files || !req.files.length) {
    return res.status(400).json({ error: 'No audio files provided' });
  }

  let metadata = {};
  try { if (req.body.metadata) metadata = JSON.parse(req.body.metadata); } catch {}

  const batchId = req.body.batch_id || randomUUID();
  const defaultVenue = metadata.defaultVenue || metadata.venue || req.body.venue || 'Open Mic';
  const fileMetadata = metadata.files || {};

  const results = [];

  for (const file of req.files) {
    try {
      // Upload audio to Supabase Storage immediately — frees memory and gives us
      // a durable URL that AssemblyAI can pull from during overnight processing.
      const audioUrl = await uploadToSupabase(file.buffer, file.mimetype || 'audio/mp4', file.originalname);

      const perFile = fileMetadata[file.originalname] || {};
      const venue = perFile.venue || defaultVenue;
      const dateOverride = perFile.date_override || null;
      const detectedDate = parseDateFromFilename(file.originalname);

      const jobId = randomUUID();
      const { error: insertErr } = await supabase.from('batch_jobs').insert({
        id: jobId,
        batch_id: batchId,
        filename: file.originalname,
        audio_url: audioUrl,
        status: 'queued',
        venue,
        date_override: dateOverride,
        detected_date: detectedDate,
        retry_count: 0
      });

      if (insertErr) throw new Error(insertErr.message);

      jobQueue.push(jobId);
      results.push({ id: jobId, filename: file.originalname, venue, detected_date: detectedDate, status: 'queued' });
    } catch (err) {
      console.error(`Failed to queue ${file.originalname}:`, err.message);
      results.push({ filename: file.originalname, status: 'failed_to_queue', error: err.message });
    }
  }

  drainQueue();

  const queued = results.filter(r => r.status === 'queued').length;
  const failed = results.filter(r => r.status === 'failed_to_queue').length;

  res.json({
    batch_id: batchId,
    total: results.length,
    queued,
    failed_to_queue: failed,
    active_workers: activeWorkers,
    max_workers: MAX_CONCURRENT_JOBS,
    status_url: `/batches/${batchId}`,
    jobs: results
  });
});

// GET /batches/:id
// Batch progress dashboard. Poll this to track overnight processing.
// Returns aggregate stats plus per-job status list.
app.get('/batches/:id', async (req, res) => {
  const { data: jobs, error } = await supabase
    .from('batch_jobs')
    .select('id, filename, status, stage, set_id, error, venue, detected_date, retry_count, created_at, updated_at, started_at, completed_at')
    .eq('batch_id', req.params.id)
    .order('created_at', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  if (!jobs || !jobs.length) return res.status(404).json({ error: 'Batch not found' });

  const counts = { queued: 0, processing: 0, done: 0, error: 0, cancelled: 0 };
  for (const j of jobs) counts[j.status] = (counts[j.status] || 0) + 1;

  const total = jobs.length;
  const progress_pct = Math.round((counts.done / total) * 100);
  // Rough estimate: each remaining job takes ~2.5 min at current concurrency
  const remaining = counts.queued + counts.processing;
  const estimated_remaining_min = remaining > 0
    ? Math.ceil((remaining / MAX_CONCURRENT_JOBS) * 2.5)
    : 0;

  res.json({
    batch_id: req.params.id,
    total,
    ...counts,
    progress_pct,
    estimated_remaining_min,
    active_workers: activeWorkers,
    max_workers: MAX_CONCURRENT_JOBS,
    jobs
  });
});

// DELETE /batches/:id
// Cancel all queued jobs in a batch (running jobs are not interrupted).
app.delete('/batches/:id', async (req, res) => {
  const { data: queued, error } = await supabase
    .from('batch_jobs')
    .select('id')
    .eq('batch_id', req.params.id)
    .eq('status', 'queued');

  if (error) return res.status(500).json({ error: error.message });

  if (queued && queued.length) {
    await supabase.from('batch_jobs')
      .update({ status: 'cancelled' })
      .eq('batch_id', req.params.id)
      .eq('status', 'queued');

    // Purge from in-memory work list
    const ids = new Set(queued.map(j => j.id));
    for (let i = jobQueue.length - 1; i >= 0; i--) {
      if (ids.has(jobQueue[i])) jobQueue.splice(i, 1);
    }
  }

  res.json({ ok: true, cancelled: queued ? queued.length : 0 });
});

// GET /jobs
// List batch jobs. Query params: batch_id, status, limit (default 100), offset (default 0).
app.get('/jobs', async (req, res) => {
  const { batch_id, status, limit = '100', offset = '0' } = req.query;
  const lim = Math.min(parseInt(limit, 10) || 100, 500);
  const off = parseInt(offset, 10) || 0;

  let query = supabase
    .from('batch_jobs')
    .select('id, batch_id, filename, status, stage, set_id, error, venue, detected_date, retry_count, created_at, updated_at, completed_at')
    .order('created_at', { ascending: false })
    .range(off, off + lim - 1);

  if (batch_id) query = query.eq('batch_id', batch_id);
  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// GET /jobs/:id
app.get('/jobs/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('batch_jobs')
    .select('*')
    .eq('id', req.params.id)
    .single();
  if (error) return res.status(404).json({ error: error.message });
  res.json(data);
});

// DELETE /jobs/:id — cancel a single queued job
app.delete('/jobs/:id', async (req, res) => {
  const { data: job, error: fetchErr } = await supabase
    .from('batch_jobs')
    .select('status')
    .eq('id', req.params.id)
    .single();

  if (fetchErr) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'queued') {
    return res.status(409).json({ error: `Cannot cancel job in status: ${job.status}` });
  }

  await supabase.from('batch_jobs')
    .update({ status: 'cancelled' })
    .eq('id', req.params.id);

  const idx = jobQueue.indexOf(req.params.id);
  if (idx > -1) jobQueue.splice(idx, 1);

  res.json({ ok: true });
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

// ── UPLOAD TO SUPABASE ──
// Upload an audio buffer to Supabase Storage and return the public URL.
// We use this URL as the source for AssemblyAI so the audio buffer is
// only held in memory once (during the upload), then freed.
async function uploadToSupabase(buffer, mimeType, origName) {
  const ext = (origName || '').endsWith('.m4a') ? 'm4a'
    : mimeType.includes('mp4') || mimeType.includes('m4a') ? 'm4a'
    : mimeType.includes('ogg') ? 'ogg'
    : mimeType.includes('webm') ? 'webm'
    : 'mp4';
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

  const { error } = await supabase.storage
    .from('audio')
    .upload(filename, buffer, { contentType: mimeType, upsert: false });
  if (error) throw new Error('Storage upload failed: ' + error.message);

  const { data: { publicUrl } } = supabase.storage.from('audio').getPublicUrl(filename);
  return publicUrl;
}

// ── PARSE DATE FROM FILENAME ──
// Voice Memo files often have dates in their names:
//   "Voice Memo 2024-03-15.m4a", "Recording 2024-01-08 at 10.30.m4a"
// Returns an ISO date string (YYYY-MM-DD) or null if not found.
function parseDateFromFilename(filename) {
  const iso = filename.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const d = new Date(`${iso[1]}-${iso[2]}-${iso[3]}T12:00:00`);
    if (!isNaN(d)) return d.toISOString().split('T')[0];
  }
  const us = filename.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (us) {
    const d = new Date(`${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}T12:00:00`);
    if (!isNaN(d)) return d.toISOString().split('T')[0];
  }
  return null;
}

// ── CORE PIPELINE ──
// Processes a single set from a Supabase Storage URL.
// AssemblyAI fetches the audio directly — no second upload needed.
// setDate: the Date to stamp as the performance date (defaults to now).
// onStage: optional progress callback(stage) used by the batch worker.
async function runPipeline(audioUrl, venue, setDate, onStage = () => {}) {
  const now = (setDate instanceof Date && !isNaN(setDate)) ? setDate : new Date();

  // Step 1: Request transcription — AssemblyAI pulls audio from Supabase URL
  onStage('transcribing');
  const txReq = await fetch('https://api.assemblyai.com/v2/transcript', {
    method: 'POST',
    headers: { authorization: AAI_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ audio_url: audioUrl, punctuate: true, format_text: true })
  });
  if (!txReq.ok) throw new Error('AAI transcript request failed: ' + txReq.status);
  const { id: txId } = await txReq.json();

  // Poll up to 400 × 3s = 20 min (handles recordings up to ~90 min of audio)
  let txData = null;
  for (let i = 0; i < 400; i++) {
    await sleep(3000);
    const poll = await fetch(`https://api.assemblyai.com/v2/transcript/${txId}`, {
      headers: { authorization: AAI_KEY }
    });
    const pd = await poll.json();
    if (pd.status === 'completed') { txData = pd; break; }
    if (pd.status === 'error') throw new Error('Transcription error: ' + pd.error);
  }
  if (!txData) throw new Error('Transcription timed out after 20 minutes');

  const transcript = txData.text;
  const words = txData.words || [];
  const durationMs = txData.audio_duration ? txData.audio_duration * 1000 : null;
  const durationMins = durationMs ? (durationMs / 60000).toFixed(1) : 'unknown';

  // Detect pauses > 800ms (laugh proxy)
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

  // Step 2: Claude analysis
  onStage('analyzing');
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

  // Step 3: Save to Supabase
  onStage('saving');
  const totalLaughCount = pausePoints.length;
  const { data: setRow, error: setError } = await supabase
    .from('sets')
    .insert({
      venue,
      date: now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      date_iso: now.toISOString(),
      duration_sec: durationMs ? durationMs / 1000 : null,
      audio_url: audioUrl,
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

  // Save chunks
  const chunkIdMap = {};
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

  // Upsert topics
  const topicIdMap = {};
  for (const topicName of (analysis.setTopics || [])) {
    const topicId = await findOrCreateTopic(topicName);
    topicIdMap[topicName] = topicId;
    await supabase.from('set_topics').upsert({ set_id: setRow.id, topic_id: topicId });
  }

  // Save bits with identity + chunk + topic linking
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

    for (const topicName of bit.bitTopics) {
      const topicId = topicIdMap[topicName] || await findOrCreateTopic(topicName);
      if (topicId) {
        await supabase.from('bit_topics').upsert({ bit_identity_id: identityId, topic_id: topicId });
      }
    }
  }

  // Recalc topic stats
  for (const topicId of Object.values(topicIdMap)) {
    await recalcTopicStats(topicId);
  }

  await autoRetireStaleJokes();

  console.log(`[pipeline] ${setRow.id} | ${venue} | score ${analysis.overallScore} | ${totalLaughCount} laughs | ${now.toISOString().split('T')[0]}`);

  const [{ data: bits }, { data: savedChunks }] = await Promise.all([
    supabase.from('bits').select('*').eq('set_id', setRow.id).order('timestamp_sec', { ascending: true }),
    supabase.from('chunks').select('*').eq('set_id', setRow.id).order('position_order', { ascending: true })
  ]);

  return {
    ...setRow,
    topic_summary: analysis.topicSummary,
    audience_reception: analysis.audienceReception,
    set_topics: analysis.setTopics || [],
    total_laugh_count: totalLaughCount,
    chunks: savedChunks || [],
    metrics: analysis.metrics,
    bits: bits || []
  };
}

// ── BATCH QUEUE WORKER ──

// Pull the next job off the queue and process it. Retries up to 3 times
// with exponential backoff on transient failures (AAI flakiness, rate limits).
async function runJob(jobId) {
  // Mark as processing in Supabase so we can recover stuck jobs on restart
  await supabase.from('batch_jobs').update({
    status: 'processing',
    stage: 'transcribing',
    started_at: new Date().toISOString()
  }).eq('id', jobId);

  const { data: job, error: fetchErr } = await supabase
    .from('batch_jobs').select('*').eq('id', jobId).single();
  if (fetchErr || !job) return;

  const venue = job.venue || 'Open Mic';
  let setDate = new Date();
  if (job.date_override) {
    const d = new Date(job.date_override);
    if (!isNaN(d)) setDate = d;
  } else if (job.detected_date) {
    const d = new Date(job.detected_date + 'T12:00:00');
    if (!isNaN(d)) setDate = d;
  }

  try {
    const result = await runPipeline(
      job.audio_url, venue, setDate,
      async (stage) => {
        await supabase.from('batch_jobs').update({ stage }).eq('id', jobId);
      }
    );

    await supabase.from('batch_jobs').update({
      status: 'done',
      stage: null,
      set_id: result.id,
      completed_at: new Date().toISOString()
    }).eq('id', jobId);

    console.log(`[batch] done ${jobId} → set ${result.id} | ${venue} | ${setDate.toISOString().split('T')[0]}`);

  } catch (err) {
    const retryCount = (job.retry_count || 0) + 1;
    console.error(`[batch] job ${jobId} attempt ${retryCount} failed: ${err.message}`);

    if (retryCount < 3) {
      // Exponential backoff before re-queue: 30s, 60s
      const backoffMs = retryCount * 30000;
      await sleep(backoffMs);
      await supabase.from('batch_jobs').update({
        status: 'queued',
        stage: null,
        error: `Attempt ${retryCount} failed: ${err.message}`,
        retry_count: retryCount
      }).eq('id', jobId);
      jobQueue.push(jobId);
    } else {
      await supabase.from('batch_jobs').update({
        status: 'error',
        stage: null,
        error: err.message,
        completed_at: new Date().toISOString()
      }).eq('id', jobId);
      console.error(`[batch] job ${jobId} permanently failed after ${retryCount} attempts`);
    }
  }
}

// Start up to MAX_CONCURRENT_JOBS workers. Each worker picks one job,
// processes it, then calls drainQueue again to pick up the next one.
function drainQueue() {
  while (jobQueue.length > 0 && activeWorkers < MAX_CONCURRENT_JOBS) {
    const jobId = jobQueue.shift();
    activeWorkers++;
    runJob(jobId)
      .catch(err => console.error(`[batch] unhandled error for ${jobId}:`, err.message))
      .finally(() => { activeWorkers--; drainQueue(); });
  }
}

// On server startup, resume any jobs that were queued or stuck mid-processing.
// 'processing' jobs got interrupted by a restart — reset them to 'queued'.
async function resumePendingJobs() {
  // Reset stuck processing jobs
  const { data: stuck } = await supabase.from('batch_jobs')
    .select('id').eq('status', 'processing');
  if (stuck && stuck.length) {
    await supabase.from('batch_jobs')
      .update({ status: 'queued', stage: null })
      .eq('status', 'processing');
    console.log(`[batch] reset ${stuck.length} stuck processing jobs to queued`);
  }

  // Load queued jobs in FIFO order
  const { data: queued } = await supabase.from('batch_jobs')
    .select('id').eq('status', 'queued')
    .order('created_at', { ascending: true });

  if (queued && queued.length) {
    queued.forEach(j => jobQueue.push(j.id));
    console.log(`[batch] resumed ${queued.length} queued jobs (${MAX_CONCURRENT_JOBS} concurrent workers)`);
    drainQueue();
  }
}

app.listen(PORT, () => {
  console.log(`Comediq.Hear server running on port ${PORT}`);
  resumePendingJobs().catch(err => console.error('[batch] startup resume failed:', err.message));
});
