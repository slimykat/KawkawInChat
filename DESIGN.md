# KawKaw — Twitch Extension Design Document

A Twitch chat engagement extension inspired by the KawKaw enemy encounter in Deltarune Chapter 5. Viewers collectively vote to Call or Shoo KawKaw each interval. Works as both a Twitch Extension overlay and an OBS Browser Source.

---

## ⚠️ Non-Commercial — Fan Project Notice

**This project uses assets from Deltarune (sprites and voice clips, by Toby Fox / times / igbt) and MUST NEVER be monetized.**

- No Bits, subscriptions, paid features, ads, donations, or any other revenue tied to this extension. The Twitch manifest reflects this: `bits.enabled` and `subscriptions.enabled` are both `false` (`extension/manifest.json`) — keep them off.
- This is a non-commercial fan work. The Deltarune assets are the property of their creators and are used here without any claim of ownership.
- If Twitch (or any distribution channel) requires monetization to be enabled, or the licensing situation changes, do not ship — revisit this constraint first.

---

## Project Structure

```
NyonClicker/
├── assets/kawkaw/
│   ├── (Chapter 5) - Kawkaw.png        sprite sheet (573×533px, by times/igbt)
│   ├── Kawkaw_voiceclip_happy_1.wav.ogg
│   ├── Kawkaw_voiceclip_happy_2.wav.ogg
│   ├── Kawkaw_voiceclip_sad_short.wav.ogg
│   ├── Kawkaw_voiceclip_sad_1.wav.ogg
│   ├── Kawkaw_voiceclip_sad_2.wav.ogg
│   ├── Kawkaw_voiceclip_licking_1.wav.ogg
│   ├── Kawkaw_voiceclip_licking_2.wav.ogg
│   ├── Kawkaw_voiceclip_licking_3.wav.ogg
│   ├── Kawkaw_voiceclip_hurt.wav.ogg        (unused)
│   └── Kawkaw_voiceclip_licking_short.wav.ogg  (unused)
├── src/
│   ├── overlay/                         Twitch Extension overlay + OBS source
│   │   ├── index.html
│   │   ├── js/
│   │   │   ├── main.js                  Twitch SDK init / WebSocket fallback
│   │   │   ├── game.js                  State → canvas/DOM rendering loop
│   │   │   ├── sprites.js               Sprite sheet coordinate map + draw helpers
│   │   │   └── audio.js                 Web Audio API, pitch-shifted playback
│   │   └── css/style.css
│   ├── config/                          Twitch Extension streamer config page
│   │   ├── config.html
│   │   └── config.js
│   └── backend/
│       ├── server.js                    Express + WebSocket server
│       ├── state.js                     Game state machine + interval timer
│       ├── broadcaster.js               Twitch PubSub + WebSocket broadcast
│       ├── routes/
│       │   ├── eventsub.js              EventSub webhook handler
│       │   ├── vote.js                  Vote ingestion + per-user side tracking
│       │   └── config.js               Streamer config API
│       ├── package.json
│       └── .env.example
├── extension/
│   └── manifest.json                    Twitch Extension manifest
└── package.json                         Root dev scripts
```

---

## Hosting

| Component | Dev | Production |
|---|---|---|
| **Overlay / Config page (frontend)** | Twitch Local Test mode (loads from localhost) | Upload to Twitch CDN via Developer Console |
| **Backend (EBS)** | Local Express server + ngrok tunnel | Railway or Render |
| **OBS Browser Source** | Load overlay URL directly from local server | Load from production backend URL |

The Twitch Developer Console hosts your uploaded frontend assets. You always self-host the backend.

---

## Backend Responsibilities

The backend is the sole source of truth for game state. It does not render anything — the frontend is purely reactive.

1. **Game state machine** — owns the authoritative state object, runs the interval timer, resolves votes into call/shoo wins, triggers terminal conditions
2. **EventSub webhook handler** — receives and verifies Twitch Channel Point redemptions, starts sessions
3. **Vote ingestion** — stores each viewer's current side, overwrites on switch, tallies at interval close
4. **State broadcaster** — pushes state updates to all overlays via Twitch PubSub and WebSocket after every resolution
5. **Config storage** — receives and stores game-logic config POSTed by the frontend on load

