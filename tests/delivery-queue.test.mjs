import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DeliveryQueue } from "../scripts/lib/delivery-queue.mjs";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);

async function withQueue(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "byzantine-delivery-queue-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, database: path.join(directory, "queue.sqlite") };
}

function delivery(id, after = SHA_B, receivedAt = "2026-10-06T12:00:00.000Z") {
  return {
    deliveryId: id,
    repository: "Byzantine-Finance/byzantine-api",
    ref: "refs/heads/main",
    before: SHA_A,
    after,
    receivedAt,
  };
}

test("deduplicates GitHub deliveries durably", async (t) => {
  const { database } = await withQueue(t);
  const first = new DeliveryQueue(database);

  assert.equal(first.enqueue(delivery("delivery-1")), true);
  assert.equal(first.enqueue(delivery("delivery-1")), false);
  first.close();

  const reopened = new DeliveryQueue(database);
  assert.equal(reopened.count(), 1);
  reopened.close();
});

test("preserves forced-push state for worker escalation", async (t) => {
  const { database } = await withQueue(t);
  const queue = new DeliveryQueue(database);
  queue.enqueue({ ...delivery("forced-delivery"), forced: true });

  const acquired = queue.acquireNext({
    repository: "Byzantine-Finance/byzantine-api",
    owner: "worker",
    now: "2026-10-06T12:02:00.000Z",
    leaseMs: 60_000,
  });

  assert.equal(acquired.forced, true);
  queue.close();
});

test("serializes repository work with an expiring lease", async (t) => {
  const { database } = await withQueue(t);
  const queue = new DeliveryQueue(database);
  queue.enqueue(delivery("delivery-1"));
  queue.enqueue(delivery("delivery-2", SHA_C, "2026-10-06T12:01:00.000Z"));

  const first = queue.acquireNext({
    repository: "Byzantine-Finance/byzantine-api",
    owner: "worker-a",
    now: "2026-10-06T12:02:00.000Z",
    leaseMs: 60_000,
  });
  assert.equal(first.deliveryId, "delivery-1");

  assert.equal(
    queue.acquireNext({
      repository: "Byzantine-Finance/byzantine-api",
      owner: "worker-b",
      now: "2026-10-06T12:02:30.000Z",
      leaseMs: 60_000,
    }),
    null,
  );

  const recovered = queue.acquireNext({
    repository: "Byzantine-Finance/byzantine-api",
    owner: "worker-b",
    now: "2026-10-06T12:03:01.000Z",
    leaseMs: 60_000,
  });
  assert.equal(recovered.deliveryId, "delivery-1");
  assert.equal(recovered.attempts, 2);

  queue.complete("delivery-1", "worker-b");
  const second = queue.acquireNext({
    repository: "Byzantine-Finance/byzantine-api",
    owner: "worker-b",
    now: "2026-10-06T12:03:02.000Z",
    leaseMs: 60_000,
  });
  assert.equal(second.deliveryId, "delivery-2");
  queue.close();
});

test("renews an owned lease to prevent overlapping workers", async (t) => {
  const { database } = await withQueue(t);
  const queue = new DeliveryQueue(database);
  queue.enqueue(delivery("delivery-1"));
  queue.acquireNext({
    repository: "Byzantine-Finance/byzantine-api",
    owner: "worker-a",
    now: "2026-10-06T12:00:00.000Z",
    leaseMs: 60_000,
  });

  queue.renew("delivery-1", "worker-a", {
    now: "2026-10-06T12:00:30.000Z",
    leaseMs: 60_000,
  });
  assert.equal(
    queue.acquireNext({
      repository: "Byzantine-Finance/byzantine-api",
      owner: "worker-b",
      now: "2026-10-06T12:01:01.000Z",
      leaseMs: 60_000,
    }),
    null,
  );
  assert.throws(
    () =>
      queue.renew("delivery-1", "worker-b", {
        now: "2026-10-06T12:01:02.000Z",
        leaseMs: 60_000,
      }),
    /lease is not owned/,
  );
  queue.close();
});

