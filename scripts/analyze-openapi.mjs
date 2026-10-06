#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";

import { diffOpenApi, renderOpenApiDiffMarkdown } from "./lib/openapi-diff.mjs";
import { loadOpenApi } from "./lib/openapi-sync.mjs";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function writeOutput(path, content) {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}

async function main() {
  const beforeSource = argument("--before");
  const afterSource = argument("--after");
  const jsonTarget = argument("--json-out");
  const markdownTarget = argument("--markdown-out");
  if (!beforeSource || !afterSource) {
    throw new Error("Pass --before <OpenAPI file-or-URL> and --after <OpenAPI file-or-URL>");
  }
  if (!jsonTarget && !markdownTarget) {
    throw new Error("Pass --json-out, --markdown-out, or both");
  }

  const [before, after] = await Promise.all([
    loadOpenApi(beforeSource),
    loadOpenApi(afterSource),
  ]);
  const report = diffOpenApi(before, after);
  if (jsonTarget) {
    await writeOutput(jsonTarget, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (markdownTarget) {
    await writeOutput(markdownTarget, `${renderOpenApiDiffMarkdown(report)}\n`);
  }

  console.log(
    JSON.stringify({
      added: report.operations.added.length,
      removed: report.operations.removed.length,
      changed: report.operations.changed.length,
      indirect: report.operations.indirect.length,
      requiresEscalation: report.requiresEscalation,
    }),
  );
}

main().catch((error) => {
  console.error(`OpenAPI analysis failed: ${error.message}`);
  process.exitCode = 1;
});
