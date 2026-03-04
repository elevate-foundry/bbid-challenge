/**
 * BBID Ingest Worker — Cloudflare Worker
 * 
 * Receives fingerprint + behavior JSON from the BBID Challenge SPA
 * and writes it into Neo4j Aura as a graph.
 * 
 * Environment variables (set in Cloudflare dashboard):
 *   NEO4J_URI      - e.g. neo4j+s://xxxxxxxx.databases.neo4j.io
 *   NEO4J_USERNAME - usually "neo4j"
 *   NEO4J_PASSWORD - the password from Aura setup
 * 
 * Deploy: wrangler deploy
 */

// Allowed origins for CORS (restrict in production)
const ALLOWED_ORIGINS = [
  'https://elevate-foundry.github.io',
  'http://localhost:3000',
  'http://localhost:8080',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:8080',
  'http://localhost:4173',
  'http://127.0.0.1:4173'
];

function getCorsOrigin(request) {
  const origin = request.headers.get('Origin') || '';
  if (ALLOWED_ORIGINS.some(o => origin.startsWith(o))) return origin;
  return ALLOWED_ORIGINS[0]; // default to production
}

function corsHeaders(request) {
  return {
    'Access-Control-Allow-Origin': getCorsOrigin(request),
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  };
}

// Simple in-memory rate limiter (per-worker-isolate, resets on deploy)
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60_000; // 1 minute
const RATE_LIMIT_MAX = 60; // requests per window

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now - entry.start > RATE_LIMIT_WINDOW) {
    rateLimitMap.set(ip, { start: now, count: 1 });
    return true;
  }
  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) return false;
  return true;
}

// Neo4j Query API v2 endpoint (supported by Aura)
// Format: https://<dbid>.databases.neo4j.io/db/neo4j/query/v2

function getQueryApiUrl(boltUri) {
  const host = boltUri.replace('neo4j+s://', '').replace('bolt+s://', '');
  return `https://${host}/db/neo4j/query/v2`;
}

async function runCypher(env, statement, parameters = {}) {
  const url = getQueryApiUrl(env.NEO4J_URI);
  const auth = btoa(`${env.NEO4J_USERNAME}:${env.NEO4J_PASSWORD}`);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Basic ${auth}`,
      'Accept': 'application/json'
    },
    body: JSON.stringify({ statement, parameters })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Neo4j Query API error ${response.status}: ${text}`);
  }

  return response.json();
}

async function runCypherBatch(env, statements) {
  const results = [];
  for (const { statement, parameters } of statements) {
    results.push(await runCypher(env, statement, parameters || {}));
  }
  return results;
}

