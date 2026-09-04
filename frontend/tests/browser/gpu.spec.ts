import { expect, test } from '@playwright/test';
import type {} from './probes';
import { attachReceipt } from './evidence';

test('production shader matches the independent synthetic pixel oracle', async ({ page, browserName }, info) => {
  await page.goto('/tests/browser/probes.html');
  await page.waitForFunction(() => Boolean(window.miraProbes));
  const result = await page.evaluate(() => window.miraProbes.gpu());
  const build = await (await page.request.get('/browser-build.json')).json();
  await attachReceipt(info, 'gpu-receipt', {
    ...build,
    browserName,
    browserVersion: page.context().browser()!.version(),
    evidence:
      'Independent pixel oracle and settled drawArrays-through-synchronized-readPixels timings on the named renderer; not whole-UI latency.',
    ...result,
  });
  expect(result.checks.filter((check) => !check.passed)).toEqual([]);
  expect(result.passed).toBe(true);
});
