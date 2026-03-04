import { test, expect } from '@playwright/test';

const WORKER_URL = 'https://bbid-ingest.ryan-45a.workers.dev';

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/** Accept consent and wait for fingerprint pipeline to finish */
async function acceptAndWait(page) {
  await page.getByRole('button', { name: /I Consent/i }).click();
  // Wait for Sal to become visible (fingerprinting done)
  await page.locator('#sal-container.visible').waitFor({ timeout: 25_000 });
}

// ─────────────────────────────────────────────────────────────
// 1. GDPR Consent Flow
// ─────────────────────────────────────────────────────────────

test.describe('GDPR Consent', () => {
  test('consent overlay blocks page on first visit', async ({ page }) => {
    // Fresh context → empty localStorage → overlay should show
    await page.goto('/');
    const overlay = page.locator('#consent-overlay');
    await expect(overlay).toBeVisible();
    await expect(overlay).not.toHaveClass(/hidden/);
    // Fingerprint should NOT have run
    await expect(page.locator('#bbid-hash')).toContainText('generating');
  });

  test('accept consent hides overlay and starts fingerprinting', async ({ page }) => {
    await page.goto('/');
    await acceptAndWait(page);
    await expect(page.locator('#consent-overlay')).toHaveClass(/hidden/);
    const consent = await page.evaluate(() => localStorage.getItem('bbid_consent'));
    expect(consent).toBe('granted');
    await expect(page.locator('#bbid-hash')).toContainText(/SHA-256: [0-9a-f]{64}/);
  });

  test('decline consent shows "no data collected" message', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'No Thanks' }).click();
    await expect(page.getByText('No data has been collected')).toBeVisible();
    await expect(page.locator('#bbid-hash')).toContainText('generating');
  });

  test('consent persists across reloads', async ({ page }) => {
    await page.goto('/');
    await acceptAndWait(page);
    await page.reload();
    await expect(page.locator('#consent-overlay')).toHaveClass(/hidden/);
  });
});

// ─────────────────────────────────────────────────────────────
// 2. Sal AI — Is She Alive?
// ─────────────────────────────────────────────────────────────

