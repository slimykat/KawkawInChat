# KawKaw — Twitch Extension Design Document

A Twitch chat engagement extension inspired by the KawKaw enemy encounter in Deltarune Chapter 5. Viewers type `!call` or `!shoo` in chat to push a single meter between two outcomes — **Lick** (KawKaw reaches the streamer) and **Flee** (KawKaw is chased off). Works as both a zero-backend OBS Browser Source and a native Twitch Extension overlay.

---

## ⚠️ Non-Commercial — Fan Project Notice

**This project uses assets from Deltarune (sprites and voice clips, by Toby Fox / times / igbt) and MUST NEVER be monetized.**

- No Bits, subscriptions, paid features, ads, donations, or any other revenue tied to this extension. The Twitch manifest reflects this: `bits.enabled` and `subscriptions.enabled` are both `false` (`extension/manifest.json`) — keep them off.
- This is a non-commercial fan work. The Deltarune assets are the property of their creators and are used here without any claim of ownership.
- If Twitch (or any distribution channel) requires monetization to be enabled, or the licensing situation changes, do not ship — revisit this constraint first.

---

## Interaction Model at a Glance

- **Input:** viewers type `!call` (push toward Lick) or `!shoo` (push toward Flee) in Twitch chat. Spam is intentional — every message counts.
- **State:** a single `meter` from `-10` (Flee) to `+10` (Lick). Commands are tallied on a 1-second tick and nudge the meter; it decays back toward 0 when chat quiets.
- **Outcomes:** meter hits `+10` → **Lick**; `-10` → **Flee**; a session-timeout near neutral → **Confused flee**.
- **Trigger:** KawKaw shows up on a chat command (`!kawkaw`) and/or a Channel Points redemption — streamer-configurable.
- **Hosting:** OBS Browser Source runs the whole engine client-side with **no backend**. The native Twitch Extension needs one small relay bot.

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
│   │   │   ├── main.js                  Host detection: OBS (direct IRC) vs Extension (PubSub)
│   │   │   ├── chat.js                  Anonymous Twitch IRC reader (OBS path)
│   │   │   ├── meter.js                 Shared engine: commands → meter → state (no rendering)
│   │   │   ├── game.js                  State → canvas/DOM rendering loop
│   │   │   ├── sprites.js               Sprite sheet coordinate map + draw helpers
│   │   │   └── audio.js                 Web Audio API, pitch-shifted playback
│   │   └── css/style.css
│   ├── config/                          Twitch Extension streamer config page
│   │   ├── config.html
│   │   └── config.js
│   └── bot/                             Relay bot — EXTENSION PATH ONLY
│       ├── bot.js                       IRC read + (optional) EventSub redeem, runs meter.js
│       ├── broadcaster.js               PubSub fan-out + WebSocket clients
│       ├── package.json
│       └── .env.example
└── extension/
    └── manifest.json                    Twitch Extension manifest
```

`meter.js` is the single source of game logic and is shared verbatim between the OBS overlay and the relay bot — see Architecture.

---

## Architecture — one engine, two hosts

The game logic lives in **one module, `meter.js`**: it takes a stream of `call`/`shoo`/`kawkaw` commands and produces the authoritative `state` object. It renders nothing. The same file runs in two places depending on how the overlay is loaded.

### OBS Browser Source — zero backend

The overlay connects a browser `WebSocket` directly to Twitch chat **anonymously** (`wss://irc-ws.chat.twitch.tv:443`, login `justinfan<random>`, no token, no password), `JOIN`s the configured channel, and parses commands out of `PRIVMSG` lines. `meter.js` runs in the overlay itself; `game.js` renders its state.

**Streamer setup, in full:** add a Browser Source in OBS pointing at the overlay URL with `?channel=<name>`. No server, no auth, no deploy, no EventSub.

Channel-point redeem trigger is **not** available on this path (redemptions require an authenticated EventSub subscription, which a client-side page cannot hold). OBS-only uses the chat-command trigger. An OBS streamer who wants redeem triggers can opt into running the relay bot (below) and point the overlay at it.

