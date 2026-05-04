# comediq.hear — Architecture

## Overview

Single Express server (`server.js`) that serves a static frontend and exposes a REST API.
Hosted on Railway via Docker. Mobile-first — designed for iPhone Safari.

## Stack

| Layer | Tech |
|---|---|
| Server | Node.js 18 / Express |
| Database | Supabase (Postgres) |
| Transcription | AssemblyAI |
| Joke analysis | Anthropic claude-sonnet-4-6 |
| Video conversion | FFmpeg (server-side, via child_process) |
| Hosting | Railway (Docker) |

## File layout

```
server.js          — Express API + static serving
hear.html          — Phase 1: video upload/convert UI (mobile-first)
index.html         — Main app UI (set review, bit library)
Dockerfile         — node:18-alpine + ffmpeg
uploads/           — NOT used (temp files go to /tmp/hear-uploads/)
```

## Environment variables (set in Railway)

| Variable | Purpose |
|---|---|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Supabase service role key |
| `ASSEMBLYAI_KEY` | AssemblyAI API key |
| `ANTHROPIC_KEY` | Anthropic API key |

---

## Phase 1 — Video Conversion

**URL:** `/hear.html`

### Flow

```
iPhone browser
  → POST /hear/upload       (multipart/form-data, video file)
  ← { job_id }

  → POST /hear/convert/:id  (kicks off FFmpeg, responds immediately)
  ← { ok: true }

  → GET  /hear/status/:id   (poll every 3s)
  ← { status, mp4, mp3 }    (status: uploaded | converting | done | error)

  → GET  /hear/download/:id/output.mp4   (Content-Disposition: attachment)
  → GET  /hear/download/:id/audio.mp3

  → DELETE /hear/job/:id    (removes /tmp/hear-uploads/<id>/ to free disk)
```

### FFmpeg commands

**MP4 conversion** (web-optimised, fast iPhone playback):
```
ffmpeg -i original.<ext> -c:v libx264 -preset fast -crf 23 \
       -c:a aac -b:a 128k -movflags +faststart -y output.mp4
```

**MP3 extraction** (for AssemblyAI transcription):
```
ffmpeg -i original.<ext> -vn -c:a libmp3lame -b:a 128k -y audio.mp3
```

### Storage

Files land in `/tmp/hear-uploads/<uuid>/` on the Railway container's ephemeral disk.
They are deleted when the user taps "Delete from Server" or the container restarts.
Max upload size: 2 GB.

---

## Phase 2 — Transcription (planned)

- `POST /hear/transcribe/:id` — submit `audio.mp3` to AssemblyAI with speaker diarization
- `GET  /hear/transcript/:id` — poll AssemblyAI until complete, store result in `sets.transcript_json`

## Phase 3 — Transcript UI (planned)

- Line-by-line display with timestamps
- Click line → seek audio player to that timestamp
- Tag each line: BIT NAME / KEEP / CUT / MAYBE / NOTES
- Stored in `transcript_lines` table

## Phase 4 — Bit Library (planned)

- View all bits across all sets
- See how each joke evolved over time
- Compare two versions side-by-side

---

## Database schema (Supabase)

Core tables: `sets`, `bits`, `bit_identities`, `bit_performances`, `chunks`, `topics`

Migrations needed for Phase 2+:
```sql
-- Run once in Supabase SQL editor
alter table sets add column if not exists transcript_json jsonb;
alter table sets add column if not exists assemblyai_job_id text;
alter table sets add column if not exists mp3_path text;
alter table sets add column if not exists mp4_path text;
alter table sets add column if not exists status text default 'pending';

create table if not exists transcript_lines (
  id           uuid primary key default gen_random_uuid(),
  set_id       uuid references sets(id) on delete cascade,
  start_time   float,
  end_time     float,
  text         text,
  speaker      text,
  bit_name     text,
  tag          text,   -- KEEP | CUT | MAYBE
  notes        text
);
```
