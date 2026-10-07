import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  resolveDeployedOpenApi,
  selectStableProductionDeployment,
} from "../scripts/lib/deployed-openapi.mjs";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const RUNS_URL =
  "https://api.github.com/repos/Byzantine-Finance/byzantine-api/actions/workflows/deploy-api.yml/runs?per_page=100";
const OPENAPI_URL = "https://api.byzantine.fi/api-docs/openapi-integrator.json";

function run(overrides = {}) {
  return {
    id: 100,
    event: "push",
    head_branch: "main",
    head_sha: SHA_A,
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
    created_at: "2026-10-07T10:00:00Z",
    updated_at: "2026-10-07T10:10:00Z",
    ...overrides,
  };
}

function spec(version = "1.0.0") {
  return {
    openapi: "3.0.3",
    info: { title: "Byzantine Integrator API", version },
    paths: { "/v1/health": { get: { responses: { 200: { description: "OK" } } } } },
  };
}

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });
}

const mainShaLoader = async () => SHA_A;

test("selects the last completed successful main deployment by completion time", () => {
  const selected = selectStableProductionDeployment(
    [
      run({ id: 100, updated_at: "2026-10-07T12:00:00Z" }),
      run({
        id: 101,
        head_sha: SHA_B,
        created_at: "2026-10-07T11:00:00Z",
        updated_at: "2026-10-07T11:30:00Z",
      }),
    ],
    SHA_A,
  );

  assert.deepEqual(selected, {
    runId: 100,
    sourceCommit: SHA_A,
    createdAt: "2026-10-07T10:00:00Z",
  });
});

test("fails closed for concurrent, failed, manual, or main-mismatched deployments", () => {
  assert.throws(
    () =>
      selectStableProductionDeployment(
        [
          run({ id: 101, status: "in_progress", conclusion: null, created_at: "2026-10-07T09:00:00Z" }),
          run(),
        ],
        SHA_A,
      ),
    /deployment is still in progress/i,
  );

  assert.throws(
    () =>
      selectStableProductionDeployment(
        [
          run({
            id: 103,
            event: "workflow_dispatch",
            status: "in_progress",
            conclusion: null,
            created_at: "2026-10-07T09:00:00Z",
          }),
          run(),
        ],
        SHA_A,
      ),
    /deployment is still in progress/i,
  );

  assert.throws(
    () =>
      selectStableProductionDeployment(
        [
          run({ id: 103, event: "workflow_dispatch", updated_at: "2026-10-07T12:00:00Z" }),
          run(),
        ],
        SHA_A,
      ),
    /manual deployment/i,
  );

  assert.throws(
    () =>
      selectStableProductionDeployment(
        [
          run({ id: 102, conclusion: "failure", updated_at: "2026-10-07T12:00:00Z" }),
          run(),
        ],
        SHA_A,
      ),
    /latest completed deployment did not succeed/i,
  );

  assert.throws(() => selectStableProductionDeployment([run()], SHA_B), /does not match current main/i);
  assert.throws(
    () =>
      selectStableProductionDeployment(
        [run({ id: 104 }), run({ id: 105, event: "workflow_dispatch" })],
        SHA_A,
      ),
    /same completion time|ambiguous/i,
  );
  assert.throws(
    () => selectStableProductionDeployment([run({ updated_at: "not-a-date" })], SHA_A),
    /malformed/i,
  );
});

test("exhaustively paginates workflow runs before accepting provenance", async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) =>
    run({
      id: 1_000 + index,
      created_at: `2026-10-07T10:${String(index % 60).padStart(2, "0")}:00Z`,
      updated_at: `2026-10-07T11:${String(index % 60).padStart(2, "0")}:00Z`,
    }),
  );
  const hiddenActive = run({
    id: 999,
    status: "in_progress",
    conclusion: null,
    created_at: "2026-10-01T10:00:00Z",
    updated_at: "2026-10-07T12:00:00Z",
  });
  const requestedPages = [];

  await assert.rejects(
    () =>
      resolveDeployedOpenApi({
        githubToken: "test-token",
        output: "/unused/openapi.json",
        mainShaLoader,
        fetchImpl: async (url) => {
          const page = Number(new URL(url).searchParams.get("page"));
          requestedPages.push(page);
          return jsonResponse({
            total_count: 101,
            workflow_runs: page === 1 ? firstPage : [hiddenActive],
          });
        },
      }),
    /still in progress/i,
  );
  assert.deepEqual(requestedPages, [1, 2]);
});