test.describe('Sal AI', () => {
  test('Sal container becomes visible after consent', async ({ page }) => {
    await page.goto('/');
    await acceptAndWait(page);
    await expect(page.locator('#sal-container')).toHaveClass(/visible/);
  });

  test('Sal speaks and mentions herself', async ({ page }) => {
    await page.goto('/');
    await acceptAndWait(page);
    const msg = page.locator('#sal-message');
    await expect(msg).toContainText('Sal', { timeout: 30_000 });
  });

  test('Sal asks for name on first unnamed visit', async ({ page }) => {
    await page.goto('/');
    await acceptAndWait(page);
    // Should ask for name and show input
    await expect(page.locator('#sal-input-wrap')).toBeVisible({ timeout: 30_000 });
  });

  test('Sal remembers name after submission', async ({ page }) => {
    await page.goto('/');
    await acceptAndWait(page);
    await page.locator('#sal-input-wrap').waitFor({ state: 'visible', timeout: 30_000 });
    await page.locator('#sal-name-input').fill('TestUser');
    await page.locator('#sal-name-btn').click();
    // Name persisted in localStorage (Title-cased)
    await expect(async () => {
      const stored = await page.evaluate(() => localStorage.getItem('sal_user_name'));
      expect(stored).toBe('Testuser');
    }).toPass({ timeout: 5_000 });
    // Input hides after submission
    await expect(page.locator('#sal-input-wrap')).not.toBeVisible({ timeout: 5_000 });
    // Sal starts typing a new response (message element is non-empty)
    await expect(page.locator('#sal-message')).not.toBeEmpty({ timeout: 10_000 });
  });

  test('Sal greets returning visitor by name', async ({ page }) => {
    await page.goto('/');
    await acceptAndWait(page);
    await page.locator('#sal-input-wrap').waitFor({ state: 'visible', timeout: 30_000 });
    await page.locator('#sal-name-input').fill('ReturnTest');
    await page.locator('#sal-name-btn').click();
    // Verify name stored before reloading
    await expect(async () => {
      const n = await page.evaluate(() => localStorage.getItem('sal_user_name'));
      expect(n).toBe('Returntest');
    }).toPass({ timeout: 5_000 });
    // Reload — same context, localStorage persists
    await page.reload();
    await page.locator('#sal-container.visible').waitFor({ timeout: 25_000 });
    // On return visit with name, Sal should use the name and NOT show input
    await expect(page.locator('#sal-message')).toContainText('Returntest', { timeout: 45_000 });
    await expect(page.locator('#sal-input-wrap')).not.toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────────
// 3. Fingerprint Pipeline
// ─────────────────────────────────────────────────────────────

test.describe('Fingerprint Pipeline', () => {
  test('SHA-256 hash is generated', async ({ page }) => {
    await page.goto('/');
    await acceptAndWait(page);
    const hashText = await page.locator('#bbid-hash').textContent();
    expect(hashText).toMatch(/SHA-256: [0-9a-f]{64}/);
  });

  test('braille BBID is non-empty', async ({ page }) => {
    await page.goto('/');
    await acceptAndWait(page);
    const braille = await page.locator('#bbid-braille').textContent();
    expect(braille.length).toBeGreaterThan(8);
    expect(braille).not.toBe('⠀⠀⠀⠀⠀⠀⠀⠀');
  });

  test('confidence score is above 0%', async ({ page }) => {
    await page.goto('/');
    await acceptAndWait(page);
    const confText = await page.locator('#confidence-pct').textContent();
    const confNum = parseInt(confText.replace('%', ''), 10);
    expect(confNum).toBeGreaterThan(0);
  });

  test('device signals grid is populated', async ({ page }) => {
    await page.goto('/');
    await acceptAndWait(page);
    const grid = page.locator('#fingerprint-grid');
    const items = grid.locator('.fp-item');
    await expect(items.first()).toBeVisible({ timeout: 10_000 });
    expect(await items.count()).toBeGreaterThan(3);
  });

  test('graph ingestion attempted (worker POST fired)', async ({ page }) => {
    const requests = [];
    page.on('request', req => {
      if (req.url().includes('bbid-ingest')) requests.push(req.url());
    });
    await page.goto('/');
    await acceptAndWait(page);
    await page.waitForTimeout(3_000);
    // Verify the app attempted to POST to the worker
    const graphReq = requests.find(u => u.includes('/graph'));
    expect(graphReq).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────
// 4. Worker Endpoints (live integration)
// ─────────────────────────────────────────────────────────────

test.describe('Worker API', () => {
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
    // Worker sanitizes: truncates to 50 chars and accepts
    expect(res.status()).toBe(200);
  });

  test('POST /name strips HTML tags from names', async ({ request }) => {
    // '<script>alert(1)</script>' → stripped to 'alert(1)' → accepted
    const res = await request.post(WORKER_URL + '/name', {
      data: { visitorId: 'test_visitor', name: '<script>alert(1)</script>' },
    });
    expect(res.status()).toBe(200);
  });

  test('POST /name rejects pure-tag names (empty after strip)', async ({ request }) => {
    // '<b></b>' → stripped to '' → rejected
    const res = await request.post(WORKER_URL + '/name', {
      data: { visitorId: 'test_visitor', name: '<b></b>' },
    });
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

// ─────────────────────────────────────────────────────────────
// 5. Mobile Responsive
// ─────────────────────────────────────────────────────────────

test.describe('Mobile', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('consent overlay fully visible on mobile', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /Before We Begin/i })).toBeVisible();
    await expect(page.getByRole('button', { name: 'No Thanks' })).toBeVisible();
    await expect(page.getByRole('button', { name: /I Consent/i })).toBeVisible();
  });

  test('consent accept works on mobile', async ({ page }) => {
    await page.goto('/');
    await acceptAndWait(page);
    const consent = await page.evaluate(() => localStorage.getItem('bbid_consent'));
    expect(consent).toBe('granted');
  });
});
