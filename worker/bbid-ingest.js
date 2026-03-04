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
  'http://127.0.0.1:8080'
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
const RATE_LIMIT_MAX = 30; // requests per window

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
