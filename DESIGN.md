# KawKaw — Design Document

A Twitch chat engagement overlay inspired by the KawKaw enemy encounter in Deltarune Chapter 5. Viewers type `!call` or `!shoo` in chat to push a single meter between two outcomes — **Lick** (KawKaw reaches the streamer) and **Flee** (KawKaw is chased off). Runs as an OBS Browser Source fed by a small backend on the streamer's own machine.

---

## ⚠️ Non-Commercial — Fan Project Notice

**This project uses assets from Deltarune (sprites and voice clips, by Toby Fox / times / igbt) and MUST NEVER be monetized.**

- No Bits, subscriptions, paid features, ads, donations, or any other revenue tied to this project.
- This is a non-commercial fan work. The Deltarune assets are the property of their creators and are used here without any claim of ownership.
- The project deliberately ships as an OBS overlay rather than a Twitch Extension. A Twitch Extension would require submitting these assets for review and hosting them on Twitch's CDN under a developer account; an OBS overlay keeps the assets on the streamer's own machine and involves no distribution.
- If any distribution channel requires monetization to be enabled, or the licensing situation changes, do not ship — revisit this constraint first.

---

## At a Glance

- **Input:** viewers type `!call` (push toward Lick) or `!shoo` (push toward Flee) in Twitch chat. Spam is intentional — every message counts, capped per viewer per tick.
- **State:** a single `meter` from `-10` (Flee) to `+10` (Lick). Commands are tallied on a 1-second tick and nudge the meter; it decays back toward 0 when chat quiets.
- **Outcomes:** meter hits `+10` → **Lick**; `-10` → **Flee**; a session timeout near neutral → **Confused flee**.
- **Trigger:** KawKaw shows up on a chat command (`!kawkaw` from a mod or the broadcaster) and/or a Channel Points redemption — streamer-configurable.
- **Hosting:** one backend process on the streamer's machine, bound to loopback. No public endpoint, no tunnel, no deploy.

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
└── src/
    ├── overlay/                         OBS Browser Source — pure renderer
    │   ├── index.html
    │   ├── js/
    │   │   ├── main.js                  WebSocket to the backend → game.js
    │   │   ├── game.js                  State → canvas/DOM rendering loop
    │   │   ├── sprites.js               Sprite sheet coordinate map + draw helpers
    │   │   └── audio.js                 Web Audio API, pitch-shifted playback
    │   └── css/style.css
    ├── config/                          Streamer settings page
    │   ├── config.html
    │   ├── config.css
    │   └── config.js
    └── backend/
        ├── server.js                    Loopback HTTP + WS + static; wires everything
        ├── engine.js                    Game logic: commands → meter → state
        ├── chat.js                      Anonymous Twitch IRC reader
        ├── config.js                    Schema, validation, config.json persistence
        ├── eventsub.js                  EventSub WebSocket client (redeem trigger)
        ├── twitch.js                    OAuth + Helix; token storage and refresh
        ├── *.test.js                    One self-check per module, plain assert
        ├── package.json
        ├── .env.example
        ├── config.json                  written by the config page   (gitignored)
        └── tokens.json                  OAuth tokens, 0600           (gitignored)
```

---

## Architecture

One process owns everything: the backend reads chat, runs the engine, serves the frontend, and streams state to the overlay.

```
Twitch IRC ──► backend ──► engine.js ──► WebSocket ──► overlay ──► canvas
 (outbound)                (authoritative)  (loopback)   (renderer)
