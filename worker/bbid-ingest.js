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
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400'
        }
      });
    }

    // Only accept POST
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    try {
      const payload = await request.json();

      // Validate required fields
      if (!payload.nodes || !payload.relationships) {
        return new Response(JSON.stringify({ error: 'Invalid payload: missing nodes or relationships' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
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
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });

    } catch (error) {
      console.error('Worker error:', error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }
  }
};
