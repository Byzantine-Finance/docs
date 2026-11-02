import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { options } from '../scripts/captures/options.mjs';

const directory = await mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), 'capture-test-'));
const routes = path.join(directory, 'routes.json');
await writeFile(routes, JSON.stringify([{ name: 'subject', route: '/guide' }]));
const args = ['--url', 'http://localhost:3000', '--routes', routes, '--output', directory, '--phase', 'after', '--source-sha', 'a'.repeat(40), '--browser', process.execPath];
test.after(() => rm(directory, { recursive: true, force: true }));

test('capture browser is verified, sandbox enabled by default and opt-out explicit', async () => {
  assert.ok(!(await options(args, {})).args.includes('--no-sandbox'));
  assert.ok((await options([...args, '--no-sandbox'], {})).args.includes('--no-sandbox'));
  await assert.rejects(options([...args.slice(0, -1), '/nonexistent-browser'], {}), /ENOENT/u);
  await assert.rejects(options([...args.slice(0, -1), directory], {}), /file/u);
});

test('capture fails closed on missing output, bad source, nonlocal routes or traversal names', async () => {
  await assert.rejects(options(args.filter((_, i) => ![4, 5].includes(i)), {}));
  await assert.rejects(options(args.map(x => x === 'a'.repeat(40) ? 'branch' : x), {}));
  for (const subject of [{ name: '../escape', route: '/guide' }, { name: 'escape', route: '//external.test' }]) {
    const invalid = path.join(directory, 'invalid.json');
    await writeFile(invalid, JSON.stringify([subject]));
    await assert.rejects(options(args.map(x => x === routes ? invalid : x), {}));
  }
});

test('capture CLI rejects invalid browser before launching', () => {
  const result = spawnSync(process.execPath, ['scripts/captures/docs.mjs', ...args.slice(0, -1), '/nonexistent-browser'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ENOENT.*nonexistent-browser/su);
  assert.doesNotMatch(result.stderr, /Cannot find module/u);
});
