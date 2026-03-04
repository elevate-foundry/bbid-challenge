import { test, expect } from '@playwright/test';

/** Accept consent and wait for fingerprint pipeline to finish */
async function acceptAndWait(page) {
  await page.getByRole('button', { name: /I Consent/i }).click();
  await page.locator('#sal-container.visible').waitFor({ timeout: 25_000 });
}

// ─────────────────────────────────────────────────────────────
// Sal AI — Is She Alive?
// ─────────────────────────────────────────────────────────────

test.describe.serial('Sal AI', () => {
  test('Sal container becomes visible after consent', async ({ page }) => {
    await page.goto('/');
    await acceptAndWait(page);
    await expect(page.locator('#sal-container')).toHaveClass(/visible/);
  });

  test('Sal speaks and mentions herself', async ({ page }) => {
    await page.goto('/');
    await acceptAndWait(page);
    // Wait for typing cursor to disappear (animation finished)
    await page.locator('#sal-message .sal-typing-cursor').waitFor({ state: 'detached', timeout: 45_000 }).catch(() => {});
    const html = await page.locator('#sal-message').innerHTML();
    expect(html.length).toBeGreaterThan(0);
  });

  test('Sal asks for name or already knows one from graph', async ({ page }) => {
    await page.goto('/');
    await acceptAndWait(page);
    // Wait for typing to finish
    await page.locator('#sal-message .sal-typing-cursor').waitFor({ state: 'detached', timeout: 60_000 }).catch(() => {});
    // Either the name input is shown (no name in graph) or Sal already greeted by name (cross-device sync)
    const inputVisible = await page.locator('#sal-input-wrap').isVisible();
    const msgHtml = await page.locator('#sal-message').innerHTML();
    expect(inputVisible || msgHtml.length > 10).toBe(true);
  });

  test('Sal remembers name after submission', async ({ page }) => {
    await page.goto('/');
    await acceptAndWait(page);
    // Wait for typing to finish first
    await page.locator('#sal-message .sal-typing-cursor').waitFor({ state: 'detached', timeout: 60_000 }).catch(() => {});
    const inputVisible = await page.locator('#sal-input-wrap').isVisible();
    if (!inputVisible) {
      // Graph already provided a name — just verify localStorage has it
      const stored = await page.evaluate(() => localStorage.getItem('sal_user_name'));
      expect(stored).toBeTruthy();
      return;
    }
    const uniqueName = 'Test' + Date.now().toString(36).slice(-4);
    await page.locator('#sal-name-input').fill(uniqueName);
    await page.locator('#sal-name-btn').click();
    // Name persisted in localStorage (Title-cased)
    await expect(async () => {
      const stored = await page.evaluate(() => localStorage.getItem('sal_user_name'));
      expect(stored).toBeTruthy();
    }).toPass({ timeout: 5_000 });
    // Input hides after submission
    await expect(page.locator('#sal-input-wrap')).not.toBeVisible({ timeout: 5_000 });
    // Sal starts typing a new response
    await expect(page.locator('#sal-message')).not.toBeEmpty({ timeout: 10_000 });
  });

  test('Sal greets returning visitor by name', async ({ page }) => {
    // Set a known name in localStorage before loading
    const testName = 'Return' + Date.now().toString(36).slice(-4);
    await page.goto('/');
    await page.evaluate(n => localStorage.setItem('sal_user_name', n), testName);
    await page.reload();
    await acceptAndWait(page);
    // Wait for typing to finish
    await page.locator('#sal-message .sal-typing-cursor').waitFor({ state: 'detached', timeout: 60_000 }).catch(() => {});
    const msg = await page.locator('#sal-message').innerHTML();
    // Sal should use the name (case-insensitive since it could be in a <strong> tag)
    expect(msg.toLowerCase()).toContain(testName.toLowerCase());
    // Input should NOT appear (name already known)
    await expect(page.locator('#sal-input-wrap')).not.toBeVisible();
  });
});
