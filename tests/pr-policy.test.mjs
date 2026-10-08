import assert from "node:assert/strict";
import test from "node:test";

import { decidePrPolicy, parsePrMarker, renderPrMarker } from "../scripts/lib/pr-policy.mjs";

const NOW = "2026-10-06T12:00:00.000Z";
const BASE_SHA = "a".repeat(40);
const TARGET_SHA = "b".repeat(40);
const OPENAPI_SHA256 = "c".repeat(64);
const DEPLOYMENT_RUN_ID = 123456;
const COMPANION_SDK_PR = "https://github.com/Byzantine-Finance/integrator-sdk/pull/22";

function marker(windowStart) {
  return {
    deploymentRunId: DEPLOYMENT_RUN_ID,
    baseSourceSha: BASE_SHA,
    targetSha: TARGET_SHA,
    openapiSha256: OPENAPI_SHA256,
    windowStart,
    generatorVersion: 2,
    includedCommits: [TARGET_SHA],
    companionSdkPr: COMPANION_SDK_PR,
  };
}

function change(relationship = "compatible", size = "small") {
  return { relationship, size };
}

function openPr(windowStart) {
  return {
    state: "open",
    marker: marker(windowStart),
  };
}

test("creates a new PR from docs main when no PR exists", () => {
  assert.deepEqual(
    decidePrPolicy({ now: NOW, pullRequest: null, change: change() }),
    { action: "create", source: "docs-main", reason: "no-existing-pr" },
  );
});

test("creates from fresh docs main after the previous PR is merged or closed", () => {
  for (const state of ["merged", "closed"]) {
    assert.deepEqual(
      decidePrPolicy({ now: NOW, pullRequest: { state }, change: change() }),
      { action: "create", source: "docs-main", reason: "previous-pr-finished" },
    );
  }
});

test("updates the same open automation PR for a small compatible change before 24 hours", () => {
  assert.deepEqual(
    decidePrPolicy({
      now: NOW,
      pullRequest: openPr("2026-10-05T12:00:00.001Z"),
      change: change("compatible", "small"),
    }),
    { action: "update", source: "open-pr", reason: "compatible-within-window" },
  );
});

test("updates the same PR for a clearly related fix before, at, or after 24 hours", () => {
  for (const windowStart of [
    "2026-10-05T12:00:00.001Z",
    "2026-10-05T12:00:00.000Z",
    "2026-10-05T11:59:59.999Z",
  ]) {
    assert.deepEqual(
      decidePrPolicy({ now: NOW, pullRequest: openPr(windowStart), change: change("fix") }),
      { action: "update", source: "open-pr", reason: "related-fix" },
    );
  }
});

test("escalates breaking, broad, and non-consolidatable open-PR changes", () => {
  const cases = [
    { change: change("breaking"), windowStart: "2026-10-04T12:00:00.000Z" },
    { change: change("broad"), windowStart: "2026-10-04T12:00:00.000Z" },
    { change: change("unrelated"), windowStart: "2026-10-05T12:00:00.001Z" },
    { change: change("unrelated"), windowStart: "2026-10-05T12:00:00.000Z" },
    { change: change("compatible"), windowStart: "2026-10-05T12:00:00.000Z" },
  ];

  for (const item of cases) {
    assert.deepEqual(
      decidePrPolicy({
        now: NOW,
        pullRequest: openPr(item.windowStart),
        change: item.change,
      }),
      { action: "escalate", source: "open-pr", reason: "requires-review" },
    );
  }
});

test("escalates an open PR without an automation marker", () => {
  assert.deepEqual(
    decidePrPolicy({ now: NOW, pullRequest: { state: "open" }, change: change() }),
    { action: "escalate", source: "open-pr", reason: "requires-review" },
  );
});

test("queues an unrelated change only after the 24-hour boundary", () => {
  assert.deepEqual(
    decidePrPolicy({
      now: NOW,
      pullRequest: openPr("2026-10-05T11:59:59.999Z"),
      change: change("unrelated"),
    }),
    { action: "queue", source: "docs-main", reason: "unrelated-after-window" },
  );
});

test("renders a deterministic machine-readable PR marker", () => {
  const value = marker("2026-10-06T00:00:00.000Z");
  assert.equal(
    renderPrMarker(value),
    `<!-- byzantine-docs-pr:${JSON.stringify(value)} -->`,
  );
});

test("accepts an explicit companion SDK outcome when no SDK PR exists", () => {
  for (const companionSdkPr of ["none", "blocked"]) {
    const value = {
      ...marker("2026-10-06T00:00:00.000Z"),
      companionSdkPr,
    };

    assert.deepEqual(parsePrMarker(renderPrMarker(value)), value);
  }
});

test("rejects an arbitrary companion SDK state or unrelated PR URL", () => {
  for (const companionSdkPr of [
    "unchanged maybe",
    "https://github.com/Byzantine-Finance/docs/pull/13",
  ]) {
    assert.throws(
      () =>
        renderPrMarker({
          ...marker("2026-10-06T00:00:00.000Z"),
          companionSdkPr,
        }),
      /complete PR marker/,
    );
  }
});

test("rejects non-string companion SDK outcomes", () => {
  for (const companionSdkPr of [
    ["none"],
    ["blocked"],
    [COMPANION_SDK_PR],
    { state: "none" },
    22,
    null,
  ]) {
    assert.throws(
      () =>
        renderPrMarker({
          ...marker("2026-10-06T00:00:00.000Z"),
          companionSdkPr,
        }),
      /complete PR marker/,
    );
  }
});

test("requires every machine-readable marker field", () => {
  assert.throws(
    () =>
      renderPrMarker({
        baseSourceSha: BASE_SHA,
        targetSha: TARGET_SHA,
        windowStart: "2026-10-06T00:00:00.000Z",
        generatorVersion: 1,
      }),
    /complete PR marker/,
  );
});

test("parses the machine-readable PR marker from a PR body", () => {
  const value = marker("2026-10-06T00:00:00.000Z");

  assert.deepEqual(parsePrMarker(`Summary\n\n${renderPrMarker(value)}\n`), value);
});

test("ignores missing, malformed, or incomplete PR markers", () => {
  assert.equal(parsePrMarker("No marker"), null);
  assert.equal(parsePrMarker("<!-- byzantine-docs-pr:{bad-json} -->"), null);
  assert.equal(parsePrMarker('<!-- byzantine-docs-pr:{"windowStart":"2026-10-06T00:00:00.000Z"} -->'), null);
});

test("rejects malformed, incoherent, and future-dated PR markers", () => {
  for (const marker of [
    { ...openPr("2026-10-06T00:00:00.000Z").marker, targetSha: "short" },
    { ...openPr("2026-10-06T00:00:00.000Z").marker, generatorVersion: 0 },
    { ...openPr("2026-10-06T00:00:00.000Z").marker, includedCommits: [] },
    {
      ...openPr("2026-10-06T00:00:00.000Z").marker,
      includedCommits: ["c".repeat(40)],
    },
  ]) {
    assert.throws(() => renderPrMarker(marker), /complete PR marker/);
  }

  assert.deepEqual(
    decidePrPolicy({
      now: NOW,
      pullRequest: openPr("2026-10-06T12:00:00.001Z"),
      change: change(),
    }),
    { action: "escalate", source: "open-pr", reason: "invalid-marker" },
  );
});
