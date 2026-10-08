import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { DeliveryQueue } from "../scripts/lib/delivery-queue.mjs";
import { renderWatermark } from "../scripts/lib/watermark.mjs";

const script = fileURLToPath(new URL("../scripts/reconcile-delivery.mjs", import.meta.url));

async function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args]);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function artifactHash(content) {
  return createHash("sha256").update(content).digest("hex");
}

test("reconciliation enqueues the undocumented exact source range once", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "byzantine-reconcile-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const database = path.join(directory, "queue.sqlite");
  const watermark = path.join(directory, "watermark.json");
  const artifact = path.join(directory, "openapi.json");
  const artifactContent = '{"openapi":"3.0.3"}\n';
  const base = "a".repeat(40);
  const current = "b".repeat(40);
  await writeFile(artifact, artifactContent);
  await writeFile(
    watermark,
    renderWatermark({
      schemaVersion: 1,
      sourceRepository: "Byzantine-Finance/byzantine-api",
      sourceCommit: base,
      openapiSha256: artifactHash(artifactContent),
      generatorVersion: 1,
    }),
  );

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await run([
      "--database",
      database,
      "--watermark",
      watermark,
      "--artifact",
      artifact,
      "--current-sha",
      current,
      "--now",
      "2026-10-06T15:00:00.000Z",
    ]);
    assert.equal(result.code, 0, result.stderr);
  }

  const queue = new DeliveryQueue(database);
  assert.equal(queue.count(), 1);
  const delivery = queue.acquireNext({
    repository: "Byzantine-Finance/byzantine-api",
    owner: "worker",
    now: "2026-10-06T15:01:00.000Z",
    leaseMs: 60_000,
  });
  assert.equal(delivery.before, base);
  assert.equal(delivery.after, current);
  queue.close();
});

test("reconciliation is a no-op when the watermark already matches", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "byzantine-reconcile-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const database = path.join(directory, "queue.sqlite");
  const watermark = path.join(directory, "watermark.json");
  const artifact = path.join(directory, "openapi.json");
  const artifactContent = '{"openapi":"3.0.3"}\n';
  const current = "a".repeat(40);
  await writeFile(artifact, artifactContent);
  await writeFile(
    watermark,
    renderWatermark({
      schemaVersion: 1,
      sourceRepository: "Byzantine-Finance/byzantine-api",
      sourceCommit: current,
      openapiSha256: artifactHash(artifactContent),
      generatorVersion: 1,
    }),
  );

  const result = await run([
    "--database",
    database,
    "--watermark",
    watermark,
    "--artifact",
    artifact,
    "--current-sha",
    current,
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { inserted: false, reason: "already-documented" });
});

test("reconciliation fails closed when the watermark hash does not match the artifact", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "byzantine-reconcile-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const watermark = path.join(directory, "watermark.json");
  const artifact = path.join(directory, "openapi.json");
  await writeFile(artifact, '{"openapi":"3.0.3"}\n');
  await writeFile(
    watermark,
    renderWatermark({
      schemaVersion: 1,
      sourceRepository: "Byzantine-Finance/byzantine-api",
      sourceCommit: "a".repeat(40),
      openapiSha256: "c".repeat(64),
      generatorVersion: 1,
    }),
  );

  const result = await run([
    "--database",
    path.join(directory, "queue.sqlite"),
    "--watermark",
    watermark,
    "--artifact",
    artifact,
    "--current-sha",
    "b".repeat(40),
  ]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /does not match the committed OpenAPI artifact/);
});
