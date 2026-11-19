#!/usr/bin/env node
// Thin CLI around exportIntegratorOpenApiAtCommit, for watching non-production
// branches (e.g. byzantine-api `dev`) where there is no live deployed URL to
// query. Never used for production: production goes through
// resolve-deployed-openapi.mjs, which has the final say on provenance.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { exportIntegratorOpenApiAtCommit } from "./lib/api-openapi-export.mjs";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main() {
  const sha = argument("--sha");
  const output = argument("--output");
  const apiRepository = argument("--api-repository");
  const workspaceDirectory = argument("--workspace");
  const cargoTargetDirectory = argument("--cargo-target");
  if (!sha || !output || !apiRepository || !workspaceDirectory || !cargoTargetDirectory) {
    throw new Error(
      "Pass --sha, --output, --api-repository, --workspace, and --cargo-target",
    );
  }
  const document = await exportIntegratorOpenApiAtCommit({
    apiRepository,
    sourceCommit: sha,
    workspaceDirectory,
    cargoTargetDirectory,
  });
  const target = resolve(output);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(document, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