```

The overlay is a **pure renderer**. It computes nothing — it receives finished `state` objects and draws them. The engine is time-based (decay and session timeout), so it must have exactly one owner; two clients running their own copies would drift apart within seconds.

### Why a backend at all

Two things require a process that outlives a page load:

1. **The Channel Points redeem trigger.** Redemptions arrive over an authenticated EventSub subscription, which a browser page cannot hold.
2. **Authoritative timing.** Decay and the session clock need a single owner.

Chat reading itself needs no backend — Twitch IRC accepts anonymous read-only logins — but once the backend exists for the two reasons above, routing chat through it removes the second copy of the engine.

### Network posture

**The backend never accepts a connection from outside the machine.** Every Twitch connection it makes is outbound, and its only listening socket is bound to `127.0.0.1`:

| Direction | Connection | Purpose |
|---|---|---|
| Outbound | `wss://irc-ws.chat.twitch.tv` | Read chat, anonymously |
| Outbound | `wss://eventsub.wss.twitch.tv` | Receive Channel Points redemptions |
| **Loopback** | `http://127.0.0.1:PORT` | Serve overlay + config page, stream state |

There is no webhook, no tunnel, no port forwarding, and no public URL. This is a deliberate constraint: asking streamers — some with large channels — to expose an endpoint and secure it correctly is a burden the design should not create.

Requests to the loopback server are accepted only when all of these hold:

| Guard | Stops |
|---|---|
| Bind `127.0.0.1`, never `0.0.0.0` | Anything off-machine |
| `Host` header must be a loopback name | DNS rebinding — a browser cannot forge `Host` |
| No CORS headers emitted | Cross-origin reads of any response |
| Static paths confined to their mount | Path traversal |

### Tenancy — one backend per streamer

The backend holds a single `config` and a single `state`, serving exactly **one channel**. Each streamer runs their own instance. Do not point two channels at one backend; they would share a single KawKaw session.

---

## Game Flow

### Session trigger (configurable)

KawKaw is idle until triggered. The streamer chooses which triggers are live via the `trigger` setting:

| `trigger` | How a session starts |
|---|---|
| `command` | Someone types `!kawkaw` in chat — anyone, or mods only, per `summonBy` |
| `redeem` | A viewer redeems a Channel Points reward whose name matches `rewardTitle` |
| `both` | Either of the above |

On trigger, if idle: the **Emerge** animation plays, `meter` resets to 0, the session-timeout clock starts, and `phase` becomes `active`.

### Active session — the meter

While active, viewers push the meter with chat commands. Commands are batched on a **1-second tick**:

```js
push = Σ clamp(callsᵤ − shoosᵤ, −perUserCap, +perUserCap)   // per viewer, then summed
meter = clamp(meter * (1 - decay) + push * step, -10, 10)
shooStreak = push > 0 ? 0 : push < 0 ? shooStreak + 1 : shooStreak   // resets on any call tick
```

- `!call` pushes toward **+10 (Lick)** — KawKaw advances on the streamer, happy.
- `!shoo` pushes toward **−10 (Flee)** — KawKaw retreats, sad crying eyes swell.
- **Decay** pulls the meter back toward 0 each tick, so chat must *sustain* a push to reach a terminal. (Set `decay = 0` to make the meter hold its position instead.)
- **`perUserCap`** is applied per viewer *before* summing, so one person mashing 50 messages contributes at most `perUserCap`. Spam is welcome; soloing the meter is not.

Only the first whitespace-delimited token counts: `!call now` registers, `hey !call` does not.

Everything on screen derives from three fields: `meter` drives position; `shooStreak` drives the sad-eye size and down-pitch; the last tick's `push` drives the happy/sad reaction. No other counters exist.

### Terminal outcomes

| Outcome | Condition |
|---|---|
| **Lick** | `meter` reaches `+10` |
| **Flee (sad)** | `meter` reaches `−10` |
| **Flee (confused)** | `maxSessionDuration` expires with the meter still short of either end |

Each terminal fills `terminalHoldMs`, then the session returns to `idle`:

| Outcome | Exit |
|---|---|
| **Lick** | Tongue plays for the hold, then **Dig** — timed so the dig lands exactly as the session ends |
| **Flee (sad)** | **Slides off screen** at a constant 700 px/s, heading derived from `startPos − endPos`, so it leaves the way it came in. No dig |
| **Flee (confused)** | `?` bubble for the hold, then **Dig** |

The slide is constant-speed rather than eased. The position easing moves a fraction of the
*remaining* distance each frame, so an off-screen target makes the first frames enormous and
KawKaw vanishes in ~2 frames instead of sliding. A track with `startPos == endPos` defines no
heading, so that case digs away instead.

