import { expect, test } from '../fixtures/muya';

// marktext #4100: an invalid inline-math formula now renders a gray
// .math-fallback placeholder inside the narrow inline-math popup; without
// `white-space: nowrap` the placeholder text wrapped across several lines and
// overflowed. (Originally targeted .mu-math-error; now applies to .math-fallback.)
test('invalid inline math placeholder stays on one line (#4100)', async ({ page }) => {
    await page.evaluate(() => window.muya!.setContent('inline $\\g$ math'));

    const el = page.locator('.math-fallback').first();
    await expect(el).toBeAttached();

    const whiteSpace = await el.evaluate(el => getComputedStyle(el).whiteSpace);
    expect(whiteSpace).toBe('nowrap');
});