function buildCypherStatements(payload) {
  const statements = [];

  // Create/merge Visitor node
  const visitor = payload.nodes.find(n => n.label === 'Visitor');
  if (visitor) {
    statements.push({
      statement: `MERGE (v:Visitor {id: $id}) 
                  ON CREATE SET v.created = $created 
                  ON MATCH SET v.lastSeen = $created`,
      parameters: { id: visitor.id, created: visitor.properties.created }
    });
  }

  // Create/merge Device node
  const device = payload.nodes.find(n => n.label === 'Device');
  if (device) {
    statements.push({
      statement: `MERGE (d:Device {id: $id}) 
                  ON CREATE SET d += $props 
                  ON MATCH SET d.lastSeen = datetime()`,
      parameters: { id: device.id, props: device.properties }
    });
  }

  // Create/merge Fingerprint node
  const fp = payload.nodes.find(n => n.label === 'Fingerprint');
  if (fp) {
    statements.push({
      statement: `MERGE (f:Fingerprint {id: $id}) 
                  ON CREATE SET f += $props`,
      parameters: { id: fp.id, props: fp.properties }
    });
  }

  // Create Session node (always new)
  const session = payload.nodes.find(n => n.label === 'Session');
  if (session) {
    statements.push({
      statement: `CREATE (s:Session {id: $id}) SET s += $props`,
      parameters: { id: session.id, props: session.properties }
    });
  }

  // Create Behavior node
  if (payload.behavior) {
    statements.push({
      statement: `CREATE (b:Behavior {id: $id}) SET b += $props`,
      parameters: { id: payload.behavior.id, props: payload.behavior.properties }
    });
  }

  // Create relationships
  for (const rel of (payload.relationships || [])) {
    const props = rel.properties ? ', r += $props' : '';
    statements.push({
      statement: `MATCH (a {id: $from}), (b {id: $to}) 
                  MERGE (a)-[r:${rel.type}]->(b) 
                  ON CREATE SET r.created = datetime()${props}`,
      parameters: { from: rel.from, to: rel.to, ...(rel.properties ? { props: rel.properties } : {}) }
    });
  }

  // Link Session to Behavior
  if (payload.behavior && session) {
    statements.push({
      statement: `MATCH (s:Session {id: $sid}), (b:Behavior {id: $bid}) 
                  MERGE (s)-[:HAS_BEHAVIOR]->(b)`,
      parameters: { sid: session.id, bid: payload.behavior.id }
    });
  }

  return statements;
}

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    // Rate limiting
    const clientIp = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (!checkRateLimit(clientIp)) {
      return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
      });
    }

    const url = new URL(request.url);
    const cors = corsHeaders(request);

    // GET /graph — return identity subgraph for a visitor (or full graph if no visitorId)
    if (request.method === 'GET' && url.pathname === '/graph') {
      try {
        const vid = url.searchParams.get('visitorId');
        let nodesResult, relsResult;

        if (vid) {
          // Scoped subgraph: only this visitor and connected nodes
          nodesResult = await runCypher(env, `
            MATCH (v:Visitor {id: $vid})
            OPTIONAL MATCH (v)-[*1..2]-(n)
            WITH collect(DISTINCT n) + collect(DISTINCT v) AS allNodes
            UNWIND allNodes AS node
            RETURN labels(node)[0] AS label, node.id AS id, properties(node) AS props
          `, { vid });

          relsResult = await runCypher(env, `
            MATCH (v:Visitor {id: $vid})
            OPTIONAL MATCH (v)-[*1..2]-(n)
            WITH collect(DISTINCT n) + collect(DISTINCT v) AS allNodes
            UNWIND allNodes AS a
            MATCH (a)-[r]->(b) WHERE b IN allNodes
            RETURN a.id AS from, type(r) AS type, b.id AS to, properties(r) AS props
          `, { vid });
        } else {
          // Full graph (backward compat)
          nodesResult = await runCypher(env, `
            MATCH (n)
            WHERE n:Visitor OR n:Device OR n:Fingerprint OR n:Session OR n:Behavior
            RETURN labels(n)[0] AS label, n.id AS id, properties(n) AS props
            ORDER BY labels(n)[0], n.id
            LIMIT 500
          `);

          relsResult = await runCypher(env, `
            MATCH (a)-[r]->(b)
            WHERE (a:Visitor OR a:Device OR a:Fingerprint OR a:Session OR a:Behavior)
              AND (b:Visitor OR b:Device OR b:Fingerprint OR b:Session OR b:Behavior)
            RETURN a.id AS from, type(r) AS type, b.id AS to, properties(r) AS props
            LIMIT 1000
          `);
        }

        const nodes = (nodesResult.data?.values || []).map(row => ({
          label: row[0], id: row[1], properties: row[2]
        }));

        const relationships = (relsResult.data?.values || []).map(row => ({
          from: row[0], type: row[1], to: row[2], properties: row[3]
        }));

        return new Response(JSON.stringify({ nodes, relationships }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', ...cors }
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...cors }
        });
      }
    }

    // GET /name — retrieve display name scoped by fingerprint hash (cross-device sync)
    if (request.method === 'GET' && url.pathname === '/name') {
      try {
        const fpHash = url.searchParams.get('fp');
        let result;
        if (fpHash) {
          // Scoped: find visitor linked to this fingerprint
          result = await runCypher(env,
            `MATCH (v:Visitor)-[:HAS_DEVICE]->(:Device)-[:HAS_FINGERPRINT]->(f:Fingerprint {id: $fpHash})
             WHERE v.displayName IS NOT NULL
             RETURN v.displayName LIMIT 1`,
            { fpHash }
          );
        } else {
          // Fallback: any visitor with a name (backward compat)
          result = await runCypher(env,
            'MATCH (v:Visitor) WHERE v.displayName IS NOT NULL RETURN v.displayName LIMIT 1'
          );
        }
        const name = (result.data?.values || [])[0]?.[0] || '';
        return new Response(JSON.stringify({ name }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', ...cors }
        });
      } catch (error) {
        return new Response(JSON.stringify({ name: '', error: error.message }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', ...cors }
        });
      }
    }

    // GET /visits — graph-backed visit count for a visitor
    if (request.method === 'GET' && url.pathname === '/visits') {
      try {
        const fpHash = url.searchParams.get('fp');
        if (!fpHash) {
          return new Response(JSON.stringify({ error: 'Missing fp param' }), {
            status: 400, headers: { 'Content-Type': 'application/json', ...cors }
          });
        }
        const result = await runCypher(env,
          `MATCH (v:Visitor)-[:HAS_DEVICE]->(:Device)-[:HAS_FINGERPRINT]->(f:Fingerprint {id: $fpHash})
           OPTIONAL MATCH (v)-[:SESSION]->(s:Session)
           RETURN v.id AS visitorId, v.displayName AS name, count(s) AS visits`,
          { fpHash }
        );
        const row = (result.data?.values || [])[0];
        return new Response(JSON.stringify({
          visitorId: row?.[0] || '',
          name: row?.[1] || '',
          visits: row?.[2] || 0
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', ...cors }
        });
      } catch (error) {
        return new Response(JSON.stringify({ visitorId: '', name: '', visits: 0, error: error.message }), {
          status: 200, headers: { 'Content-Type': 'application/json', ...cors }
        });
      }
    }

    // POST /name — set display name on a Visitor node (cross-device sync)
    if (request.method === 'POST' && url.pathname === '/name') {
      try {
        const { visitorId, name } = await request.json();
        if (!visitorId || !name) {
          return new Response(JSON.stringify({ error: 'Missing visitorId or name' }), {
            status: 400, headers: { 'Content-Type': 'application/json', ...cors }
          });
        }
        // Sanitize: max 50 chars, strip HTML
        const clean = name.trim().replace(/<[^>]*>/g, '').substring(0, 50);
        if (!clean) {
          return new Response(JSON.stringify({ error: 'Invalid name' }), {
            status: 400, headers: { 'Content-Type': 'application/json', ...cors }
          });
        }
        await runCypher(env,
          'MATCH (v:Visitor {id: $visitorId}) SET v.displayName = $name RETURN v.id',
          { visitorId, name: clean }
        );
        return new Response(JSON.stringify({ status: 'ok' }), {
          status: 200, headers: { 'Content-Type': 'application/json', ...cors }
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500, headers: { 'Content-Type': 'application/json', ...cors }
        });
      }
    }

    // DELETE /visitor — right to erasure (GDPR Article 17)
    if (request.method === 'DELETE' && url.pathname === '/visitor') {
      try {
        const { visitorId } = await request.json();
        if (!visitorId) {
          return new Response(JSON.stringify({ error: 'Missing visitorId' }), {
            status: 400, headers: { 'Content-Type': 'application/json', ...cors }
          });
        }
        // Delete visitor and all connected nodes (sessions, behaviors)
        await runCypher(env,
          `MATCH (v:Visitor {id: $visitorId})
           OPTIONAL MATCH (v)-[:SESSION]->(s:Session)-[:HAS_BEHAVIOR]->(b:Behavior)
           DETACH DELETE b, s`,
          { visitorId }
        );
        await runCypher(env,
          `MATCH (v:Visitor {id: $visitorId}) DETACH DELETE v`,
          { visitorId }
        );
        return new Response(JSON.stringify({ status: 'deleted', visitorId }), {
          status: 200, headers: { 'Content-Type': 'application/json', ...cors }
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500, headers: { 'Content-Type': 'application/json', ...cors }
        });
      }
    }

    // GET /identity — server-side confidence loop
    // Queries graph topology to compute a unified identity verdict
    if (request.method === 'GET' && url.pathname === '/identity') {
      try {
        const fpHash = url.searchParams.get('fp');
        if (!fpHash) {
          return new Response(JSON.stringify({ error: 'Missing fp param' }), {
            status: 400, headers: { 'Content-Type': 'application/json', ...cors }
          });
        }

        // 1. Core identity: visitor, device, fingerprint, session history
        const coreResult = await runCypher(env, `
          MATCH (v:Visitor)-[:HAS_DEVICE]->(d:Device)-[:HAS_FINGERPRINT]->(f:Fingerprint {id: $fpHash})
          OPTIONAL MATCH (v)-[:SESSION]->(s:Session)
          WITH v, d, f, collect(s) AS sessions
          RETURN v.id AS vid, v.displayName AS name, v.created AS created, v.lastSeen AS lastSeen,
                 d.type AS deviceType, d.os AS os, d.browser AS browser,
                 d.timezone AS tz, d.language AS lang,
                 d.cores AS cores, d.memory AS mem,
                 d.screenW AS sw, d.screenH AS sh, d.pixelRatio AS pr,
                 f.sha256 AS sha256, f.canvas AS canvas, f.webgl AS webgl, f.mathTiming AS mathTiming,
                 size(sessions) AS sessionCount,
                 CASE WHEN size(sessions) > 0
                   THEN sessions[size(sessions)-1].started
                   ELSE null END AS lastSession,
                 CASE WHEN size(sessions) > 1
                   THEN sessions[0].started
                   ELSE null END AS firstSession
        `, { fpHash });

        const core = (coreResult.data?.values || [])[0];
        if (!core) {
          return new Response(JSON.stringify({
            known: false,
            confidence: 0,
            verdict: 'unknown',
            evidence: [],
            identity: null
          }), { status: 200, headers: { 'Content-Type': 'application/json', ...cors } });
        }

        const [vid, name, created, lastSeen, deviceType, os, browser, tz, lang,
               cores, mem, sw, sh, pr, sha256, canvas, webgl, mathTiming,
               sessionCount, lastSession, firstSession] = core;

        // 2. Graph topology: LIKELY_SAME_AS paths (transitive, up to 3 hops)
        const linkedResult = await runCypher(env, `
          MATCH (v:Visitor {id: $vid})
          OPTIONAL MATCH path = (v)-[:LIKELY_SAME_AS*1..3]-(v2:Visitor)
          WHERE v2.id <> $vid
          WITH DISTINCT v2, 
               reduce(c = 1.0, r IN relationships(path) | c * r.confidence) AS pathConfidence
          OPTIONAL MATCH (v2)-[:HAS_DEVICE]->(d2:Device)
          OPTIONAL MATCH (v2)-[:SESSION]->(s2:Session)
          WITH v2, d2, pathConfidence, count(s2) AS sessions
          RETURN v2.id AS vid, v2.displayName AS name,
                 d2.type AS deviceType, d2.os AS os, d2.browser AS browser,
                 pathConfidence, sessions
          ORDER BY pathConfidence DESC
          LIMIT 10
        `, { vid });

        const linkedIdentities = (linkedResult.data?.values || []).map(row => ({
          visitorId: row[0],
          displayName: row[1] || null,
          deviceType: row[2] || null,
          os: row[3] || null,
          browser: row[4] || null,
          pathConfidence: Math.round((row[5] || 0) * 100) / 100,
          sessions: row[6] || 0
        }));

        // 3. Behavioral consistency: check if behavior nodes exist
        const behaviorResult = await runCypher(env, `
          MATCH (v:Visitor {id: $vid})-[:SESSION]->(s:Session)-[:HAS_BEHAVIOR]->(b:Behavior)
          RETURN count(b) AS behaviorCount,
                 avg(b.mouseMovements) AS avgMouse,
                 avg(b.avgKeyTiming) AS avgKeyTiming,
                 collect(b.entropy)[0..5] AS entropyHistory
        `, { vid });

        const bRow = (behaviorResult.data?.values || [])[0];
        const behaviorCount = bRow?.[0] || 0;
        const avgMouse = bRow?.[1] || 0;
        const avgKeyTiming = bRow?.[2] || 0;
        const entropyHistory = bRow?.[3] || [];

        // ─── Server-Side Confidence Computation ───
        // This is the decision layer that closes the loop.
        // Each signal contributes independently; the graph topology
        // provides evidence that a table-based system cannot.

        let confidence = 0;
        const evidence = [];

        // Signal 1: Fingerprint stability (same hash across sessions)
        // If they have multiple sessions with the same fingerprint, the device is stable.
        if (sessionCount >= 1) {
          const sessionWeight = Math.min(0.25, sessionCount * 0.05);
          confidence += sessionWeight;
          evidence.push({
            signal: 'session_depth',
            value: sessionCount,
            weight: Math.round(sessionWeight * 100) / 100,
            detail: `${sessionCount} session${sessionCount > 1 ? 's' : ''} with stable fingerprint`
          });
        }

        // Signal 2: Temporal consistency (regular visitor vs one-off)
        if (firstSession && lastSession && sessionCount > 1) {
          const firstMs = new Date(firstSession).getTime();
          const lastMs = new Date(lastSession).getTime();
          const spanDays = Math.max(1, (lastMs - firstMs) / 86400000);
          const frequency = sessionCount / spanDays;
          const temporalWeight = Math.min(0.15, frequency * 0.05);
          confidence += temporalWeight;
          evidence.push({
            signal: 'temporal_consistency',
            value: Math.round(frequency * 100) / 100,
            weight: Math.round(temporalWeight * 100) / 100,
            detail: `${Math.round(spanDays)}d span, ${Math.round(frequency * 100) / 100} visits/day`
          });
        }

        // Signal 3: Hardware fingerprint entropy
        // More unique signals = higher confidence the fingerprint is distinctive
        const hardwareSignals = [canvas, webgl, mathTiming, cores, mem, sw, sh, pr, tz, lang].filter(Boolean);
        const entropyWeight = Math.min(0.20, hardwareSignals.length * 0.02);
        confidence += entropyWeight;
        evidence.push({
          signal: 'hardware_entropy',
          value: hardwareSignals.length,
          weight: Math.round(entropyWeight * 100) / 100,
          detail: `${hardwareSignals.length}/10 hardware signals captured`
        });

        // Signal 4: Behavioral biometrics available
        if (behaviorCount > 0) {
          const behaviorWeight = Math.min(0.10, behaviorCount * 0.03);
          confidence += behaviorWeight;
          evidence.push({
            signal: 'behavioral_biometrics',
            value: behaviorCount,
            weight: Math.round(behaviorWeight * 100) / 100,
            detail: `${behaviorCount} behavior sample${behaviorCount > 1 ? 's' : ''} recorded`
          });
        }

        // Signal 5: Cross-device graph links (this is the topology signal)
        // Each LIKELY_SAME_AS path adds confidence that this identity is corroborated
        if (linkedIdentities.length > 0) {
          const maxPathConf = linkedIdentities[0].pathConfidence;
          const linkWeight = Math.min(0.20, linkedIdentities.length * 0.06 + maxPathConf * 0.10);
          confidence += linkWeight;
          evidence.push({
            signal: 'cross_device_graph',
            value: linkedIdentities.length,
            weight: Math.round(linkWeight * 100) / 100,
            detail: `${linkedIdentities.length} linked identity node${linkedIdentities.length > 1 ? 's' : ''}, strongest path ${Math.round(maxPathConf * 100)}%`
          });
        }

        // Signal 6: Named identity (user volunteered their name)
        if (name) {
          confidence += 0.10;
          evidence.push({
            signal: 'named_identity',
            value: name,
            weight: 0.10,
            detail: `Self-identified as "${name}"`
          });
        }

        confidence = Math.round(Math.min(0.98, confidence) * 100) / 100;

        // Verdict
        let verdict;
        if (confidence >= 0.80) verdict = 'identified';
        else if (confidence >= 0.50) verdict = 'probable';
        else if (confidence >= 0.25) verdict = 'emerging';
        else verdict = 'weak';

        return new Response(JSON.stringify({
          known: true,
          confidence,
          verdict,
          evidence,
          identity: {
            visitorId: vid,
            displayName: name || null,
            deviceType: deviceType || null,
            os: os || null,
            browser: browser || null,
            sessions: sessionCount,
            firstSeen: firstSession || created || null,
            lastSeen: lastSession || lastSeen || null,
            fingerprintHash: sha256 || null
          },
          linkedIdentities,
          behaviorProfile: behaviorCount > 0 ? {
            samples: behaviorCount,
            avgMouseMovements: Math.round(avgMouse),
            avgKeyTiming: avgKeyTiming ? Math.round(avgKeyTiming * 10) / 10 : null,
            entropyHistory
          } : null
        }), {
          status: 200, headers: { 'Content-Type': 'application/json', ...cors }
        });

      } catch (error) {
        return new Response(JSON.stringify({
          known: false, confidence: 0, verdict: 'error',
          evidence: [], identity: null, error: error.message
        }), {
          status: 200, headers: { 'Content-Type': 'application/json', ...cors }
        });
      }
    }

    // GET /linked — cross-device identity linking
    if (request.method === 'GET' && url.pathname === '/linked') {
      try {
        const fpHash = url.searchParams.get('fp');
        if (!fpHash) {
          return new Response(JSON.stringify({ error: 'Missing fp param' }), {
            status: 400, headers: { 'Content-Type': 'application/json', ...cors }
          });
        }

        // 1. Find the current visitor and their device signals
        const selfResult = await runCypher(env, `
          MATCH (v:Visitor)-[:HAS_DEVICE]->(d:Device)-[:HAS_FINGERPRINT]->(f:Fingerprint {id: $fpHash})
          RETURN v.id AS vid, v.displayName AS name,
                 d.timezone AS tz, d.os AS os, d.browser AS browser,
                 d.cores AS cores, d.memory AS mem, d.screenW AS sw, d.screenH AS sh,
                 d.language AS lang, d.type AS dtype, d.pixelRatio AS pr
        `, { fpHash });

        const self = (selfResult.data?.values || [])[0];
        if (!self) {
          return new Response(JSON.stringify({ linked: [], self: null }), {
            status: 200, headers: { 'Content-Type': 'application/json', ...cors }
          });
        }

        const [vid, displayName, tz, os, browser, cores, mem, sw, sh, lang, dtype, pr] = self;

        // 2. Find candidate visitors (different visitor, with device data)
        const candidatesResult = await runCypher(env, `
          MATCH (v2:Visitor)-[:HAS_DEVICE]->(d2:Device)-[:HAS_FINGERPRINT]->(f2:Fingerprint)
          WHERE v2.id <> $vid
          OPTIONAL MATCH (v2)-[:SESSION]->(s:Session)
          WITH v2, d2, f2, count(s) AS sessions
          RETURN v2.id AS vid, v2.displayName AS name,
                 d2.timezone AS tz, d2.os AS os, d2.browser AS browser,
                 d2.cores AS cores, d2.memory AS mem, d2.screenW AS sw, d2.screenH AS sh,
                 d2.language AS lang, d2.type AS dtype, d2.pixelRatio AS pr,
                 f2.id AS fpId, sessions
          LIMIT 50
        `, { vid });

        const candidates = (candidatesResult.data?.values || []);

        // 3. Score each candidate
        const linked = [];
        for (const c of candidates) {
          const [cVid, cName, cTz, cOs, cBrowser, cCores, cMem, cSw, cSh, cLang, cDtype, cPr, cFpId, cSessions] = c;
          let score = 0;
          let signals = [];

          // Name match (strongest signal)
          if (displayName && cName && displayName.toLowerCase() === cName.toLowerCase()) {
            score += 0.45;
            signals.push('name');
          }

          // Timezone match
          if (tz && cTz && tz === cTz) { score += 0.10; signals.push('timezone'); }

          // Language match
          if (lang && cLang && lang === cLang) { score += 0.08; signals.push('language'); }

          // OS family match
          if (os && cOs && os === cOs) { score += 0.08; signals.push('os'); }

          // Different device type is expected for cross-device (bonus)
          if (dtype && cDtype && dtype !== cDtype) { score += 0.05; signals.push('diff_device'); }

          // CPU cores match (weak but additive)
          if (cores && cCores && cores === cCores) { score += 0.04; signals.push('cores'); }

          // Memory match
          if (mem && cMem && mem === cMem) { score += 0.04; signals.push('memory'); }

          // Pixel ratio match
          if (pr && cPr && pr === cPr) { score += 0.03; signals.push('pixel_ratio'); }

          // Same browser across devices (weaker)
          if (browser && cBrowser && browser === cBrowser) { score += 0.03; signals.push('browser'); }

          // Screen size similarity (within 20%)
          if (sw && sh && cSw && cSh) {
            const area1 = sw * sh;
            const area2 = cSw * cSh;
            const ratio = Math.min(area1, area2) / Math.max(area1, area2);
            if (ratio > 0.8) { score += 0.02; signals.push('screen_similar'); }
          }

          const confidence = Math.min(0.98, score);

          // Only report candidates above 20% confidence
          if (confidence >= 0.20) {
            linked.push({
              visitorId: cVid,
              displayName: cName || null,
              deviceType: cDtype || null,
              os: cOs || null,
              browser: cBrowser || null,
              fingerprintId: cFpId,
              sessions: cSessions || 0,
              confidence: Math.round(confidence * 100) / 100,
              signals
            });

            // Create/update LIKELY_SAME_AS relationship in the graph
            if (confidence >= 0.35) {
              await runCypher(env, `
                MATCH (v1:Visitor {id: $v1}), (v2:Visitor {id: $v2})
                MERGE (v1)-[r:LIKELY_SAME_AS]->(v2)
                SET r.confidence = $conf, r.signals = $signals, r.updated = datetime()
              `, { v1: vid, v2: cVid, conf: confidence, signals: signals.join(',') });
            }
          }
        }

        // Sort by confidence descending
        linked.sort((a, b) => b.confidence - a.confidence);

        return new Response(JSON.stringify({
          self: { visitorId: vid, displayName: displayName || null },
          linked
        }), {
          status: 200, headers: { 'Content-Type': 'application/json', ...cors }
        });

      } catch (error) {
        return new Response(JSON.stringify({ error: error.message, linked: [] }), {
          status: 200, headers: { 'Content-Type': 'application/json', ...cors }
        });
      }
    }

    // Only accept POST for ingest
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405, headers: { 'Content-Type': 'application/json', ...cors }
      });
    }

    try {
      const payload = await request.json();

      // Validate required fields
      if (!payload.nodes || !payload.relationships) {
        return new Response(JSON.stringify({ error: 'Invalid payload: missing nodes or relationships' }), {
          status: 400, headers: { 'Content-Type': 'application/json', ...cors }
        });
      }

      // Build and execute Cypher statements
      const statements = buildCypherStatements(payload);
      const results = await runCypherBatch(env, statements);

      return new Response(JSON.stringify({ 
        status: 'ok', 
        message: 'Graph updated',
        nodesCreated: payload.nodes.length,
        relationshipsCreated: payload.relationships.length + (payload.behavior ? 1 : 0),
        statementsExecuted: results.length
      }), {
        status: 200, headers: { 'Content-Type': 'application/json', ...cors }
      });

    } catch (error) {
      console.error('Worker error:', error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500, headers: { 'Content-Type': 'application/json', ...cors }
      });
    }
  }
};
