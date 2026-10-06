import { DatabaseSync } from "node:sqlite";

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const DELIVERY_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const SOURCE_REPOSITORY = "Byzantine-Finance/byzantine-api";
const SOURCE_REF = "refs/heads/main";

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
  constructor(databasePath) {
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
          SET status = 'queued', lease_owner = NULL, lease_until = NULL
          WHERE repository = ? AND status = 'processing' AND lease_until <= ?
        `)
        .run(repository, nowMs);

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
          SELECT delivery_id FROM deliveries
          WHERE repository = ? AND status = 'queued'
          ORDER BY received_at, delivery_id
          LIMIT 1
        `)
        .get(repository);
      if (!next) {
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

  fail(deliveryId, owner, error, { retry }) {
    if (typeof error !== "string" || error.length === 0) throw new Error("Invalid delivery error");
    const status = retry ? "queued" : "failed";
    const result = this.database
      .prepare(`
        UPDATE deliveries
        SET status = ?, lease_owner = NULL, lease_until = NULL, error = ?
        WHERE delivery_id = ? AND status = 'processing' AND lease_owner = ?
      `)
      .run(status, error, deliveryId, owner);
    if (Number(result.changes) !== 1) throw new Error("Delivery lease is not owned by worker");
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