### Native Twitch Extension — one relay bot

A Twitch Extension runs under a strict CSP and cannot open the IRC socket, so it can't read chat directly. One small always-on **relay bot** (`src/bot/`) does it instead:

1. Reads chat (anonymous IRC) for `!call` / `!shoo` / `!kawkaw`.
2. Optionally holds an authenticated **EventSub** subscription for the Channel Points redeem trigger.
3. Runs the **authoritative** `meter.js` (the meter is time-based — decay and timeout — so it must have a single owner; independent clients would drift).
4. Broadcasts the resulting `state` to all Extension overlays via **Twitch PubSub** after every tick that changes it.

Extension overlays are dumb renderers: they receive `state` and draw it. They never compute the meter.

### Tenancy — one bot per streamer (single-tenant)

The relay bot holds a single `config` and a single `state` — it serves exactly **one channel**. Each streamer runs their own bot instance and points their Extension at it. Do not point multiple channels at one bot; they would share one KawKaw session. (The OBS path is inherently single-instance — one browser source, one channel.)

Rendering config (position, scale) is per-broadcaster regardless, since it lives in the Twitch broadcaster configuration segment and is applied independently by each overlay.

---

## Game Flow

### Session trigger (configurable)

KawKaw is idle until triggered. The streamer configures which triggers are live via the `trigger` setting:

| `trigger` | How a session starts | Requires |
|---|---|---|
| `command` | A broadcaster or mod types `!kawkaw` in chat | Nothing (works on both hosts) |
| `redeem` | A viewer redeems a Channel Points reward | The relay bot (authenticated EventSub) |
| `both` | Either of the above | Redeem path needs the bot |

On trigger, if idle: the **Emerge** animation plays, `meter` resets to 0, the session-timeout clock starts, and `phase` becomes `active`.

### Active session — the meter

While active, viewers push the meter with chat commands. Commands are batched on a **1-second tick**:

```js
push = calls − shoos                                    // net commands this tick (spam counts)
meter = clamp(meter * (1 - DECAY) + push * STEP, -10, 10)
shooStreak = push > 0 ? 0 : push < 0 ? shooStreak + 1 : shooStreak   // resets on any call tick
```

- `!call` pushes toward **+10 (Lick)** — KawKaw advances on the streamer, happy.
- `!shoo` pushes toward **−10 (Flee)** — KawKaw retreats, sad crying eyes swell.
- **Decay** pulls the meter back toward 0 each tick, so chat must *sustain* a push to reach a terminal. (Set `DECAY = 0` to make the meter hold its position instead.)

Everything on screen is derived from three fields: `meter` drives position; `shooStreak` drives the sad-eye size and down-pitch; the last tick's `push` drives the happy/sad reaction. No other counters exist.

### Terminal outcomes

| Outcome | Condition |
|---|---|
| **Lick** | `meter` reaches `+10` |
| **Flee (sad)** | `meter` reaches `−10` |
| **Flee (confused)** | `maxSessionDuration` expires with the meter still short of either end |

After any terminal, KawKaw plays its exit, the session returns to `idle`, and KawKaw disappears from the overlay.

---

## State Object

The complete authoritative state. On the Extension path this is what the bot broadcasts; on the OBS path the overlay holds it locally. Everything visual is derived from it — no other counters exist.

```js
{
  phase: 'idle' | 'active' | 'terminal',

  // Single game axis. -10 = Flee, +10 = Lick, 0 = neutral. Float.
  meter: 0,

  // Net push applied on the last tick (calls − shoos), for animation
  // direction/intensity. Positive = called, negative = shooed.
  push: 0,

  // Consecutive net-shoo ticks with no call in between. Drives the sad-eye
  // level AND the audio down-pitch; resets to 0 on any net-call tick.
  // Distinct from the meter: a streak, not a magnitude, and it snaps back on call.
  shooStreak: 0,

  // Set only at terminal, null otherwise
  outcome: null,          // 'lick' | 'flee_sad' | 'flee_confused'

  // ms timestamp the session auto-ends (confused flee); null when idle
  endsAt: null
}
```

