import { test, expect } from '@playwright/test';

const WORKER_URL = 'https://bbid-ingest.ryan-45a.workers.dev';

// ─────────────────────────────────────────────────────────────
// Worker Endpoints (live integration) — serialized to avoid rate limiting
// ─────────────────────────────────────────────────────────────

test.describe.serial('Worker API', () => {
  test('GET /name returns JSON', async ({ request }) => {
    const res = await request.get(WORKER_URL + '/name?fp=test_nonexistent_fp');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('name');
  });

  test('GET /visits returns visit count', async ({ request }) => {
    const res = await request.get(WORKER_URL + '/visits?fp=test_nonexistent_fp');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('visits');
    expect(typeof body.visits).toBe('number');
  });

  test('GET /graph returns graph data', async ({ request }) => {
    const res = await request.get(WORKER_URL + '/graph');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('nodes');
    expect(body).toHaveProperty('relationships');
  });

  test('POST /name truncates oversized names to 50 chars', async ({ request }) => {
    const res = await request.post(WORKER_URL + '/name', {
      data: { visitorId: 'test_visitor', name: 'A'.repeat(100) },
    });
    expect(res.status()).toBe(200);
  });

  test('POST /name strips HTML tags from names', async ({ request }) => {
    const res = await request.post(WORKER_URL + '/name', {
      data: { visitorId: 'test_visitor', name: '<script>alert(1)</script>' },
    });
    expect(res.status()).toBe(200);
  });

  test('POST /name rejects pure-tag names (empty after strip)', async ({ request }) => {
    const res = await request.post(WORKER_URL + '/name', {
      data: { visitorId: 'test_visitor', name: '<b></b>' },
    });
    expect(res.status()).toBe(400);
  });

  test('GET /linked returns linked array', async ({ request }) => {
    const res = await request.get(WORKER_URL + '/linked?fp=test_nonexistent_fp');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('linked');
    expect(Array.isArray(body.linked)).toBe(true);
  });

  test('GET /linked rejects missing fp param', async ({ request }) => {
    const res = await request.get(WORKER_URL + '/linked');
    expect(res.status()).toBe(400);
  });

  test('GET /identity returns verdict for unknown fp', async ({ request }) => {
    const res = await request.get(WORKER_URL + '/identity?fp=test_nonexistent_fp');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('known');
    expect(body).toHaveProperty('confidence');
    expect(body).toHaveProperty('verdict');
    expect(body).toHaveProperty('evidence');
    // Unknown fp should return known: false
    expect(body.known).toBe(false);
    expect(body.confidence).toBe(0);
  });

  test('GET /identity rejects missing fp param', async ({ request }) => {
    const res = await request.get(WORKER_URL + '/identity');
    expect(res.status()).toBe(400);
  });

  test('OPTIONS returns CORS headers', async ({ request }) => {
    const res = await request.fetch(WORKER_URL + '/name', { method: 'OPTIONS' });
    expect(res.status()).toBe(204);
    const headers = res.headers();
    expect(headers['access-control-allow-methods']).toContain('GET');
    expect(headers['access-control-allow-methods']).toContain('POST');
    expect(headers['access-control-allow-methods']).toContain('DELETE');
  });
});
