import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../scripts/queue-delivery.mjs", import.meta.url));

async function run(args, stdin = "") {
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
    child.stdin.end(stdin);
  });
}

test("queue CLI enqueues idempotently and acquires one leased delivery", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "byzantine-queue-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const database = path.join(directory, "state", "queue.sqlite");
  const payload = JSON.stringify({
    deliveryId: "d".repeat(64),
    repository: "Byzantine-Finance/byzantine-api",
    ref: "refs/heads/main",
    before: "a".repeat(40),
    after: "b".repeat(40),
    forced: false,
  });

  const inserted = await run(["enqueue", "--database", database], payload);
  assert.equal(inserted.code, 0, inserted.stderr);
  assert.deepEqual(JSON.parse(inserted.stdout), { inserted: true });

  const duplicate = await run(["enqueue", "--database", database], payload);
  assert.equal(duplicate.code, 0, duplicate.stderr);
  assert.deepEqual(JSON.parse(duplicate.stdout), { inserted: false });

  const acquired = await run([
    "acquire",
    "--database",
    database,
    "--owner",
    "worker-1",
    "--now",
    "2026-10-06T15:00:00.000Z",
    "--lease-ms",
    "60000",
  ]);
  assert.equal(acquired.code, 0, acquired.stderr);
  assert.equal(JSON.parse(acquired.stdout).deliveryId, "d".repeat(64));

  const renewed = await run([
    "renew",
    "--database",
    database,
    "--owner",
    "worker-1",
    "--delivery-id",
    "d".repeat(64),
    "--now",
    "2026-10-06T15:00:30.000Z",
    "--lease-ms",
    "60000",
  ]);
  assert.equal(renewed.code, 0, renewed.stderr);
  assert.deepEqual(JSON.parse(renewed.stdout), { renewed: true });
});

test("queue CLI reports delayed retries", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "byzantine-queue-cli-retry-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const database = path.join(directory, "queue.sqlite");
  const deliveryId = "e".repeat(64);
  const payload = JSON.stringify({
    deliveryId,
    repository: "Byzantine-Finance/byzantine-api",
    ref: "refs/heads/main",
    before: "a".repeat(40),
    after: "b".repeat(40),
    forced: false,
  });

  assert.equal((await run(["enqueue", "--database", database], payload)).code, 0);
  assert.equal(
    (
      await run([
        "acquire",
        "--database",
        database,
        "--owner",
        "worker-1",
        "--now",
        "2026-10-06T15:00:00.000Z",
      ])
    ).code,
    0,
  );

  const failed = await run([
    "fail",
    "--database",
    database,
    "--owner",
    "worker-1",
    "--delivery-id",
    deliveryId,
    "--error",
    "temporary",
    "--retry",
    "--now",
    "2026-10-06T15:00:10.000Z",
  ]);
  assert.equal(failed.code, 0, failed.stderr);
  const result = JSON.parse(failed.stdout);
  assert.equal(result.retryScheduled, true);
  assert.equal(result.exhausted, false);
  assert.match(result.nextAttemptAt, /^2026-10-06T15:0[01]:/u);
});
