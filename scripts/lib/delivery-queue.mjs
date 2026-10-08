import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const DELIVERY_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const SOURCE_REPOSITORY = "Byzantine-Finance/byzantine-api";
const SOURCE_REF = "refs/heads/main";
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_RETRY_MS = 60_000;
const DEFAULT_MAX_RETRY_MS = 60 * 60 * 1_000;

function isoMilliseconds(value, field) {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error(`Invalid ${field}`);
  return milliseconds;
}

function validateDelivery(delivery) {
  if (
    !DELIVERY_ID_PATTERN.test(delivery?.deliveryId ?? "") ||
    delivery.repository !== SOURCE_REPOSITORY ||
    delivery.ref !== SOURCE_REF ||
    !SHA_PATTERN.test(delivery.before ?? "") ||
    !SHA_PATTERN.test(delivery.after ?? "")
  ) {
    throw new Error("Invalid GitHub delivery");
  }
  isoMilliseconds(delivery.receivedAt, "receivedAt");
  return delivery;
}

function publicDelivery(row) {
  return row
    ? {
        deliveryId: row.delivery_id,
        repository: row.repository,
        ref: row.ref,
        before: row.before_sha,
        after: row.after_sha,
        forced: row.forced === 1,
        receivedAt: new Date(row.received_at).toISOString(),
        status: row.status,
        attempts: row.attempts,
      }
    : null;
}

