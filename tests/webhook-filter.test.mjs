import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { DeliveryQueue } from "../scripts/lib/delivery-queue.mjs";

const script = fileURLToPath(new URL("../scripts/hermes/byzantine-api-push.py", import.meta.url));
const queueCli = fileURLToPath(new URL("../scripts/queue-delivery.mjs", import.meta.url));

async function filter(payload, { database = ":memory:" } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [script], {
      env: {
        ...process.env,
        BYZANTINE_DOCS_QUEUE_CLI: queueCli,
        BYZANTINE_DOCS_QUEUE_DATABASE: database,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`filter exited ${code}: ${stderr}`));
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

test("webhook filter emits only the trusted Byzantine API main push fields", async () => {
  const repository = "Byzantine-Finance/byzantine-api";
  const ref = "refs/heads/main";
  const before = "a".repeat(40);
  const after = "b".repeat(40);
  const stdout = await filter({
    repository: { full_name: repository },
    ref,
    before,
    after,
    forced: false,
    head_commit: { message: "untrusted message" },
  });

  assert.deepEqual(JSON.parse(stdout), {
    deliveryId: createHash("sha256")
      .update(`${repository}\0${ref}\0${before}\0${after}`)
      .digest("hex"),
    repository,
    ref,
    before,
    after,
    forced: false,
  });
  assert.doesNotMatch(stdout, /untrusted message/);
});

test("webhook filter durably queues a valid delivery before waking the agent", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "byzantine-webhook-queue-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const database = path.join(directory, "queue.sqlite");
  const payload = {
    repository: { full_name: "Byzantine-Finance/byzantine-api" },
    ref: "refs/heads/main",
    before: "a".repeat(40),
    after: "b".repeat(40),
  };

  const first = await filter(payload, { database });
  const second = await filter(payload, { database });
  assert.notEqual(first, "");
  assert.equal(second, "");

  const queue = new DeliveryQueue(database);
  assert.equal(queue.count(), 1);
  queue.close();
});

test("webhook filter ignores other repositories and branches", async () => {
  assert.equal(
    await filter({
      repository: { full_name: "Byzantine-Finance/docs" },
      ref: "refs/heads/main",
      before: "a".repeat(40),
      after: "b".repeat(40),
    }),
    "",
  );
  assert.equal(
    await filter({
      repository: { full_name: "Byzantine-Finance/byzantine-api" },
      ref: "refs/heads/dev",
      before: "a".repeat(40),
      after: "b".repeat(40),
    }),
    "",
  );
});

test("webhook filter rejects malformed commit identifiers", async () => {
  assert.equal(
    await filter({
      repository: { full_name: "Byzantine-Finance/byzantine-api" },
      ref: "refs/heads/main",
      before: "not-a-sha",
      after: "b".repeat(40),
    }),
    "",
  );
});

test("webhook filter safely rejects non-object and oversized payloads", async () => {
  for (const payload of [null, [], "text", { repository: null }]) {
    assert.equal(await filter(payload), "");
  }
  assert.equal(await filter({ padding: "x".repeat(70 * 1024) }), "");
});
