# comediq.hear — master product document
### version 3.19.26 | built by Adam Malev + Claude

---

## what this is

comediq.hear is a mobile-first performance analytics app for stand-up comedians. It replaces the Voice Memo → manual transcription → gut feeling workflow with an automated pipeline that records, transcribes, analyzes, and archives every set a comedian performs. The core insight is that comedians have never had real data about their own performance — only memory, which is unreliable. comediq.hear changes that.

It is a sub-product of Comediq (comediq.us), an NYC comedy open mic discovery platform with ~1,500 weekly users. comediq.hear is the performance layer on top of the discovery layer.

---

## the one-sentence pitch

You press record before you go on stage, you press stop when you come off, and comediq.hear automatically transcribes your set, breaks it into individual bits, scores each joke, detects where the crowd laughed, and saves everything permanently — so you can track every joke you've ever done and see exactly how it's improving over time.

---

## core philosophy

- Zero friction at showtime. One tap to start, one tap to stop. Nothing else required in the moment.
- Everything else is optional and asynchronous — context, ratings, notes can all be added later.
- Data over gut feeling. Three independent scores per joke: Claude analysis, laugh detection, user self-rating.
- Context matters. A joke that bombs for 3 people on a Tuesday is not the same data point as the same joke bombing for 50 people on a Friday.
- Permanent record. Every recording, every transcript, every performance of every joke — stored forever and cross-referenced automatically.

---

## the recording flow

1. Comedian opens comediq.hear (mobile web app, eventually React Native)
2. Optional: type venue name
3. Tap record — that's it. Phone goes in pocket.
4. MediaRecorder captures audio in the background
5. Comedian performs
6. Tap stop
7. App automatically fires the full pipeline — no further input needed
8. ~3-5 minutes later: full set report appears

---

## the pipeline (what happens after stop)

```
audio blob
  → Supabase Storage (audio bucket) — permanent audio file saved
  → AssemblyAI — transcription with word-level timestamps
  → pause detection — gaps >800ms after words = likely laugh moments
  → Claude (claude-sonnet-4-5) — analyzes transcript + pause data
      → groups jokes into thematic chunks/topics
      → identifies individual bits with setup + punchline
      → scores each bit 1-10
      → flags whether laugh likely occurred
      → gives specific coaching feedback per bit
  → bit identity matching (Dice coefficient similarity)
      → checks each new bit against all known jokes in the db
      → score >0.75 similarity = same joke, link to existing identity
      → score <0.75 = new joke, create new identity
  → saves to Supabase:
      → 1 row in `sets` table
      → N rows in `bits` table (one per identified bit)
      → N rows in `bit_identities` table (new or matched)
      → N rows in `bit_performances` table (performance record per joke)
  → post-set review screen appears automatically
```

---

## the three scores per joke

Every time a joke is performed, it gets three independent scores:

| score | source | how |
|---|---|---|
| analysis score | Claude | 1-10, based on premise strength, punchline payoff, structure, originality |
| laugh proxy | pause detection | calculated from pause duration after punchline (longer pause = bigger laugh) |
| user rating | comedian's slider | 1-10 sliding scale, appears post-set, auto-saves on release |

All three are averaged and tracked over time per joke identity.

---

## the laugh detection system

AssemblyAI returns word-level timestamps for every word in the transcript. The server analyzes gaps between words:

- Gap > 800ms after a sentence = significant pause detected
- Pause duration is recorded in milliseconds
- Laugh proxy score = min(10, pause_ms / 200) — a 2-second pause = score of 10
- Claude also uses the pause summary to contextually determine if a punchline likely landed

This is a proxy, not ground truth. It works because when an audience laughs, the comedian stops talking. The longer they laugh, the longer the gap. Combined with user rating and Claude's structural analysis, it creates a defensible composite signal.

---

## the joke identity system

The most powerful feature. Every bit ever performed has a permanent identity in the database.

- When a new bit is identified in a recording, its name is compared against all existing bit identities using the Dice coefficient similarity algorithm
- Dice coefficient measures bigram overlap between two strings — pairs of adjacent characters
- Score above 0.75: same joke → link new performance to existing identity
- Score below 0.75: new joke → create new identity
- Every performance of a joke (regardless of how it was named in that recording) accumulates on the same identity
- The bit_identities table tracks: total performances, avg analysis score, avg user rating, avg laugh proxy, best score ever, first performed date, last performed date

This means a comedian can see: "I've done this joke 47 times. It averages a 6.2 from Claude and a 7.1 from me. My best performance was at The Stand on March 14th. The laugh proxy has been trending up."

---

## context system

Added anytime after a recording — no friction at showtime:

