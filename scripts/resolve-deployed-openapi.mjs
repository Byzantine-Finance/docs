#!/usr/bin/env node

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  PRODUCTION_OPENAPI_URL,
  resolveDeployedOpenApi,
} from "./lib/deployed-openapi.mjs";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 12 * 1024 * 1024;

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function loadWorkflowRuns() {
  const runs = [];
  const seenRunIds = new Set();
  let expectedTotal;
  for (let page = 1; page <= 100; page += 1) {
    const { stdout } = await execFileAsync(
      "gh",
      [
        "api",
        "--method",
        "GET",
        "repos/Byzantine-Finance/byzantine-api/actions/workflows/deploy-api.yml/runs",
        "-f",
        "per_page=100",
        "-f",
        `page=${page}`,
      ],
      { encoding: "utf8", maxBuffer: MAX_OUTPUT_BYTES },
    );
    const payload = JSON.parse(stdout);
    if (!Number.isSafeInteger(payload.total_count) || !Array.isArray(payload.workflow_runs)) {
      throw new Error("GitHub returned malformed paginated deployment workflow runs");
    }
    if (expectedTotal === undefined) expectedTotal = payload.total_count;
    if (payload.total_count !== expectedTotal) {
      throw new Error("GitHub deployment workflow history changed during pagination");
    }
    for (const run of payload.workflow_runs) {
      if (!Number.isSafeInteger(run?.id) || seenRunIds.has(run.id)) {
        throw new Error("GitHub returned duplicate or malformed paginated workflow runs");
      }
      seenRunIds.add(run.id);
      runs.push(run);
    }
    if (runs.length === expectedTotal) return runs;
    if (runs.length > expectedTotal || payload.workflow_runs.length === 0) {
      throw new Error("GitHub returned an incomplete paginated workflow history");
    }
  }
  throw new Error("GitHub deployment workflow history exceeds the safe pagination limit");
}

async function loadMainSha() {
  const { stdout } = await execFileAsync(
    "gh",
    ["api", "repos/Byzantine-Finance/byzantine-api/commits/main", "--jq", ".sha"],
    { encoding: "utf8", maxBuffer: MAX_OUTPUT_BYTES },
  );
  return stdout.trim();
}

async function loadProductionOpenApi() {
  const { stdout } = await execFileAsync(
    "curl",
    [
      "--disable",
      "--fail",
      "--silent",
      "--show-error",
      "--proto",
      "=https",
      "--connect-timeout",
      "10",
      "--max-time",
      "30",
      "--max-filesize",
      "10485760",
      PRODUCTION_OPENAPI_URL,
    ],
    { encoding: "utf8", maxBuffer: MAX_OUTPUT_BYTES },
  );
  return JSON.parse(stdout);
}

async function main() {
  const output = argument("--output");
  if (!output) throw new Error("Pass --output <openapi.json>");

  const result = await resolveDeployedOpenApi({
    output,
    mainShaLoader: loadMainSha,
    workflowRunsLoader: loadWorkflowRuns,
    openApiLoader: loadProductionOpenApi,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