---

## State Object

The complete authoritative state, held by the backend and broadcast to the overlay on every tick that changes it. Everything visual is derived from it — no other counters exist.

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

Derived at render time (not stored): screen position `= (meter + 10) / 20`, meter-driven. The crying-eye level `= clamp(shooStreak, 0, 4)` and audio pitch `= 2^(-shooStreak / 12)` are **streak**-driven — they track consecutive shoos, not meter magnitude, and both reset the moment chat calls.

---

## Sprite Sheet

**File:** `assets/kawkaw/(Chapter 5) - Kawkaw.png` (573×533px, by times/igbt)

| Animation | Frames | When used |
|---|---|---|
| **Emerge** | 3 | Session start — KawKaw appears on stream |
| **Idle** | 2 | Default body while active |
| **Happy** | 3 | Positive `push` tick — KawKaw is being called toward Lick |
| **Dig** | 3 | `lick` and `flee_confused` terminals — KawKaw burrows away. (`flee_sad` slides off screen instead) |
| **Tongue Start** | 2 | Lick terminal build-up |
| **Tongue** | 2 | Lick terminal finale |
| **Eye** ×4 | 1 each | **Sad crying** overlay composited over Idle. Frame 1 is dry, 2–4 add the teardrop and differ only in where the white shine sits. Shown from `shooStreak ≥ 1`, cleared the moment chat calls |

The crying eyes swell as chat **shoos** KawKaw toward fleeing, and are **removed** as chat **calls** it back toward licking. On the positive side there is no eye overlay — KawKaw advances happily.

The swelling is **not in the art** — all four eye frames are the same size. `drawEye` scales the
overlay by `1 + (shooStreak − 1) × 0.3`, capped at `2.2×`, centred on the eyeball at cell
coordinate `(24, 35.5)` so it grows in place instead of sliding toward the corner. This is the one
place the overlay's pixel alignment with the body is deliberately broken: a fractional scale cannot
land on the body's grid. Frames stop advancing after the fourth, but the growth continues to the cap.

Unused animations on the sheet: Bobhead, Blow Wind, Hurt, Hurt 2, Small (Idle variant), Pet, Moa, and all bullet sprites.

Rendering: a `<canvas>` draws the body sprite then composites the eye overlay on top. Frame cycling runs via `requestAnimationFrame`. Precise pixel coordinates are mapped in `sprites.js`.

**Confused terminal:** Idle body + a CSS `?` speech bubble overlay rendered in Press Start 2P font. No dedicated sprite needed.

---

## Audio

| File | When played |
|---|---|
| `happy_1` / `happy_2` | Random pick on a positive `push` tick (called toward Lick) |
| `sad_short` | On a negative `push` tick (shooed); pitch shifts down with the shoo streak |
| `sad_1` / `sad_2` | Random pick when `flee_sad` terminal is reached |
| `licking_1` / `licking_2` / `licking_3` | Random pick when `lick` terminal is reached |

Unused files: `hurt`, `licking_short` — carried over from source assets, not used.

**Pitch shift** (Web Audio API `playbackRate`), driven by the **shoo streak**, not the meter:
```js
source.playbackRate.value = Math.pow(2, -shooStreak / 12);
// Each consecutive shoo tick = one semitone down. Snaps back to 1.0 on any call tick.
```

---

## Communication

### Chat command ingestion
```
Viewer types !call / !shoo (or a mod types !kawkaw)
  → backend's anonymous IRC socket receives the PRIVMSG
  → chat.js parses it → { userId, action, privileged }
  → engine.js buffers it; the 1s tick folds it into `state`
  → backend broadcasts state_update over the loopback WebSocket
  → game.js renders
```

### Channel-point redeem trigger
```
Viewer redeems reward
  → Twitch pushes the event down the backend's outbound EventSub WebSocket
  → if idle, `trigger` allows redeem, and the reward name matches: engine.start()
  → broadcast state_update
```

