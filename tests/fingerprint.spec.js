import { test, expect } from '@playwright/test';

/** Accept consent and wait for fingerprint pipeline to finish */
async function acceptAndWait(page) {
  await page.getByRole('button', { name: /I Consent/i }).click();
  await page.locator('#sal-container.visible').waitFor({ timeout: 25_000 });
}

// ─────────────────────────────────────────────────────────────
// Fingerprint Pipeline
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
    const graphReq = requests.find(u => u.includes('/graph'));
    expect(graphReq).toBeTruthy();
  });
});