Derived at render time (not stored): screen position `= (meter + 10) / 20` (meter-driven). The crying-eye level `= clamp(shooStreak, 0, 4)` and audio pitch `= 2^(-shooStreak / 12)` are **streak**-driven — they track consecutive shoos, not meter magnitude, and both reset the moment chat calls.

---

## Sprite Sheet

**File:** `assets/kawkaw/(Chapter 5) - Kawkaw.png` (573×533px, by times/igbt)

Animations used in this extension:

| Animation | Frames | When used |
|---|---|---|
| **Emerge** | 3 | Session start — KawKaw appears on stream |
| **Idle** | 2 | Default body while active |
| **Happy** | 3 | Positive `push` tick — KawKaw is being called toward Lick |
| **Dig** | 3 | `flee_sad` and `flee_confused` terminals — KawKaw leaves |
| **Tongue Start** | 2 | Lick terminal build-up |
| **Tongue** | 2 | Lick terminal finale |
| **Eye** ×4 sizes | 1 each | **Sad crying** overlay composited over Idle; size = `clamp(shooStreak, 0, 4)` — grows one step per consecutive shoo tick, resets to 0 (no overlay) the moment chat calls |

The crying eyes swell as chat **shoos** KawKaw toward fleeing, and are **removed** as chat **calls** it back toward licking. On the positive side there is no eye overlay — KawKaw advances happily.

Unused animations on the sheet: Bobhead, Blow Wind, Hurt, Hurt 2, Small (Idle variant), Pet, Moa, and all bullet sprites.

Rendering: a `<canvas>` draws the body sprite then composites the eye overlay on top. Frame cycling runs via `requestAnimationFrame`. Precise pixel coordinates are mapped in `sprites.js`.

**Confused terminal:** Idle body + a CSS `?` speech bubble overlay rendered in Press Start 2P font. No dedicated sprite needed.

---

## Audio

| File | When played |
|---|---|
| `happy_1` / `happy_2` | Random pick on a positive `push` tick (called toward Lick) |
| `sad_short` | On a negative `push` tick (shooed); pitch shifts down the more negative the meter |
| `sad_1` / `sad_2` | Random pick when `flee_sad` terminal is reached |
| `licking_1` / `licking_2` / `licking_3` | Random pick when `lick` terminal is reached |

Unused files: `hurt`, `licking_short` — carried over from source assets, not used.

**Pitch shift** (Web Audio API `playbackRate`), driven by the meter on the negative side:
```js
source.playbackRate.value = Math.pow(2, meter / 12);  // meter < 0 → pitched down
// meter = -12 would be one octave down; clamped range -10..0 keeps it musical.
```

---

## Communication

### Chat command ingestion
```
Viewer types !call / !shoo (or mod types !kawkaw)
  → OBS path:       overlay's anonymous IRC socket receives the PRIVMSG
  → Extension path: relay bot's IRC socket receives it
  → meter.js batches commands on a 1s tick and updates `state`
  → OBS: game.js renders directly
    Extension: bot broadcasts state_update via PubSub → overlays render
```

### Channel-point redeem trigger (bot only)
```
Viewer redeems reward
  → Twitch sends EventSub notification to the relay bot
  → Bot verifies the signature; if idle and trigger allows redeem: start session
  → Broadcast state_update
```

### State broadcast schema (Extension path)
Identical over PubSub and the bot's WebSocket (if used):
```json
{ "type": "state_update", "state": { "...": "..." } }
```

### Reconnection
- **OBS IRC:** the overlay retries the anonymous IRC connection every 5s; on reconnect it re-`JOIN`s and resumes reading. Meter state is local, so nothing is lost across a brief drop.
- **Extension PubSub:** the bot re-sends full current state on overlay (re)connect. If the overlay cannot reach the bot, it shows "Connection lost — please refresh."

### Config delivery

Game-logic and rendering config travel by **separate routes and never mix** — the config page cannot set game logic:

| | Game logic (`step`, `decay`, …) | Rendering (positions, scale) |
|---|---|---|
| **Extension** | relay bot's `.env` | config page → `configuration.set()` → overlay |
| **OBS** | URL query params | URL query params |

