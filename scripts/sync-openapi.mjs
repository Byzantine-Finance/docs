#!/usr/bin/env node

import { appendFile } from "node:fs/promises";
import process from "node:process";

import { loadOpenApi, syncOpenApi } from "./lib/openapi-sync.mjs";

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

async function main() {
  const source = argument("--source", process.env.OPENAPI_SOURCE);
  const target = argument("--target", "api-reference/openapi-integrator.json");

  if (!source) {
    throw new Error("Set OPENAPI_SOURCE or pass --source <URL-or-file>");
  }

  const allowedOrigins = (process.env.OPENAPI_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const spec = await loadOpenApi(source, {
    token: process.env.OPENAPI_AUTH_TOKEN,
    allowedOrigins,
  });
  const result = await syncOpenApi({ spec, target });
  const status = result.changed ? "updated" : "already up to date";

  console.log(`OpenAPI ${status}: ${target}`);
  console.log(`SHA-256: ${result.sha256}`);

  if (process.env.GITHUB_OUTPUT) {
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `changed=${result.changed}\nsha256=${result.sha256}\ntarget=${target}\n`,
    );
  }
}

main().catch((error) => {
  console.error(`OpenAPI sync failed: ${error.message}`);
  process.exitCode = 1;
});
