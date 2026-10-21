import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';

const base = process.env.CAPTURES_URL;
const phase = process.env.CAPTURES_PHASE;
const sourceCommit = process.env.CAPTURES_SOURCE_SHA;
assert.ok(base && ['before', 'after'].includes(phase));
assert.match(sourceCommit ?? '', /^[0-9a-f]{40}$/u);
const output = process.env.CAPTURES_OUT ?? 'images/pr/api-release-fb3952a';
await mkdir(output, { recursive: true });
const proxyUrl = process.env.HTTPS_PROXY;
const proxy = proxyUrl ? { server: proxyUrl, bypass: 'localhost,127.0.0.1' } : undefined;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, proxy, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const subjects = [
  ['transactions', '/api-reference/webhooks/transactions'],
  ['performance-reference', '/api-reference/endpoints-overview'],
  ['yield-en', '/currency-and-yield'],
  ['yield-fr', '/fr/currency-and-yield'],
  ['deposit-en', '/making-your-first-deposit'],
  ['deposit-fr', '/fr/making-your-first-deposit'],
  ['academy-en', '/documentation/about-byzantine/product-details'],
  ['academy-fr', '/fr/documentation/about-byzantine/product-details'],
  ['dashboard-en', '/get-to-know-your-dashboard'],
  ['dashboard-fr', '/fr/get-to-know-your-dashboard'],
];
if (phase === 'after') subjects.push(['performance-guide', '/api-reference/vault-performance']);
const captures = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, colorScheme: 'light', reducedMotion: 'reduce' });
  await context.addInitScript(() => localStorage.setItem('theme', 'light'));
  for (const [subject, route] of subjects) {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message.replaceAll(base, '<preview>')));
    const response = await page.goto(new URL(route, base).href, { waitUntil: 'networkidle', timeout: 60000 });
    assert.equal(response.status(), 200, route);
    await page.locator('#content-area #page-title').waitFor();
    await page.evaluate(() => document.fonts.ready);
    const surface = page.locator('#content-area');
    await page.evaluate(() => window.scrollTo(0, 0));
    const box = await surface.boundingBox();
    assert.ok(box.width > 400 && box.height > 100, route);
    const styling = await surface.evaluate(element => ({ font: getComputedStyle(element).fontFamily, stylesheets: document.styleSheets.length, fonts: document.fonts.status }));
    assert.ok(styling.stylesheets > 0 && styling.fonts === 'loaded');
    // Crop a full-page capture, avoiding locator auto-scroll that can put the
    // article title underneath Mintlify's fixed navigation bar.
    const png = await page.screenshot({ type: 'png', fullPage: true, animations: 'disabled' });
    const webp = await page.evaluate(async ({encoded, box}) => {
      const image = new Image();
      image.src = `data:image/png;base64,${encoded}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(box.width); canvas.height = Math.round(box.height);
      canvas.getContext('2d').drawImage(image, box.x, box.y, box.width, box.height, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/webp', 0.95).split(',')[1];
    }, {encoded: png.toString('base64'), box});
    const file = `${subject}-${phase}.webp`;
    await writeFile(path.join(output, file), Buffer.from(webp, 'base64'));
    captures.push({ subject, route, file, sourceCommit, title: await page.title(), styling, errors });
    await writeFile(path.join(output, `manifest-${phase}.json`), `${JSON.stringify(captures, null, 2)}\n`);
    console.log(`${subject}: ${file}, ${errors.length} page errors`);
    await page.close();
  }
  assert.equal(captures.length, subjects.length);
} finally { await browser.close(); }
