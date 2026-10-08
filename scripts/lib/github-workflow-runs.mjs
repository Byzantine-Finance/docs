import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PAGE_SIZE = 100;
const DEFAULT_MAX_RUNS = 1_000;
const MAX_OUTPUT_BYTES = 12 * 1024 * 1024;
const WORKFLOW_RUNS_ENDPOINT =
  "repos/Byzantine-Finance/byzantine-api/actions/workflows/deploy-api.yml/runs";

function parsePage(stdout, expectedTotal) {
  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw new Error("GitHub returned malformed deployment workflow history");
  }
  if (
    !Number.isInteger(payload.total_count) ||
    payload.total_count < 0 ||
    !Array.isArray(payload.workflow_runs)
  ) {
    throw new Error("GitHub returned malformed deployment workflow history");
  }
  if (expectedTotal !== undefined && payload.total_count !== expectedTotal) {
    throw new Error("GitHub deployment workflow history changed during pagination");
  }
  return payload;
}

export async function loadAllWorkflowRuns({
  execFileImpl = execFileAsync,
  maxRuns = DEFAULT_MAX_RUNS,
} = {}) {
  if (!Number.isInteger(maxRuns) || maxRuns < 1) {
    throw new Error("maxRuns must be a positive integer");
  }

  const runs = [];
  let total;
  let page = 1;
  do {
    const { stdout } = await execFileImpl(
      "gh",
      [
        "api",
        "--method",
        "GET",
        WORKFLOW_RUNS_ENDPOINT,
        "-f",
        `per_page=${PAGE_SIZE}`,
        "-f",
        `page=${page}`,
      ],
      { encoding: "utf8", maxBuffer: MAX_OUTPUT_BYTES },
    );
    const payload = parsePage(stdout, total);
    total ??= payload.total_count;
    if (total > maxRuns) {
      throw new Error(
        `Deployment workflow history (${total}) exceeds the bounded provenance history (${maxRuns})`,
      );
    }
    if (payload.workflow_runs.length > PAGE_SIZE) {
      throw new Error("GitHub returned an oversized deployment workflow page");
    }
    if (payload.workflow_runs.length === 0 && runs.length < total) {
      throw new Error("GitHub returned an incomplete deployment workflow history");
    }
    runs.push(...payload.workflow_runs);
    page += 1;
    if (page > Math.ceil(total / PAGE_SIZE) && runs.length < total) {
      throw new Error("GitHub returned an incomplete deployment workflow history");
    }
  } while (runs.length < total);

  if (runs.length !== total) {
    throw new Error("GitHub returned an incomplete deployment workflow history");
  }
  const identifiers = new Set();
  for (const run of runs) {
    if (!Number.isInteger(run?.id) || identifiers.has(run.id)) {
      throw new Error("GitHub returned a duplicate workflow run during pagination");
    }
    identifiers.add(run.id);
  }
  return runs;
}
