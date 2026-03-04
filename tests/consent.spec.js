import { test, expect } from '@playwright/test';

/** Accept consent and wait for fingerprint pipeline to finish */
async function acceptAndWait(page) {
  await page.getByRole('button', { name: /I Consent/i }).click();
  await page.locator('#sal-container.visible').waitFor({ timeout: 25_000 });
}

// ─────────────────────────────────────────────────────────────
// GDPR Consent Flow
// ─────────────────────────────────────────────────────────────

test.describe('GDPR Consent', () => {
  test('consent overlay blocks page on first visit', async ({ page }) => {
    await page.goto('/');
    const overlay = page.locator('#consent-overlay');
    await expect(overlay).toBeVisible();
    await expect(overlay).not.toHaveClass(/hidden/);
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
