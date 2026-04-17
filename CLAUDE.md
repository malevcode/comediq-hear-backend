# Comediq — Claude Context

## Device
- Windows 11 Surface Pro (4 year old) — this is the dev machine, NOT a Mac
- Use Windows-compatible commands when needed
- iPhone 17 connects to this machine via Expo Go over local wifi

## Project Structure
- Backend: `C:/Users/adamm/comediq-hear-backend` (Node.js/Express, port 3000)
- Mobile app: `C:/Users/adamm/comediq-app` (React Native/Expo)

## To run locally
```
# Terminal 1 — backend
cd C:/Users/adamm/comediq-hear-backend && node server.js

# Terminal 2 — Expo
cd C:/Users/adamm/comediq-app && npx expo start
```

## Product vision
Comediq is Adam's personal comedy assistant — a tool to analyze every joke, every performance, and every piece of writing across his entire career. It covers the full performance spectrum:
- **Open mics** — low pressure, new material, rapid iteration and improvement
- **Pro shows** — high pressure, big stage, clip-worthy moments, compare planned vs. actual execution

Current focus is open mic analysis: record → transcribe → Claude rates each bit → track improvement over time. Future roadmap adds video analysis (Gemini, 5-min chunks) for pro show video review and clip extraction.

Zero friction at showtime is the core UX constraint.

## Key services
- Supabase: roakmtukscvktwyqfcmh.supabase.co (project: Quapture/Comediq.hear)
- AssemblyAI — transcription
- Anthropic claude-sonnet-4-6 — set analysis
- Railway — backend deployment: https://comediq-hear-backend-production.up.railway.app/

## Design system
- Dark default: bg #0A0A0A, text #F5F2EB, blue #1D4DB5, yellow #FFC72C, red #E63946
- Fonts: Bebas Neue (display), IBM Plex Mono (data), IBM Plex Sans (body)
- No rounded bubbly UI. Film noir comedy club aesthetic.
