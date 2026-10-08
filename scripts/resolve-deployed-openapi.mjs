#!/usr/bin/env node

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { exportIntegratorOpenApiAtCommit } from "./lib/api-openapi-export.mjs";
import { loadAllWorkflowRuns } from "./lib/github-workflow-runs.mjs";
import {
  PRODUCTION_OPENAPI_URL,
  resolveProvenanceVerifiedOpenApi,
} from "./lib/deployed-openapi.mjs";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 12 * 1024 * 1024;

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
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
  const apiRepository = argument("--api-repository");
  const workspaceDirectory = argument("--workspace");
  const cargoTargetDirectory = argument("--cargo-target");
  if (!output || !apiRepository || !workspaceDirectory || !cargoTargetDirectory) {
    throw new Error(
      "Pass --output, --api-repository, --workspace, and --cargo-target",
    );
  }

  const result = await resolveProvenanceVerifiedOpenApi({
    output,
    workflowRunsLoader: loadAllWorkflowRuns,
    openApiLoader: loadProductionOpenApi,
    exactOpenApiLoader: (sourceCommit) =>
      exportIntegratorOpenApiAtCommit({
        apiRepository,
        sourceCommit,
        workspaceDirectory,
        cargoTargetDirectory,
      }),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