The subscription covers **every** custom reward on the channel — the EventSub condition
only accepts a reward *id*, and binding to one would mean a reward picker in the config
page plus a stale id every time the streamer recreates the reward. The `rewardTitle`
filter is applied to the incoming event instead, so changing it takes effect immediately
without re-subscribing.

The subscription is created over **WebSocket transport**, not a webhook: the backend dials out, receives a `session_welcome`, and subscribes using that session id. Twitch then delivers events down the socket the backend opened. Nothing has to be publicly reachable, and there is no callback signature to verify.

Message ids are deduplicated (Twitch may redeliver), a missed keepalive forces a reconnect, and `session_reconnect` migrates to the replacement socket before dropping the old one so no event falls in the gap. Migrated sessions inherit their subscriptions and are not re-subscribed.

### State broadcast schema
```json
{ "type": "state_update", "state": { "...": "..." } }
```

### Reconnection
- **Chat (backend → Twitch):** retries every 5s; on reconnect it re-`JOIN`s and resumes. Engine state is untouched, so a brief drop costs only the commands sent during it.
- **Overlay (overlay → backend):** retries every 5s and shows "Backend not running — retrying…" meanwhile. On connect the backend immediately sends full current state, so a reloaded overlay never sits blank.

---

## Streamer Config

Configuration lives in two places, split by how often it changes.

| | Where | Changed |
|---|---|---|
| **Secrets and identity** | `.env` | Once, at install |
| **Everything tunable** | config page → backend | Any time |

`.env` holds only what the installer writes once: `CHANNEL`, `PORT`, and the Twitch application credentials for the redeem trigger. No game tuning lives there.

### Game-logic config

Defaults are owned by `DEFAULTS` in `src/backend/engine.js` — the single place these numbers exist. Saved values override individual keys; anything unset or unparseable falls through to the defaults rather than being restated. The backend logs its resolved config on startup.

| Setting | Default | Description |
|---|---|---|
| `trigger` | `command` | `command` \| `redeem` \| `both` — how a session starts |
| `summonBy` | `everyone` | `everyone` \| `mods` — who may type `!kawkaw` |
| `rewardTitle` | `KawKaw` | Which Channel Points reward counts; substring, case-insensitive, blank = any |
| `step` | `1` | Meter units per net command per tick — how hard one message pushes |
| `decay` | `0` | Fraction the meter relaxes toward 0 each tick when unpushed; `0` = hold |
| `maxSessionDuration` | `60` | Seconds before a stalled session ends in confused flee |
| `perUserCap` | `5` | Max commands counted per viewer per tick — stops one spammer soloing the meter |
| `terminalHoldMs` | `1500` | How long a terminal holds on screen before returning to idle |

`step` and `decay` together set the pace, and they are the primary feel knobs.

The defaults were tuned on stream, not derived. With `decay = 0` the meter keeps everything chat
gives it, so a terminal is a flat **10 net commands** rather than a rate chat has to sustain —
within reach of a small chat, and the knob to raise for a large one.

Beware the ceiling that decay imposes: a sustained push of `p` per tick converges on
`p × step / decay`, so any decay high enough to put that below `10` makes the terminal
*unreachable* no matter how long chat pushes. `decay = 0` has no ceiling.

**Changes apply at the next encounter, not mid-session.** The engine stages new config and picks it up on `start()`, so retuning can never yank the meter out from under viewers mid-encounter.

### Rendering config