test("backs off retryable failures and stops after the attempt ceiling", async (t) => {
  const { database } = await withQueue(t);
  const queue = new DeliveryQueue(database, { maxAttempts: 2, baseRetryMs: 60_000 });
  queue.enqueue(delivery("delivery-1"));

  queue.acquireNext({
    repository: "Byzantine-Finance/byzantine-api",
    owner: "worker-a",
    now: "2026-10-06T12:02:00.000Z",
    leaseMs: 60_000,
  });
  const scheduled = queue.fail("delivery-1", "worker-a", "temporary", {
    retry: true,
    now: "2026-10-06T12:02:10.000Z",
  });
  assert.equal(scheduled.retryScheduled, true);
  assert.equal(scheduled.exhausted, false);

  assert.equal(
    queue.acquireNext({
      repository: "Byzantine-Finance/byzantine-api",
      owner: "worker-b",
      now: "2026-10-06T12:02:11.000Z",
      leaseMs: 60_000,
    }),
    null,
  );

  const retry = queue.acquireNext({
    repository: "Byzantine-Finance/byzantine-api",
    owner: "worker-b",
    now: "2026-10-06T12:04:00.000Z",
    leaseMs: 60_000,
  });
  assert.equal(retry.attempts, 2);
  const exhausted = queue.fail("delivery-1", "worker-b", "still temporary", {
    retry: true,
    now: "2026-10-06T12:04:10.000Z",
  });
  assert.equal(exhausted.retryScheduled, false);
  assert.equal(exhausted.exhausted, true);

  assert.deepEqual(queue.get("delivery-1"), {
    deliveryId: "delivery-1",
    status: "failed",
    attempts: 2,
    error: "still temporary",
  });
  queue.close();
});

test("expires crashed workers at the attempt ceiling", async (t) => {
  const { database } = await withQueue(t);
  const queue = new DeliveryQueue(database, { maxAttempts: 2 });
  queue.enqueue(delivery("delivery-1"));
  queue.enqueue(delivery("delivery-2", SHA_C, "2026-10-06T12:01:00.000Z"));

  queue.acquireNext({
    repository: "Byzantine-Finance/byzantine-api",
    owner: "worker-a",
    now: "2026-10-06T12:02:00.000Z",
    leaseMs: 60_000,
  });
  const retry = queue.acquireNext({
    repository: "Byzantine-Finance/byzantine-api",
    owner: "worker-b",
    now: "2026-10-06T12:03:01.000Z",
    leaseMs: 60_000,
  });
  assert.equal(retry.deliveryId, "delivery-1");
  assert.equal(retry.attempts, 2);

  const next = queue.acquireNext({
    repository: "Byzantine-Finance/byzantine-api",
    owner: "worker-c",
    now: "2026-10-06T12:04:02.000Z",
    leaseMs: 60_000,
  });
  assert.equal(next.deliveryId, "delivery-2");
  assert.deepEqual(queue.get("delivery-1"), {
    deliveryId: "delivery-1",
    status: "failed",
    attempts: 2,
    error: "Delivery lease expired after maximum attempts",
  });
  queue.close();
});

test("does not let a newer delivery overtake an older delayed retry", async (t) => {
  const { database } = await withQueue(t);
  const queue = new DeliveryQueue(database, { baseRetryMs: 60_000 });
  queue.enqueue(delivery("delivery-1"));
  queue.enqueue(delivery("delivery-2", SHA_C, "2026-10-06T12:01:00.000Z"));

  queue.acquireNext({
    repository: "Byzantine-Finance/byzantine-api",
    owner: "worker-a",
    now: "2026-10-06T12:02:00.000Z",
    leaseMs: 60_000,
  });
  queue.fail("delivery-1", "worker-a", "temporary", {
    retry: true,
    now: "2026-10-06T12:02:10.000Z",
  });

  assert.equal(
    queue.acquireNext({
      repository: "Byzantine-Finance/byzantine-api",
      owner: "worker-b",
      now: "2026-10-06T12:02:11.000Z",
      leaseMs: 60_000,
    }),
    null,
  );
  const retry = queue.acquireNext({
    repository: "Byzantine-Finance/byzantine-api",
    owner: "worker-b",
    now: "2026-10-06T12:04:00.000Z",
    leaseMs: 60_000,
  });
  assert.equal(retry.deliveryId, "delivery-1");
  queue.close();
});

test("records explicit terminal failures without retrying", async (t) => {
  const { database } = await withQueue(t);
  const queue = new DeliveryQueue(database);
  queue.enqueue(delivery("delivery-1"));
  queue.acquireNext({
    repository: "Byzantine-Finance/byzantine-api",
    owner: "worker-a",
    now: "2026-10-06T12:02:00.000Z",
    leaseMs: 60_000,
  });
  queue.fail("delivery-1", "worker-a", "ambiguous contract", {
    retry: false,
    now: "2026-10-06T12:02:10.000Z",
  });

  assert.deepEqual(queue.get("delivery-1"), {
    deliveryId: "delivery-1",
    status: "failed",
    attempts: 1,
    error: "ambiguous contract",
  });
  queue.close();
});