---

## Game Flow

### Session trigger
A streamer creates a Channel Points reward (e.g., "KawKaw Visit!"). When a viewer redeems it, Twitch fires an EventSub webhook to the backend. If no session is already active, a new session starts, the Emerge animation plays on all overlays, and voting begins.

### Per-interval voting
Once a session is active, a voting window opens for a configurable duration. All viewers see **Shoo** and **Call** buttons. Each viewer has a current side and may switch freely at any time during the interval. When the timer expires:

- **Call majority** → KawKaw moves one step closer to the streamer. Eye level resets to 0. Consecutive-shoo counter resets to 0. Happy animation plays. A random happy sound plays.
- **Shoo majority** → Eye level grows by one. Consecutive-shoo counter increments. Idle body remains; only the eye overlay changes. A pitched-down `sad_short` sound plays.
- **Tie / no votes** → No position or eye change. Contributes toward the confused outcome if the session timer runs out.

A new voting window opens immediately after resolution unless a terminal condition is reached.

### Terminal outcomes

| Outcome | Condition |
|---|---|
| **Lick** | KawKaw reaches the streamer (`position` reaches 0) |
| **Fled (sad)** | Consecutive shoos ≥ `shooesToFlee` |
| **Fled (confused)** | `maxSessionDuration` expires — current interval finishes resolving first, then session ends |

After any terminal outcome the session returns to idle and KawKaw disappears from the overlay.

---

## State Object

Broadcast to all connected overlays on every change:

```js
{
  phase: 'idle' | 'voting' | 'resolving' | 'terminal',

  // Game logic position: callsToWin = far/entrance, 0 = at streamer
  // Moves one step toward 0 per call win. Does not move on shoo.
  position: 20,

  // Shoo eye size overlay (0 = normal, 4 = maximum)
  // Resets to 0 on any call win
  eyeLevel: 0,

  // Consecutive shoo wins without a call win in between
  // Used for audio pitch shift; resets to 0 on any call win
  consecutiveShoos: 0,

  totalCalls: 0,          // call wins this session
  totalShoos: 0,          // shoo wins this session
  lastAction: null,       // 'call' | 'shoo' | null

  votes: { shoo: 0, call: 0 },
  intervalEndsAt: null,   // ms timestamp for countdown display

  // Set only at terminal, null otherwise
  outcome: null           // 'lick' | 'fled_sad' | 'fled_confused'
}
```

---

## Sprite Sheet

**File:** `assets/kawkaw/(Chapter 5) - Kawkaw.png` (573×533px, by times/igbt)

Animations used in this extension:

| Animation | Frames | When used |
|---|---|---|
| **Emerge** | 3 | Session start — KawKaw appears on stream |
| **Idle** | 2 | Default body during voting and shoo reactions |
| **Happy** | 3 | Call interval win, plays during position advance |
| **Dig** | 3 | `fled_sad` and `fled_confused` terminals — KawKaw leaves |
| **Tongue Start** | 2 | Lick terminal build-up |
| **Tongue** | 2 | Lick terminal finale |
| **Eye** ×4 sizes | 1 each | Composited over Idle body; size corresponds to `eyeLevel` (0 = no overlay, 1–4 = increasing sizes) |

Unused animations on the sheet: Bobhead, Blow Wind, Hurt, Hurt 2, Small (Idle variant), Pet, Moa, and all bullet sprites.

Rendering: a `<canvas>` element draws the body sprite then composites the eye overlay on top. Frame cycling runs via `requestAnimationFrame`. Precise pixel coordinates are mapped in `sprites.js` and measured from the sheet.

**Confused terminal:** Idle body + a CSS `?` speech bubble overlay rendered in Press Start 2P font. No dedicated sprite needed.

---

## Audio

| File | When played |
|---|---|
| `happy_1` / `happy_2` | Random pick on each call interval win |
| `sad_short` | Each shoo interval win (pitch shifts down with consecutive shoos) |
| `sad_1` / `sad_2` | Random pick when `fled_sad` terminal is reached |
| `licking_1` / `licking_2` / `licking_3` | Random pick when `lick` terminal is reached |

