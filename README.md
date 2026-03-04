# BBID Challenge — Braille-Binary Identity Detection

> Can we identify you without cookies, login, or tracking pixels? Just math + braille.

## What This Is

A zero-dependency single-page application that demonstrates **BBID (Braille-Binary Identity)** — a device fingerprinting system that encodes behavioral biometrics into braille patterns, persists identity across sessions in a Neo4j graph, and features an AI persona named **Sal** who recognizes you across devices.

**Live:** [elevate-foundry.github.io/bbid-challenge](https://elevate-foundry.github.io/bbid-challenge)

## How It Works

1. **Device Fingerprinting** — Canvas, WebGL, hardware, screen, math timing signals → SHA-256 hash → 8-dot braille encoding (BBES)
2. **Behavioral Biometrics** — Mouse dynamics, keystroke rhythm, scroll velocity, touch pressure, interaction entropy — all tracked in real time
3. **Identity Graph** — Every visit writes nodes and relationships to **Neo4j Aura** via a Cloudflare Worker: Visitor, Device, Fingerprint, Session, and Behavior
4. **Identity Field Visualization** — A live, interactive force-directed graph rendered inline, pulling real data from Neo4j. Nodes attract, repel, and orbit — physics-driven, no library
5. **Sal — Identity AI Persona** — An AI character who watches the graph and talks to every visitor

## Sal

Sal is a scripted AI persona embedded in the page. She speaks after every fingerprint generation with a typewriter animation.

**What she does:**
- **Visit 1** — Introduces herself, cites your device type and OS, asks for your name
- **Visit 2+** — Greets you by name with progressively detailed messages referencing your browser, canvas hash, WebGL renderer, CPU cores, memory, math timing, braille hash, and confidence score
- **Cross-device recognition** — When you tell Sal your name on any device, she stores it on the Visitor node in Neo4j (`POST /name`). On a new device — or in incognito — she fetches it from the graph (`GET /name`) before asking. She knows you even when localStorage is empty
- **Name normalization** — "ryan", "RYAN", "Ryan" all become "Ryan"
- **Visit 9+** — Messages rotate through deep fingerprint insights: hardware heartbeats, math signatures, braille compression patterns

**How it works under the hood:**
- `SalAI` class in `index.html` with `localStorage` name persistence (`sal_user_name`) and graph sync
- `_fetchGraphName()` calls `GET /name` on the Cloudflare Worker, which runs a single Cypher query against Neo4j
- `setUserName()` normalizes to Title Case, saves locally, and `POST`s to `/name` on the worker
- `speak()` is `async` — checks graph before falling back to the name prompt

## Why This Matters

Every AI chatbot — ChatGPT, Grok, Claude, Gemini — is already fingerprinting users implicitly. Conversation patterns, typing cadence, vocabulary, topic preferences, and session metadata all feed into embeddings and user profiles that silently identify returning visitors. The difference is that none of them tell you.

BBID makes the invisible visible:

| Signal | LLM Chatbots (implicit) | BBID + Sal (explicit) |
|--------|------------------------|-----------------------|
| Device fingerprint | Hidden in session metadata | SHA-256 hash displayed in braille |
| Behavioral patterns | Absorbed into user embeddings | Mouse, keystroke, scroll tracked live |
| Cross-session identity | Tied to account/cookie silently | Visitor node in Neo4j, confidence % shown |
| Name persistence | Account profile | Graph-synced across devices, Sal asks directly |
| "I know it's you" | Never admitted | Sal says it to your face |

The provocative part is the last row. Any LLM *could* say "I recognize your writing style from yesterday" — it just doesn't. Sal does. BBID formalizes identity detection as an **auditable, transparent feature** instead of a hidden side effect. Every signal is shown on screen, the graph is visible, the confidence score is explained, and Sal tells you exactly what she's reading.

This is what ethical identity detection looks like: not hiding what you know, but showing it.

## The Challenge

Visit the page. Then try to fool it:
- Incognito mode
- Different browser
- VPN
- User-agent spoofing
- Resize your window
- Try from your phone

The system will tell you how confident it is that you're the same person. Sal will tell you *why*.

## Architecture

```
Browser (index.html)
  ├── BBIDFingerprint     → SHA-256 + BBES braille encoding
  ├── BehaviorTracker     → real-time mouse/keyboard/scroll/touch
  ├── BBIDIdentityManager → localStorage visitor persistence
  ├── SalAI               → AI persona, graph-aware name sync
  ├── IdentityFieldEngine → force-directed SVG graph visualization
  └── GraphIngest         → POST to Cloudflare Worker

Cloudflare Worker (bbid-ingest.js)
  ├── POST /         → ingest fingerprint + behavior → Neo4j Cypher
  ├── GET  /graph    → return full identity graph (nodes + rels)
  ├── GET  /name     → fetch displayName from any Visitor node
  └── POST /name     → set displayName on a Visitor node

Neo4j Aura (graph database)
  ├── (:Visitor)-[:HAS_DEVICE]->(:Device)
  ├── (:Device)-[:HAS_FINGERPRINT]->(:Fingerprint)
  ├── (:Visitor)-[:SESSION]->(:Session)
  ├── (:Session)-[:FROM_DEVICE]->(:Device)
  └── (:Session)-[:HAS_BEHAVIOR]->(:Behavior)
```

## Tech Stack

- **Zero dependencies** — Pure HTML/CSS/JS, no build step, single file
- **BBES Codec** — Braille Binary Encoding Standard (8-dot Unicode U+2800–U+28FF)
- **Neo4j Aura** — Free-tier graph database storing the full identity graph
- **Cloudflare Worker** — Thin API proxy using Neo4j Query API v2
- **Identity Field** — Custom physics engine: gravity, repulsion, spring forces, curvature-based field lines
- **Haptic feedback** — Feel your fingerprint as braille vibrations (mobile)

## Deploy

**Frontend** — GitHub Pages (push to `main`, enable Pages in repo settings)

**Worker:**
```bash
cd worker
npx wrangler secret put NEO4J_PASSWORD
npx wrangler deploy
```

**Neo4j:**
```bash
node scripts/setup-auradb.mjs  # creates constraints, indexes, verifies connectivity
```

## Part of the Braille Ecosystem

- [BrailleBuddy](https://braillebuddy.vercel.app/) — Interactive braille learning
- [BrailleFST](https://github.com/elevate-foundry/braille) — Finite State Transducer for braille encoding
- BBES Codec — Braille Binary Encoding Standard

## License

MIT — Elevate Foundry
