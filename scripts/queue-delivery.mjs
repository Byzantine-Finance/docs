#!/usr/bin/env node

import { DeliveryQueue } from "./lib/delivery-queue.mjs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

function option(args, name, { required = true } = {}) {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (required && (!value || value.startsWith("--"))) throw new Error(`Missing ${name}`);
  return value;
}

async function readJsonInput() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error("Delivery payload is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const databasePath = option(args, "--database");
  await mkdir(path.dirname(databasePath), { recursive: true });
  const queue = new DeliveryQueue(databasePath);
  try {
    if (command === "enqueue") {
      const payload = await readJsonInput();
      writeJson({
        inserted: queue.enqueue({
          ...payload,
          receivedAt: new Date().toISOString(),
        }),
      });
      return;
    }

    if (command === "acquire") {
      writeJson(
        queue.acquireNext({
          repository: "Byzantine-Finance/byzantine-api",
          owner: option(args, "--owner"),
          now: option(args, "--now", { required: false }) ?? new Date().toISOString(),
          leaseMs: Number(option(args, "--lease-ms", { required: false }) ?? 15 * 60 * 1_000),
        }),
      );
      return;
    }

    if (command === "renew") {
      queue.renew(option(args, "--delivery-id"), option(args, "--owner"), {
        now: option(args, "--now", { required: false }) ?? new Date().toISOString(),
        leaseMs: Number(option(args, "--lease-ms", { required: false }) ?? 15 * 60 * 1_000),
      });
      writeJson({ renewed: true });
      return;
    }

    if (command === "complete") {
      queue.complete(option(args, "--delivery-id"), option(args, "--owner"));
      writeJson({ completed: true });
      return;
    }

    if (command === "fail") {
      const result = queue.fail(
        option(args, "--delivery-id"),
        option(args, "--owner"),
        option(args, "--error"),
        {
          retry: args.includes("--retry"),
          now: option(args, "--now", { required: false }) ?? new Date().toISOString(),
        },
      );
      writeJson(result);
      return;
    }

    throw new Error(`Unknown command: ${command ?? ""}`);
  } finally {
    queue.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
