// Run with an isolated local preview server and intercepted API fixtures.
import { chromium } from '../../revamp/node_modules/playwright/index.mjs';
import assert from 'node:assert/strict';

const base = process.env.STUDIO_TEST_BASE_URL || 'http://127.0.0.1:3013';
if (!['localhost', '127.0.0.1'].includes(new URL(base).hostname)) throw new Error('Use a loopback-only preview server');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
const errors = [];
let calls = 0;
page.on('pageerror', error => errors.push(error.message));
const makeCharacter = id => ({ id: `fixture-${id}`, name: `Character ${id}`, title: 'Fixture', bio: '', status: 'Draft', tags: [], updated: 'Today' });
await page.route('**/api/**', async route => {
  const url = new URL(route.request().url());
  if (url.pathname === '/api/characters') {
    calls++;
    const q = url.searchParams.get('q');
    const body = q ? { characters: [makeCharacter('Search result')], nextCursor: null }
      : url.searchParams.has('cursor') ? { characters: [makeCharacter('Second page')], nextCursor: null }
      : { characters: Array.from({ length: 30 }, (_, i) => makeCharacter(i)), nextCursor: 'second-page' };
    return route.fulfill({ json: body });
  }
  return route.fulfill({ json: {} });
});
try {
  await page.goto(base);
  await page.getByRole('button', { name: /Character 0/ }).waitFor();
  assert.equal(calls, 1, 'second page must wait for scrolling');
  await page.locator('.character-list').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await page.getByRole('button', { name: /Character Second page/ }).waitFor();
  assert.equal(calls, 2);
  await page.getByPlaceholder('Search characters').fill('Search result');
  await page.getByRole('button', { name: /Character Search result/ }).waitFor();
  assert.equal(await page.getByRole('button', { name: /Character Second page/ }).count(), 0);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  assert.deepEqual(errors, []);
  console.log('Character scrolling, search reset, and mobile layout passed.');
} finally { await browser.close(); }