test("resolves a stable production OpenAPI snapshot without forwarding the GitHub token", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "deployed-openapi-"));
  const output = path.join(directory, "openapi.json");
  const calls = [];
  const responses = [
    jsonResponse({ total_count: 1, workflow_runs: [run()] }),
    jsonResponse(spec()),
    jsonResponse(spec()),
    jsonResponse({ total_count: 1, workflow_runs: [run()] }),
    jsonResponse({ total_count: 1, workflow_runs: [run()] }),
  ];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), authorization: options.headers?.Authorization ?? null });
    return responses.shift();
  };

  try {
    const result = await resolveDeployedOpenApi({
      githubToken: "test-token",
      output,
      fetchImpl,
      mainShaLoader,
    });

    assert.equal(result.sourceCommit, SHA_A);
    assert.equal(result.runId, 100);
    assert.match(result.openapiSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), spec());
    assert.deepEqual(
      calls.map(({ url }) => url),
      [
        `${RUNS_URL}&page=1`,
        OPENAPI_URL,
        OPENAPI_URL,
        `${RUNS_URL}&page=1`,
        `${RUNS_URL}&page=1`,
      ],
    );
    assert.equal(calls[0].authorization, "Bearer test-token");
    assert.equal(calls[1].authorization, null);
    assert.equal(calls[2].authorization, null);
    assert.equal(calls[3].authorization, "Bearer test-token");
    assert.equal(calls[4].authorization, "Bearer test-token");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("retries a transient GitHub deployment lookup failure", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "deployed-openapi-retry-"));
  const output = path.join(directory, "openapi.json");
  const responses = [
    new TypeError("fetch failed", { cause: Object.assign(new Error("dns"), { code: "EAI_AGAIN" }) }),
    jsonResponse({ total_count: 1, workflow_runs: [run()] }),
    jsonResponse(spec()),
    jsonResponse(spec()),
    jsonResponse({ total_count: 1, workflow_runs: [run()] }),
    jsonResponse({ total_count: 1, workflow_runs: [run()] }),
  ];

  try {
    const result = await resolveDeployedOpenApi({
      githubToken: "test-token",
      output,
      mainShaLoader,
      fetchImpl: async () => {
        const response = responses.shift();
        if (response instanceof Error) throw response;
        return response;
      },
    });
    assert.equal(result.sourceCommit, SHA_A);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("supports fixed command-backed loaders without exposing a GitHub token", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "deployed-openapi-loader-"));
  const output = path.join(directory, "openapi.json");
  let workflowLoads = 0;
  let openApiLoads = 0;
  let mainLoads = 0;

  try {
    const result = await resolveDeployedOpenApi({
      output,
      mainShaLoader: async () => {
        mainLoads += 1;
        return SHA_A;
      },
      workflowRunsLoader: async () => {
        workflowLoads += 1;
        return [run()];
      },
      openApiLoader: async () => {
        openApiLoads += 1;
        return spec();
      },
    });

    assert.equal(result.sourceCommit, SHA_A);
    assert.equal(mainLoads, 3);
    assert.equal(workflowLoads, 3);
    assert.equal(openApiLoads, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fails closed when any production-capable workflow run changes between snapshots", async () => {
  const selected = run();
  const older = run({
    id: 90,
    head_sha: "c".repeat(40),
    created_at: "2026-10-06T10:00:00Z",
    updated_at: "2026-10-06T10:10:00Z",
  });
  const rerun = run({
    ...older,
    run_attempt: 2,
    updated_at: "2026-10-06T10:20:00Z",
  });
  const snapshots = [
    [selected, older],
    [selected, rerun],
    [selected, rerun],
  ];

  await assert.rejects(
    () =>
      resolveDeployedOpenApi({
        output: "/unused/openapi.json",
        mainShaLoader,
        workflowRunsLoader: async () => snapshots.shift(),
        openApiLoader: async () => spec(),
      }),
    /workflow history changed/i,
  );
});

test("fails closed if the main SHA, deployment, or OpenAPI bytes change during capture", async () => {
  const stableRun = run();
  const changedRun = run({
    id: 101,
    head_sha: SHA_B,
    created_at: "2026-10-07T11:00:00Z",
    updated_at: "2026-10-07T11:10:00Z",
  });

  const changedSpecResponses = [
    jsonResponse({ total_count: 1, workflow_runs: [stableRun] }),
    jsonResponse(spec()),
    jsonResponse(spec("2.0.0")),
    jsonResponse({ total_count: 1, workflow_runs: [stableRun] }),
  ];
  await assert.rejects(
    () =>
      resolveDeployedOpenApi({
        githubToken: "test-token",
        output: "/unused/openapi.json",
        mainShaLoader,
        fetchImpl: async () => changedSpecResponses.shift(),
      }),
    /snapshot/i,
  );

  const responses = [
    jsonResponse({ total_count: 1, workflow_runs: [stableRun] }),
    jsonResponse(spec()),
    jsonResponse(spec()),
    jsonResponse({ total_count: 2, workflow_runs: [changedRun, stableRun] }),
  ];
  const mainShas = [SHA_A, SHA_B];
  await assert.rejects(
    () =>
      resolveDeployedOpenApi({
        githubToken: "test-token",
        output: "/unused/openapi.json",
        mainShaLoader: async () => mainShas.shift(),
        fetchImpl: async () => responses.shift(),
      }),
    /deployment changed|main branch changed/i,
  );
});
