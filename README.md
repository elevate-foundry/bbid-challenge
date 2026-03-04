# BBID Challenge — Braille-Binary Identity Detection

> Can we identify you without cookies, login, or tracking pixels? Just math + braille.

## What This Is

A single-page application that demonstrates **BBID (Braille-Binary Identity)** — a device fingerprinting system that encodes behavioral biometrics into braille patterns.

**Live:** [elevate-foundry.github.io/bbid-challenge](https://elevate-foundry.github.io/bbid-challenge)

## How It Works

1. **Device Fingerprinting** — Canvas, WebGL, hardware, screen, timing signals → SHA-256 hash
2. **BBES Encoding** — Hash is encoded into 8-dot braille Unicode characters (U+2800–U+28FF)
3. **Behavioral Biometrics** — Mouse dynamics, keystroke rhythm, scroll velocity, touch pressure, interaction entropy
4. **Identity Graph** — All data structured as graph-ready JSON for Neo4j ingestion

## The Challenge

Visit the page. Then try to fool it:
- Incognito mode
- Different browser
- VPN
- User-agent spoofing
- Resize your window

The system will tell you how confident it is that you're the same person.

## Graph Data Model

```cypher
(:Visitor)-[:HAS_DEVICE]->(:Device)
(:Device)-[:HAS_FINGERPRINT]->(:Fingerprint)
(:Visitor)-[:SESSION]->(:Session)
(:Session)-[:FROM_DEVICE]->(:Device)
(:Session)-[:HAS_BEHAVIOR]->(:Behavior)
```

## Tech Stack

- **Zero dependencies** — Pure HTML/CSS/JS, no build step
- **BBES Codec** — Braille Binary Encoding Standard
- **Graph-ready** — Export JSON structured for Neo4j ingestion
- **Haptic feedback** — Feel your fingerprint as braille vibrations (mobile)

## Deploy to GitHub Pages

```bash
git init
git add .
git commit -m "initial bbid challenge"
git remote add origin git@github.com:elevate-foundry/bbid-challenge.git
git push -u origin main
# Enable GitHub Pages in repo settings → Source: main branch
```

## Backend (Coming Soon)

- **Neo4j Aura Free** — Graph database for visitor identity relationships
- **Cloudflare Worker** — Thin proxy to ingest fingerprint POSTs into Neo4j

## Part of the Braille Ecosystem

- [BrailleBuddy](https://braillebuddy.vercel.app/) — Interactive braille learning
- [BrailleFST](https://github.com/elevate-foundry/braille) — Finite State Transducer for braille encoding
- BBES Codec — Braille Binary Encoding Standard

## License

MIT — Elevate Foundry