- Venue name (can be typed before recording or added after)
- Crowd size (number of people)
- Audience type (rowdy, quiet, industry, late night, boozy, mixed, etc.)
- Free-text notes
- Voice note option: hold a button, speak context aloud, it transcribes and auto-fills fields

Context matters because a joke's score should be weighted differently based on room conditions. A small quiet Tuesday open mic is not the same testing environment as a packed Saturday show. Eventually this data will be used to normalize scores by context type.

---

## metadata automatically captured

- Date and time of recording (ISO timestamp)
- Duration of set (seconds, derived from audio)
- Audio file URL (Supabase Storage)
- Full transcript text
- Word-level timestamps for entire set
- All detected pause points with preceding text
- Venue (if provided)
- Overall set score and summary from Claude

---

## planned future metadata

- Location (GPS coordinates → venue lookup → auto-match to Comediq open mic listings)
- Total time on stage vs total time speaking
- Laughs per minute
- Ratio of laugh time to speaking time
- Demographic context (audience age range, comedy literacy level)
- Cross-reference with Comediq open mic data (show details, host, signup method, time slot)

---

## database schema (Supabase — project: Comediq.Hear / Quapture)

**`sets`** — one row per recording
- id (uuid), venue, date, date_iso, duration_sec, audio_url, transcript
- overall_score, overall_summary, strongest_bit, total_duration
- context (jsonb), laugh_data (jsonb), pause_points (jsonb), words (jsonb)

**`bit_identities`** — one row per unique joke, ever
- id (uuid), canonical_name, slug, topic_tags (array)
- total_performances, avg_analysis_score, avg_user_rating, avg_laugh_proxy
- best_score, first_seen_at, last_performed_at

**`bits`** — one row per identified bit per set
- id (uuid), set_id (fk), bit_identity_id (fk)
- name, score, setup, punchline, feedback, tags, positives, improvements
- transcript_excerpt, likely_laughed, timestamp_sec, pause_duration_ms
- user_rating, chunk_name

**`bit_performances`** — one row per joke per set (links everything)
- id (uuid), bit_id (fk), bit_identity_id (fk), set_id (fk)
- performance_date, performance_date_iso, venue
- user_rating, analysis_score, laugh_proxy_score
- likely_laughed, pause_duration_ms
- context_notes, crowd_size, crowd_type, audience_notes

---

## tech stack

### backend (Node.js — comediq-hear-backend)
- Express server running on localhost:3000 (eventually Railway)
- `@supabase/supabase-js` — database + storage client
- `multer` — audio file handling
- `node-fetch` — API calls
- `dotenv` — environment variables

### external APIs
- AssemblyAI — audio transcription with word-level timestamps (free tier: 5hr/month)
- Anthropic Claude (claude-sonnet-4-5) — set analysis, bit identification, coaching

### frontend (single HTML file — comediq-frontend.html)
- Vanilla JS, no framework
- MediaRecorder API — real audio capture (not Web Speech API)
- IndexedDB — offline queue for recordings when no internet
- Auto-drains queue on reconnect
- Hosted via Netlify drop

### database
- Supabase (project: Quapture / Comediq.Hear)
- URL: https://roakmtukscvktwyqfcmh.supabase.co
- Storage bucket: `audio` (public, 50MB limit on free tier)
- Storage bucket: `video` (ready for future video upload feature)
- RLS enabled — service_role key only, anon key blocked

### environment variables (.env)
```
ASSEMBLYAI_KEY=
ANTHROPIC_KEY=
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_KEY=
```

---

## api endpoints

| method | endpoint | what it does |
|---|---|---|
| POST | /process | full pipeline: audio → transcription → analysis → save |
| GET | /sets | all sets, ordered newest first |
| GET | /sets/:id | single set |
| GET | /sets/:id/bits | all bits for a set, with identity data |
| POST | /sets/:id/context | update context (venue, crowd, notes) |
| PATCH | /bits/:id/rating | auto-save user rating (no save button) |
| GET | /bits/:id/history | all performances of the same joke |
| GET | /identities | all known jokes, ordered by most performed |

---

## screens (current)

### record screen
- Full-screen dark background
- COMEDIQ.HEAR wordmark top left
- HISTORY button top right
- Venue input (optional, center)
- Record button (large, center) — currently red circle, planned: Comediq Q logo pulsing
- Timer display
- Level meter bars (8 bars reacting to mic input)
- Offline badge + queue badge when relevant

### processing screen
- Auto-fires when recording stops
- 4-step progress: uploading → transcribing → analyzing → building report
- No user interaction needed

### results screen
- Set venue + date in header
- Score ring (SVG, animated, color-coded: green/blue/red)
- Overall summary + strongest bit
- Audio player (play/pause, seek, timestamp)
- Bit breakdown grouped by theme/chunk
  - Each bit: name, score badge, setup text, punchline text, coaching feedback, tags, laugh indicator