| Setting | Default | Description |
|---|---|---|
| `startPos` | `0.10, 0.70` | Screen coordinate for the Flee end of the track (`meter = -10`), and the direction KawKaw exits |
| `endPos` | `0.80, 0.70` | Screen coordinate of the streamer, the Lick end (`meter = +10`) |
| `scale` | `5` | Sprite scale multiplier |
| `flipX` | `1` | `0` faces left (the sheet's native orientation), `1` faces right |
| `rotation` | `0` | Degrees clockwise, applied about the sprite centre |
| `volume` | `100` | Voice-clip volume, percent |

Positions are 0–1 fractions of the overlay. KawKaw's on-screen position interpolates between them using `(meter + 10) / 20`.

### Browser Source size

Nothing declares a resolution — the overlay reads its own size each frame and sizes the canvas
backing store to match, so it is sharp at any Browser Source dimensions and needs no setting.

Positions being fractions makes them resolution-independent already. Sprite geometry is authored
against a 720-tall stage and multiplied by `unit = height / 720`, so `scale` means the same thing
everywhere: the sprite covers a constant share of the source height, and `config.json` moves
between a 720p and a 4K setup unchanged. `FLEE_SPEED` is scaled the same way so the exit takes the
same time on screen.

Crucially, **one factor is applied to both axes.** The canvas was previously a fixed 1280×720
backing store stretched by CSS, which scales width and height independently — a Browser Source
that is not 16:9 squashed the sprite. A 4:3 or vertical source now positions correctly and keeps
the sprite square.

**`startPos` is not where KawKaw appears.** A session opens at `meter = 0`, so it emerges at the
*midpoint* of the track and is pushed outward from there. `startPos` is the flee end — where it
ends up only if chat shoos it all the way. The key names predate the distinction; the config page
labels them Flee and Lick.

Unlike game logic, these apply **immediately** rather than at the next encounter: repositioning or
re-levelling mid-encounter is harmless, so the streamer can tune against a live overlay.

---

## Dev Setup

```bash
cd src/backend
npm install
cp .env.example .env          # set CHANNEL to your Twitch login
npm run dev

# In OBS: add a Browser Source →
#   http://127.0.0.1:3000/overlay/
# Settings page (any browser) →
#   http://127.0.0.1:3000/config/config.html
```

No tunnel, no tokens, and no Twitch registration for the chat-command trigger.

### Enabling the redeem trigger

1. Register an application at [dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps). Set its OAuth Redirect URL to exactly `http://localhost:3000/auth/callback`.
2. Put its client id and secret in `.env` (`TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`) — these are the only secrets the project holds.
3. Set the trigger to `redeem` or `both` on the config page.
4. The backend prints an authorization link. Open it once and approve; the resulting token is stored in `tokens.json` (mode `0600`) and refreshed automatically from then on.

The redirect in step 4 is the **only** inbound request in the entire design, and it is live only for the seconds between clicking the link and Twitch redirecting back. It is pinned to a single-use random `state`, so a stray or forged redirect cannot trade in a code the backend never requested.

If the token is later revoked, the backend drops it and prints a fresh link rather than retrying a dead credential.

### Tests

```bash
for t in src/backend/*.test.js; do node "$t"; done
```

| File | Covers |
|---|---|
| `engine.test.js` | Meter math, shoo streak, per-user cap, all three terminals, staged config |
| `chat.test.js` | IRC parsing: commands, privilege badges, malformed lines |
| `config.test.js` | Validation, clamping, partial merges, prototype pollution |
| `eventsub.test.js` | Welcome/subscribe, dedup, reconnect migration, revocation — against a local fake Twitch |

Plain `assert`, no framework, no test dependencies.

---

## Implementation Order

1. `engine.js` — command batching, tick, meter update, terminals. Standalone and unit-testable.
2. `chat.js` — anonymous Twitch IRC reader (connect, JOIN, parse `!call`/`!shoo`/`!kawkaw`).
3. `server.js` — loopback HTTP + static serving + WebSocket state stream; wires chat → engine → broadcast.
4. Frontend overlay — HTML, CSS (canvas, meter display, confused bubble, connection-lost message).
5. Sprite engine — `sprites.js` coordinate map, canvas draw, frame animation.
6. Audio engine — `audio.js`, Web Audio API, pitch-shift playback.
7. Game renderer — `game.js`, state → animations + audio.
8. Transport — `main.js`, WebSocket client with auto-retry.
9. Config store — schema, validation, persistence; `/api/config` on the loopback server.
10. Config page — streamer settings UI (trigger, step, decay, timeout, cap, positions).
11. Redeem trigger — OAuth + EventSub WebSocket subscription.
