import assert from "node:assert/strict";
import test from "node:test";

import { parseWatermark, renderWatermark } from "../scripts/lib/watermark.mjs";

const WATERMARK = {
  schemaVersion: 1,
  sourceRepository: "Byzantine-Finance/byzantine-api",
  sourceCommit: "a".repeat(40),
  openapiSha256: "b".repeat(64),
  generatorVersion: 1,
};

test("renders and parses a validated deterministic API watermark", () => {
  const raw = renderWatermark(WATERMARK);
  assert.equal(raw, `${JSON.stringify(WATERMARK, null, 2)}\n`);
  assert.deepEqual(parseWatermark(raw), WATERMARK);
});

test("rejects malformed repositories, commits, and artifact hashes", () => {
  for (const patch of [
    { sourceRepository: "another/repository" },
    { sourceCommit: "short" },
    { openapiSha256: "not-a-hash" },
    { generatorVersion: 0 },
  ]) {
    assert.throws(() => renderWatermark({ ...WATERMARK, ...patch }), /Invalid API watermark/);
  }
  assert.throws(() => parseWatermark("not json"), /Invalid API watermark/);
});