export class DeliveryQueue {
  constructor(
    databasePath,
    {
      maxAttempts = DEFAULT_MAX_ATTEMPTS,
      baseRetryMs = DEFAULT_BASE_RETRY_MS,
      maxRetryMs = DEFAULT_MAX_RETRY_MS,
    } = {},
  ) {
    if (
      !Number.isInteger(maxAttempts) ||
      maxAttempts < 1 ||
      !Number.isInteger(baseRetryMs) ||
      baseRetryMs < 1 ||
      !Number.isInteger(maxRetryMs) ||
      maxRetryMs < baseRetryMs
    ) {
      throw new Error("Invalid retry policy");
    }
    this.maxAttempts = maxAttempts;
    this.baseRetryMs = baseRetryMs;
    this.maxRetryMs = maxRetryMs;
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS deliveries (
        delivery_id TEXT PRIMARY KEY,
        repository TEXT NOT NULL,
        ref TEXT NOT NULL,
        before_sha TEXT NOT NULL,
        after_sha TEXT NOT NULL,
        forced INTEGER NOT NULL DEFAULT 0 CHECK (forced IN (0, 1)),
        received_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued'
          CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        lease_owner TEXT,
        lease_until INTEGER,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS deliveries_repository_status_received
        ON deliveries(repository, status, received_at, delivery_id);
    `);
    const columns = this.database.prepare("PRAGMA table_info(deliveries)").all();
    if (!columns.some(({ name }) => name === "forced")) {
      this.database.exec("ALTER TABLE deliveries ADD COLUMN forced INTEGER NOT NULL DEFAULT 0");
    }
    if (!columns.some(({ name }) => name === "next_attempt_at")) {
      this.database.exec("ALTER TABLE deliveries ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0");
    }
  }

  enqueue(input) {
    const delivery = validateDelivery(input);
    const result = this.database
      .prepare(`
        INSERT OR IGNORE INTO deliveries (
          delivery_id, repository, ref, before_sha, after_sha, forced, received_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        delivery.deliveryId,
        delivery.repository,
        delivery.ref,
        delivery.before,
        delivery.after,
        delivery.forced === true ? 1 : 0,
        isoMilliseconds(delivery.receivedAt, "receivedAt"),
      );
    return Number(result.changes) === 1;
  }

  acquireNext({ repository, owner, now, leaseMs }) {
    if (repository !== SOURCE_REPOSITORY || !owner || !Number.isInteger(leaseMs) || leaseMs <= 0) {
      throw new Error("Invalid delivery lease");
    }
    const nowMs = isoMilliseconds(now, "lease time");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare(`
          UPDATE deliveries
          SET status = 'failed', lease_owner = NULL, lease_until = NULL,
              next_attempt_at = 0,
              error = 'Delivery lease expired after maximum attempts'
          WHERE repository = ? AND status = 'processing' AND lease_until <= ?
            AND attempts >= ?
        `)
        .run(repository, nowMs, this.maxAttempts);
      this.database
        .prepare(`
          UPDATE deliveries
          SET status = 'queued', lease_owner = NULL, lease_until = NULL
          WHERE repository = ? AND status = 'processing' AND lease_until <= ?
            AND attempts < ?
        `)
        .run(repository, nowMs, this.maxAttempts);

      const active = this.database
        .prepare(`
          SELECT 1 FROM deliveries
          WHERE repository = ? AND status = 'processing' AND lease_until > ?
          LIMIT 1
        `)
        .get(repository, nowMs);
      if (active) {
        this.database.exec("COMMIT");
        return null;
      }

      const next = this.database
        .prepare(`
          SELECT delivery_id, next_attempt_at FROM deliveries
          WHERE repository = ? AND status = 'queued'
          ORDER BY received_at, delivery_id
          LIMIT 1
        `)
        .get(repository);
      if (!next || next.next_attempt_at > nowMs) {
        this.database.exec("COMMIT");
        return null;
      }

      this.database
        .prepare(`
          UPDATE deliveries
          SET status = 'processing', attempts = attempts + 1,
              lease_owner = ?, lease_until = ?, error = NULL
          WHERE delivery_id = ?
        `)
        .run(owner, nowMs + leaseMs, next.delivery_id);
      const row = this.database
        .prepare("SELECT * FROM deliveries WHERE delivery_id = ?")
        .get(next.delivery_id);
      this.database.exec("COMMIT");
      return publicDelivery(row);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  renew(deliveryId, owner, { now, leaseMs }) {
    if (!owner || !Number.isInteger(leaseMs) || leaseMs <= 0) {
      throw new Error("Invalid delivery lease");
    }
    const nowMs = isoMilliseconds(now, "lease time");
    const result = this.database
      .prepare(`
        UPDATE deliveries
        SET lease_until = ?
        WHERE delivery_id = ? AND status = 'processing'
          AND lease_owner = ? AND lease_until > ?
      `)
      .run(nowMs + leaseMs, deliveryId, owner, nowMs);
    if (Number(result.changes) !== 1) throw new Error("Delivery lease is not owned by worker");
  }

  complete(deliveryId, owner) {
    const result = this.database
      .prepare(`
        UPDATE deliveries
        SET status = 'completed', lease_owner = NULL, lease_until = NULL, error = NULL
        WHERE delivery_id = ? AND status = 'processing' AND lease_owner = ?
      `)
      .run(deliveryId, owner);
    if (Number(result.changes) !== 1) throw new Error("Delivery lease is not owned by worker");
  }

  fail(deliveryId, owner, error, { retry, now = new Date().toISOString() }) {
    if (typeof error !== "string" || error.length === 0) throw new Error("Invalid delivery error");
    const row = this.database
      .prepare(
        "SELECT attempts FROM deliveries WHERE delivery_id = ? AND status = 'processing' AND lease_owner = ?",
      )
      .get(deliveryId, owner);
    if (!row) throw new Error("Delivery lease is not owned by worker");

    const exhausted = retry && row.attempts >= this.maxAttempts;
    const retryScheduled = retry && !exhausted;
    const status = retryScheduled ? "queued" : "failed";
    let nextAttemptAt = 0;
    if (retryScheduled) {
      const nowMs = isoMilliseconds(now, "retry time");
      const exponential = Math.min(
        this.maxRetryMs,
        this.baseRetryMs * 2 ** Math.max(0, row.attempts - 1),
      );
      const digest = createHash("sha256").update(`${deliveryId}:${row.attempts}`).digest();
      const jitter = 0.75 + (digest.readUInt16BE(0) / 65_535) * 0.5;
      nextAttemptAt = nowMs + Math.round(exponential * jitter);
    }
    const result = this.database
      .prepare(`
        UPDATE deliveries
        SET status = ?, next_attempt_at = ?, lease_owner = NULL, lease_until = NULL, error = ?
        WHERE delivery_id = ? AND status = 'processing' AND lease_owner = ?
      `)
      .run(status, nextAttemptAt, error, deliveryId, owner);
    if (Number(result.changes) !== 1) throw new Error("Delivery lease is not owned by worker");
    return {
      retryScheduled,
      exhausted,
      nextAttemptAt: retryScheduled ? new Date(nextAttemptAt).toISOString() : null,
    };
  }

  count() {
    return Number(this.database.prepare("SELECT count(*) AS count FROM deliveries").get().count);
  }

  get(deliveryId) {
    const row = this.database
      .prepare("SELECT delivery_id, status, attempts, error FROM deliveries WHERE delivery_id = ?")
      .get(deliveryId);
    return row
      ? {
          deliveryId: row.delivery_id,
          status: row.status,
          attempts: row.attempts,
          error: row.error,
        }
      : null;
  }

  close() {
    this.database.close();
  }
}