- Full transcript (scrollable)
- "+ Add Context" FAB button (bottom right)

### history screen
- Two tabs: Sets / Bit Trends
- Sets: list of all recordings with venue, date, bit count, score
- Bit Trends: any joke performed 2+ times shows a bar chart of scores over time with avg/latest/trend arrow

### context sheet (bottom sheet)
- Slides up from bottom over results screen
- Fields: venue, audience type, notes
- Voice note button (hold to speak, auto-fills fields)
- Auto-saves on tap Save

---

## screens (planned / not yet built)

### post-set review screen
- Appears automatically after results
- Each bit gets a sliding scale 1-10 (no save button — auto-saves on release)
- Quick crowd context inputs (crowd size stepper, audience type pills)
- Skip option

### joke library screen
- All bit_identities, sorted by performance count
- Tap any joke → see full performance history
- Three-score trend chart per joke
- Filter by topic, date range, score range

### joke detail screen
- Single joke identity
- Every performance listed with date, venue, scores
- Transcript excerpts from each performance
- Best/worst performance highlighted
- Coaching notes aggregated across performances

### bulk upload screen
- Drop zone for audio files from Voice Memo / Rev
- Batch processes multiple files
- Manual date/venue input per file
- Progress queue

---

## aesthetic direction

**Dark, editorial, A24-cinematic with Comediq brand blue.**

- Background: near-black (#060a10)
- Primary accent: Comediq blue (#2d52a8 / #5b80d4)
- Typography: Bebas Neue (display/headers) + IBM Plex Mono (data/labels) + IBM Plex Sans (body)
- Film grain overlay (subtle, CSS SVG filter)
- No gradients, no shadows, no neon
- Thin borders (1px, low opacity blue)
- Score colors: green (7.5+), blue (5-7.5), red (<5)
- Laugh indicator: small pill badge per bit
- Level meter: 8 bars, gold when speaking, red when loud

**The feel:** like a film director's cut notes crossed with a sports analytics dashboard. Serious tool for serious performers. Not a consumer wellness app. Not SaaS purple gradients.

---

## what's built and working (as of 3.19.26)

- [x] Full recording pipeline (MediaRecorder → AssemblyAI → Claude → Supabase)
- [x] Audio saved to Supabase Storage
- [x] Set metadata saved to Supabase `sets` table
- [x] Bits saved to `bits` table with setup/punchline/score/laugh data
- [x] Bit identity matching via Dice coefficient
- [x] Bit performances saved to `bit_performances` table
- [x] Stats auto-recalculate on each new performance
- [x] Offline queue via IndexedDB (auto-drains on reconnect)
- [x] Auto-save user rating via PATCH endpoint (no save button)
- [x] Context sheet (venue, crowd, notes, voice note)
- [x] History screen with sets list
- [x] Bit trends chart (2+ performances of same joke)
- [x] Pause detection as laugh proxy
- [x] Comediq blue color palette
- [x] Dark editorial aesthetic
- [x] Backend runs locally (localhost:3000) — not yet deployed to Railway

## what's not yet built

- [ ] Post-set review screen with per-bit rating sliders
- [ ] Joke library / joke detail screens
- [ ] Bulk upload flow (Voice Memo / Rev files)
- [ ] GPS location → auto-venue detection
- [ ] Comediq open mic integration (link set to specific show listing)
- [ ] React Native mobile app (currently mobile web)
- [ ] Railway deployment (backend)
- [ ] Netlify deployment (frontend)
- [ ] Do Not Disturb mode trigger on record (requires native app)
- [ ] Video recording + analysis (Gemini integration, planned)
- [ ] Laugh tracker integration (previous intern's GitHub — pending link)
- [ ] User accounts / auth (currently single-user, open access)
- [ ] Normalized scoring by context (crowd size, venue type)
- [ ] Laughs per minute metric
- [ ] Ratio of laugh time to speaking time

---

## origin + related projects

- **Comediq** (comediq.us) — NYC comedy open mic finder, 1,500 weekly users, built by Adam Malev
- **Comediq Media** — street interview marketing agency for DTC brands, comedians produce branded content
- **comediq.hear** — this product. formerly considered under the name "Quapture"
- The Supabase project is named "Quapture" — same project, rebranded

---

## the person building this

Adam Malev. NYC comedian, founder, former EY Financial Services analyst. Performs regularly at open mics in NYC. Hosts Malev & Friends and Safe Enough for Work. Builds tools for the comedy scene because no one else is. ADHD-adjacent — needs structure, direct communication, one next action at a time. Aesthetic taste: dark, premium, editorial. No em dashes. No Comic Sans. No purple gradients.