Unused files: `hurt`, `licking_short` — carried over from source assets, not used.

**Pitch shift formula** (Web Audio API `playbackRate`):
```js
source.playbackRate.value = Math.pow(2, -consecutiveShoos / 12);
// Each consecutive shoo = -1 semitone. Resets to 1.0 on any call win.
```

---

## Communication

### Channel point redemption → session start
```
Viewer redeems reward
  → Twitch sends POST /eventsub
  → Backend verifies HMAC-SHA256 signature
  → If idle: load stored config, start session, broadcast state_update to all overlays
```

### Viewer vote
```
Viewer clicks Shoo or Call button
  → POST /vote { action, userId } with Twitch Extension JWT
  → Backend stores userId → action, overwriting any previous vote for this interval
  → Interval timer fires → count each side → resolve majority → broadcast state_update
  → Overlays animate + play audio
```

### OBS Browser Source fallback
When `window.Twitch?.ext` is not present (OBS or browser tab context), the overlay connects via a plain `WebSocket` to the backend. The backend maintains both Twitch PubSub and a WebSocket broadcast list. Message schema is identical in both transports:

```json
{ "type": "state_update", "state": { "...": "..." } }
```

**Reconnection:** The client retries the WebSocket connection every 5 seconds. On successful reconnect, the backend immediately sends the full current state. If the connection cannot be established, the overlay displays a "Connection lost — please refresh" message.

### Config delivery
On overlay load, the frontend reads config from `Twitch.ext.configuration.get()` and POSTs the game-logic fields to `POST /config` on the backend. The backend stores this config and uses it when the next session starts.

For OBS Browser Source (no Twitch SDK context), game-logic config is passed as URL query parameters:
```
http://localhost:3000/overlay?intervalDuration=10&callsToWin=20&shooesToFlee=5&maxSessionDuration=300
```

---

## Streamer Config

### Game-logic config (stored on backend)

| Setting | Default | Description |
|---|---|---|
| `intervalDuration` | `10` | Seconds per voting window |
| `callsToWin` | `20` | Steps to trigger lick (matches original game's 20 stages) |
| `shooesToFlee` | `5` | Consecutive shoo wins to trigger sad flee |
| `maxSessionDuration` | `300` | Total session seconds before confused flee |

### Rendering config (frontend only, never sent to backend)

| Setting | Description |
|---|---|
| `startPosition` | Screen coordinate where KawKaw enters the overlay |
| `endPosition` | Screen coordinate of the streamer (where lick triggers) |

KawKaw's visual position is interpolated between `startPosition` and `endPosition` based on `position / callsToWin`.

Config is saved via `Twitch.ext.configuration.set()` on the streamer's dashboard.

---

## Implementation Order

1. Backend scaffold — Express + WebSocket, `.env.example`
2. Game state machine — state object, interval timer, transition logic
3. EventSub route — HMAC verification, session trigger
4. Vote route — per-user side storage, tally at interval close, resolution
5. Config route — receive and store game-logic config from frontend
6. Broadcaster — Twitch PubSub + WS fan-out, full state on WS reconnect
7. Frontend overlay — HTML, CSS (canvas, vote buttons, countdown bar, confused bubble, connection-lost message)
8. Sprite engine — `sprites.js` coordinate map, canvas draw, frame animation (Emerge, Idle, Happy, Dig, Tongue Start, Tongue, Eye overlays)
9. Audio engine — `audio.js`, Web Audio API, pitch-shift playback
10. Game renderer — `game.js`, state updates → animations + audio calls
11. Transport layer — `main.js`, Twitch SDK init + WS fallback with auto-retry
12. Config page — streamer dashboard settings UI
13. Extension manifest — `extension/manifest.json` for Twitch packaging

---

## Dev Setup (once implementation begins)

```bash
# Backend
cd src/backend
npm install
cp .env.example .env   # fill in Twitch credentials
npm run dev

# Tunnel for EventSub (Twitch must reach your server)
ngrok http 3000

# Overlay (as OBS Browser Source)
# Open http://localhost:3000/overlay in OBS Browser Source
```

Register the ngrok URL as your EventSub webhook URL in the Twitch Developer Console and create a Channel Points reward to trigger sessions.
