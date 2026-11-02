import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = process.env.DOCS_ROOT ?? new URL('../', import.meta.url).pathname;
const text = file => readFile(path.join(root, file), 'utf8');
const spec = JSON.parse(await text('api-reference/openapi-integrator.json'));
const release = Boolean(spec.components.schemas.TransactionSummary);

// Named fences are stable even when a migration inserts an earlier JSON block.
function example(page, name) {
  const matches = [...page.matchAll(/```json +([^\n]+)\n([\s\S]*?)\n```/gu)].filter(m => m[1] === name);
  assert.equal(matches.length, 1, `exactly one named JSON example: ${name}`);
  return JSON.parse(matches[0][2]);
}

test('named JSON lookup ignores earlier examples, including French text', () => {
  for (const prefix of ['Before', 'Avant : l’exemple']) {
    const page = `${prefix}\n\`\`\`json\n{}\n\`\`\`\n\`\`\`json sample-v2\n{"payloadVersion":2}\n\`\`\``;
    assert.equal(example(page, 'sample-v2').payloadVersion, 2);
  }
  assert.throws(() => example('```json\n{}\n```', 'missing'));
});

test('explicit transaction v1/v2 migration examples and completed-transfer anchor', { skip: !release }, async () => {
  const page = await text('api-reference/webhooks/transactions.mdx');
  const before = example(page, 'transaction-v1-data');
  const sample = example(page, 'transaction-v2-completed');
  assert.equal(before.status, 'completed');
  assert.equal(sample.payloadVersion, 2);
  assert.equal(sample.data.status, undefined);
  assert.deepEqual(Object.keys(sample.data.transaction).sort(), Object.keys(spec.components.schemas.TransactionSummary.properties).sort());
  assert.equal(sample.type, `transaction.${sample.data.transaction.status}`);
  assert.ok(page.includes('data.status'));
  assert.ok(page.includes('## Example: completed transfer'));
  assert.ok((await text('api-reference/webhooks/overview.mdx')).includes('#example-completed-transfer'));
});

test('all APY/history migration responses explicitly named and schema-shaped', { skip: !release }, async () => {
  const page = await text('api-reference/vault-performance.mdx');
  for (const [name, schema] of [['apy-after', 'ApyResponse'], ['history-after', 'ApyHistoryResponse']]) {
    assert.deepEqual(Object.keys(example(page, name)).sort(), Object.keys(spec.components.schemas[schema].properties).sort());
  }
  assert.ok(example(page, 'apy-before').yearly_period_days);
  assert.ok(example(page, 'history-before').data[0].total_assets);
  for (const field of ['daily_apy', 'weekly_apy', 'monthly_apy', 'yearly_apy', 'period', 'daily_period_days', 'weekly_period_days', 'monthly_period_days', 'yearly_period_days', 'latest_share_price', 'calculated_at', 'hourly_apy', 'total_count', 'total_assets']) assert.ok(page.includes(`\`${field}\``), field);
  assert.ok(page.includes('30 days') && page.includes('31 days'));
  assert.ok(page.includes('no replacement'));
  assert.ok(!page.includes('retains the previous valid'));
});

test('EN/FR end-user surfaces do not gain integrator/status claims', { skip: !release }, async () => {
  const languages = JSON.parse(await text('docs.json')).navigation.languages.map(x => x.language);
  for (const language of languages) {
    const prefix = language === 'en' ? '' : `${language}/`;
    for (const file of ['get-to-know-your-dashboard.mdx', 'making-your-first-deposit.mdx', 'currency-and-yield.mdx', 'documentation/about-byzantine/product-details.mdx']) {
      assert.doesNotMatch(await text(prefix + file), /payment_in_review|vault_address|apy_24h|hourly indexer|indexeur horaire/u, prefix + file);
    }
  }
});

test('new performance endpoints are public and old navigation operations removed', { skip: !release }, async () => {
  const config = JSON.parse(await text('docs.json'));
  const nav = JSON.stringify(config.navigation);
  for (const endpoint of ['/v1/query/apy', '/v1/query/apy-history']) {
    assert.ok(nav.includes(`GET ${endpoint}"`));
    const operation = spec.paths[endpoint].get;
    assert.equal(operation.security, undefined);
    assert.ok(!operation.parameters.some(p => p.in === 'header'));
  }
  for (const endpoint of ['/v1/query/apy/{vault_id}', '/v1/query/history/{vault_id}']) assert.ok(!nav.includes(endpoint));
  for (const source of ['/api-reference/products/get-single-vault-history']) assert.ok(config.redirects.some(r => r.source === source && r.destination === '/api-reference/products/get-single-product-apy-history'));
});