The config page is rendering-only by design. The bot has no access to the broadcaster configuration segment (reading it needs a signed Helix `GET /extensions/configurations` call), and the OBS path has no Twitch configuration at all — so `.env` and query params are the only channels that reach the engine.

Defaults for every game-logic value live in **one place**: `DEFAULTS` in `src/overlay/js/meter.js`. `.env` and query params override individual keys; anything unset, blank, or unparseable falls through to that object rather than being restated per host. The bot logs its resolved config on startup.
- **OBS:** game-logic config is passed as URL query params on the browser source:
  ```
  http://localhost:8080/overlay?channel=NAME&step=0.5&decay=0.05&maxSessionDuration=300&perUserCap=5
  ```

---

## Streamer Config

### Game-logic config

Set via the bot's `.env` (Extension) or URL query params (OBS) — **not** the config page. Defaults are owned by `meter.js`; the table below mirrors them for reference.

| Setting | Default | Description |
|---|---|---|
| `trigger` | `command` | `command` \| `redeem` \| `both` — how a session starts (redeem needs the bot) |
| `step` | `0.5` | Meter units per net command per tick — how hard one message pushes |
| `decay` | `0.05` | Fraction the meter relaxes toward 0 each tick when unpushed; `0` = hold |
| `maxSessionDuration` | `300` | Seconds before a stalled session ends in confused flee |
| `perUserCap` | `5` | Max commands counted per viewer per tick — stops one spammer soloing the meter |

`step` and `decay` together set the pace: tune so a lively chat reaches a terminal in ~20–40s of sustained pushing. These are the primary feel knobs.

### Rendering config (frontend only)

| Setting | Description |
|---|---|
| `startPosition` | Screen coordinate for the Flee end of the track (`meter = -10`) |
| `endPosition` | Screen coordinate of the streamer, the Lick end (`meter = +10`) |

KawKaw's on-screen position interpolates between these using `(meter + 10) / 20`. On the Extension, saved via `Twitch.ext.configuration.set()`; in OBS, passed as query params.

---

## Implementation Order

1. `meter.js` — the shared engine: command batching, tick, meter update, terminals. Standalone and unit-testable.
2. `chat.js` — anonymous Twitch IRC reader (connect, JOIN, parse `!call`/`!shoo`/`!kawkaw`).
3. Frontend overlay — HTML, CSS (canvas, meter/countdown display, confused bubble, connection-lost message).
4. Sprite engine — `sprites.js` coordinate map, canvas draw, frame animation (Emerge, Idle, Happy, Dig, Tongue Start, Tongue, crying Eye overlays).
5. Audio engine — `audio.js`, Web Audio API, pitch-shift playback.
6. Game renderer — `game.js`, state → animations + audio; position from `meter`, eye size and pitch from `shooStreak`.
7. Transport layer — `main.js`, host detection: OBS (wire `chat.js` → `meter.js` → `game.js`) vs Extension (PubSub → `game.js`).
8. Relay bot — `src/bot/`, IRC read + authoritative `meter.js` + PubSub broadcast; optional EventSub redeem trigger, `.env.example`.
9. Config page — streamer dashboard settings UI (trigger, step, decay, timeout, cap, positions).
10. Extension manifest — `extension/manifest.json` for Twitch packaging.

---

## Dev Setup

### OBS path (no backend)
```bash
# Serve the overlay statically (any static server)
npx serve src/overlay        # or python3 -m http.server

# In OBS: add a Browser Source →
#   http://localhost:8080/overlay/index.html?channel=YOURCHANNEL
```
No tokens, no tunnel. The overlay reads chat anonymously.

### Extension path (relay bot)
```bash
cd src/bot
npm install
cp .env.example .env          # channel name; Twitch creds only if using redeem trigger
npm run dev

# Tunnel only if using the Channel Points redeem trigger (EventSub must reach the bot)
ngrok http 3000
```
Register the ngrok URL as the EventSub webhook and create a Channel Points reward only if you enable the `redeem` trigger. The `command` trigger needs none of this.
