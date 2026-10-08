import assert from "node:assert/strict";
import test from "node:test";

import { loadAllWorkflowRuns } from "../scripts/lib/github-workflow-runs.mjs";

function run(id, overrides = {}) {
  return {
    id,
    event: "push",
    head_branch: "main",
    head_sha: "a".repeat(40),
    status: "completed",
    conclusion: "success",
    updated_at: "2026-10-08T10:00:00Z",
    ...overrides,
  };
}

test("loads every workflow-run page before selecting provenance", async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => run(1_000 + index));
  const hiddenRerun = run(7, {
    status: "in_progress",
    conclusion: null,
    updated_at: "2026-10-08T11:00:00Z",
  });
  const pages = [];

  const runs = await loadAllWorkflowRuns({
    execFileImpl: async (_file, args) => {
      const pageArgument = args.find((argument) => argument.startsWith("page="));
      const page = Number(pageArgument.split("=")[1]);
      pages.push(page);
      return {
        stdout: JSON.stringify({
          total_count: 101,
          workflow_runs: page === 1 ? firstPage : [hiddenRerun],
        }),
      };
    },
  });

  assert.deepEqual(pages, [1, 2]);
  assert.equal(runs.length, 101);
  assert.equal(runs.at(-1).id, 7);
});

test("fails closed rather than accepting a partial workflow history", async () => {
  await assert.rejects(
    () =>
      loadAllWorkflowRuns({
        maxRuns: 1_000,
        execFileImpl: async () => ({
          stdout: JSON.stringify({ total_count: 1_001, workflow_runs: [] }),
        }),
      }),
    /exceeds the bounded provenance history/i,
  );
});

test("fails closed on an empty page before the declared history is complete", async () => {
  await assert.rejects(
    () =>
      loadAllWorkflowRuns({
        execFileImpl: async (_file, args) => {
          const pageArgument = args.find((argument) => argument.startsWith("page="));
          const page = Number(pageArgument.split("=")[1]);
          return {
            stdout: JSON.stringify({
              total_count: 2,
              workflow_runs: page === 1 ? [run(1)] : [],
            }),
          };
        },
      }),
    /incomplete deployment workflow history/i,
  );
});

test("rejects duplicate or changing workflow pages", async () => {
  await assert.rejects(
    () =>
      loadAllWorkflowRuns({
        execFileImpl: async (_file, args) => {
          const pageArgument = args.find((argument) => argument.startsWith("page="));
      const page = Number(pageArgument.split("=")[1]);
          return {
            stdout: JSON.stringify({
              total_count: 2,
              workflow_runs: page === 1 ? [run(1), run(1)] : [],
            }),
          };
        },
      }),
    /duplicate workflow run/i,
  );
});
