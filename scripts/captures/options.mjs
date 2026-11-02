import assert from 'node:assert/strict';
import { access, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { parseArgs } from 'node:util';

export async function options(args, env = process.env) {
  const { values } = parseArgs({ args, options: {
    url: { type: 'string' }, routes: { type: 'string' }, output: { type: 'string' },
    phase: { type: 'string' }, 'source-sha': { type: 'string' }, browser: { type: 'string' },
    'no-sandbox': { type: 'boolean', default: false },
  } });
  const base = new URL(values.url ?? env.CAPTURES_URL);
  assert.ok(['http:', 'https:'].includes(base.protocol), 'HTTP(S) preview URL required');
  assert.ok(values.output, '--output is required');
  assert.ok(['before', 'after'].includes(values.phase), '--phase must be before or after');
  assert.match(values['source-sha'] ?? '', /^[0-9a-f]{40}$/u, '--source-sha must be a full commit SHA');
  const executablePath = values.browser ?? env.CHROMIUM_PATH ?? env.CAPTURES_BROWSER_PATH;
  assert.ok(executablePath, 'Pass --browser, CHROMIUM_PATH or CAPTURES_BROWSER_PATH');
  await access(executablePath, constants.X_OK);
  assert.ok((await stat(executablePath)).isFile(), 'Browser executable must be a file');
  const subjects = JSON.parse(await readFile(values.routes, 'utf8'));
  assert.ok(Array.isArray(subjects) && subjects.length, 'Nonempty routes JSON array required');
  assert.equal(new Set(subjects.map(x => x.name)).size, subjects.length, 'Unique subject names required');
  for (const subject of subjects) {
    assert.match(subject.name, /^[a-z0-9-]+$/u);
    assert.ok(subject.route?.startsWith('/') && !subject.route.startsWith('//'), 'Local preview routes only');
    if (subject.maxHeight !== undefined) assert.ok(Number.isInteger(subject.maxHeight) && subject.maxHeight > 0);
  }
  return { base: base.href, output: values.output, phase: values.phase, sourceCommit: values['source-sha'], executablePath, subjects,
    args: ['--disable-dev-shm-usage', ...(values['no-sandbox'] ? ['--no-sandbox'] : [])] };
}
