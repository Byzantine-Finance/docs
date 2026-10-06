#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { DeliveryQueue } from "./lib/delivery-queue.mjs";
import { parseWatermark, verifyWatermarkArtifact } from "./lib/watermark.mjs";

const REPOSITORY = "Byzantine-Finance/byzantine-api";
const REF = "refs/heads/main";
const SHA_PATTERN = /^[0-9a-f]{40}$/u;

function option(args, name, { required = true } = {}) {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (required && (!value || value.startsWith("--"))) throw new Error(`Missing ${name}`);
  return value;
}

function deliveryId(before, after) {
  return createHash("sha256")
    .update(`${REPOSITORY}\0${REF}\0${before}\0${after}`)
    .digest("hex");
}

async function main() {
  const args = process.argv.slice(2);
  const databasePath = option(args, "--database");
  const watermarkPath = option(args, "--watermark");
  const artifactPath = option(args, "--artifact");
  const currentSha = option(args, "--current-sha");
  const now = option(args, "--now", { required: false }) ?? new Date().toISOString();
  if (!SHA_PATTERN.test(currentSha) || !Number.isFinite(Date.parse(now))) {
    throw new Error("Invalid reconciliation input");
  }

  const watermark = parseWatermark(await readFile(watermarkPath, "utf8"));
  verifyWatermarkArtifact(watermark, await readFile(artifactPath));
  if (watermark.sourceCommit === currentSha) {
    process.stdout.write(`${JSON.stringify({ inserted: false, reason: "already-documented" })}\n`);
    return;
  }

  await mkdir(path.dirname(databasePath), { recursive: true });
  const queue = new DeliveryQueue(databasePath);
  try {
    const inserted = queue.enqueue({
      deliveryId: deliveryId(watermark.sourceCommit, currentSha),
      repository: REPOSITORY,
      ref: REF,
      before: watermark.sourceCommit,
      after: currentSha,
      receivedAt: now,
    });
    process.stdout.write(`${JSON.stringify({ inserted, reason: inserted ? "source-advanced" : "duplicate" })}\n`);
  } finally {
    queue.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
