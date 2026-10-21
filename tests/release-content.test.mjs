import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const text = (path) => readFile(new URL(path, root), 'utf8');

test('transaction v2 example matches every explicit summary field in the release schema', async () => {
  const spec = JSON.parse(await text('api-reference/openapi-integrator.json'));
  const page = await text('api-reference/webhooks/transactions.mdx');
  const sample = JSON.parse(page.match(/```json\n([\s\S]*?)\n```/u)[1]);
  assert.equal(sample.payloadVersion, 2);
  const schema = spec.components.schemas.TransactionSummary;
  assert.ok(schema, 'release must include the transaction v2 schema');
  assert.deepEqual(Object.keys(sample.data.transaction).sort(), Object.keys(schema.properties).sort());
  assert.equal(sample.type, `transaction.${sample.data.transaction.status}`);
  assert.ok(spec.components.schemas.TransactionStatusView.enum.includes(sample.data.previousStatus));
  for (const status of ['payment_in_review', 'refunded', 'cancelled']) {
    assert.ok(spec.components.schemas.TransactionStatusView.enum.includes(status));
    assert.ok(spec.components.schemas.WebhookEventType.enum.includes(`transaction.${status}`));
    assert.ok(page.includes(`transaction.${status}`));
  }
});

test('performance navigation uses release endpoints rather than removed vault-ID paths', async () => {
  const spec = JSON.parse(await text('api-reference/openapi-integrator.json'));
  const navigation = await text('docs.json');
  for (const path of ['/v1/query/apy', '/v1/query/apy-history']) {
    assert.ok(spec.paths[path]?.get, `${path} must exist in the committed artifact`);
    assert.ok(navigation.includes(`GET ${path}\"`));
  }
  for (const path of ['/v1/query/apy/{vault_id}', '/v1/query/history/{vault_id}']) {
    assert.equal(spec.paths[path], undefined);
    assert.equal(navigation.includes(`GET ${path}\"`), false);
  }
});
