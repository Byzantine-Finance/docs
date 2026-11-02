import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { options } from './options.mjs';

const config = await options(process.argv.slice(2));
await mkdir(config.output, { recursive: true });
const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } : undefined;
const browser = await chromium.launch({ executablePath: config.executablePath, headless: true, proxy, args: config.args });
const captures = [];
try {
  // Single desktop/light matrix for editorial documentation; no responsive or theme changes.
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, colorScheme: 'light', reducedMotion: 'reduce' });
  await context.addInitScript(() => localStorage.setItem('theme', 'light'));
  for (const subject of config.subjects) {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message.replaceAll(config.base, '<preview>/')));
    const response = await page.goto(new URL(subject.route, config.base).href, { waitUntil: 'networkidle', timeout: 60000 });
    assert.equal(response.status(), 200, subject.route);
    await page.locator('#content-area #page-title').waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => window.scrollTo(0, 0));
    const surface = page.locator(subject.selector ?? '#content-area');
    const box = await surface.boundingBox();
    assert.ok(box && box.width > 10 && box.height > 10, subject.route);
    // Use the article width even for a heading landmark; crop down from its document position.
    const article = await page.locator('#content-area').boundingBox();
    const extent = await page.evaluate(() => document.documentElement.scrollHeight);
    const crop = { x: article.x, y: Math.max(0, box.y - 8), width: article.width, height: Math.min(subject.maxHeight ?? box.height + 16, extent - Math.max(0, box.y - 8)) };
    const styling = await surface.evaluate(element => ({ font: getComputedStyle(element).fontFamily, stylesheets: document.styleSheets.length, fonts: document.fonts.status }));
    assert.ok(styling.stylesheets > 0 && styling.fonts === 'loaded');
    // Bound the raster itself: a full changelog bitmap can exhaust Chromium's GPU.
    // CDP clips in document coordinates without locator scrolling or a giant full-page image.
    const session = await context.newCDPSession(page);
    const screenshot = await session.send('Page.captureScreenshot', { format: 'webp', quality: 95,
      clip: { ...crop, scale: 1 }, captureBeyondViewport: true, fromSurface: true });
    await session.detach();
    const file = `${subject.name}-${config.phase}.webp`;
    await writeFile(path.join(config.output, file), Buffer.from(screenshot.data, 'base64'));
    captures.push({ subject: subject.name, route: subject.route, file, sourceCommit: config.sourceCommit, title: await page.title(), styling, crop, errors });
    await writeFile(path.join(config.output, `manifest-${config.phase}.json`), `${JSON.stringify(captures, null, 2)}\n`);
    console.log(`${file}: ${errors.length} page errors`);
    await page.close();
  }
  assert.equal(captures.length, config.subjects.length);
} finally { await browser.close(); }
