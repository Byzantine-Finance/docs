import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  resolveDeployedOpenApi,
  resolveProvenanceVerifiedOpenApi,
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

function capturedSpec(version = "1.0.0") {
  const document = spec(version);
  return { rawBytes: Buffer.from(JSON.stringify(document)), spec: document };
}

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });
}

const mainShaLoader = async () => SHA_A;

test("configures production curl to reject the first redirect", async () => {
  const module = await import("../scripts/lib/deployed-openapi.mjs");
  assert.equal(typeof module.productionOpenApiCurlArguments, "function");
  const args = module.productionOpenApiCurlArguments(OPENAPI_URL);
  assert.ok(args.includes("--location"));
  assert.equal(args[args.indexOf("--max-redirs") + 1], "0");
  assert.equal(args.at(-1), OPENAPI_URL);
});

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

test("rejects a production capture that omits raw bytes", async () => {
  await assert.rejects(
    () =>
      resolveProvenanceVerifiedOpenApi({
        output: "/unused/openapi.json",
        workflowRunsLoader: async () => [run()],
        openApiLoader: async () => spec(),
        exactOpenApiLoader: async () => spec(),
      }),
    /raw bytes.*required/i,
  );
});

test("verifies a deployed OpenAPI against its exact run SHA even when main advanced", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "provenance-openapi-"));
  const output = path.join(directory, "openapi.json");
  const deployedRun = run({ head_sha: SHA_A });
  const snapshots = [[deployedRun], [deployedRun], [deployedRun]];
  const rawArtifact = Buffer.from(`${JSON.stringify(spec())}\n`);
  let productionLoads = 0;
  const exportedCommits = [];

  try {
    const result = await resolveProvenanceVerifiedOpenApi({
      output,
      workflowRunsLoader: async () => snapshots.shift(),
      openApiLoader: async () => {
        productionLoads += 1;
        return { rawBytes: rawArtifact, spec: spec() };
      },
      exactOpenApiLoader: async (sourceCommit) => {
        exportedCommits.push(sourceCommit);
        return spec();
      },
    });

    assert.equal(result.sourceCommit, SHA_A);
    assert.equal(result.runId, 100);
    assert.equal(result.provenanceVerified, true);
    assert.equal(productionLoads, 3);
    assert.deepEqual(exportedCommits, [SHA_A]);
    assert.deepEqual(await readFile(output), rawArtifact);
    assert.equal(
      result.openapiSha256,
      (await import("node:crypto")).createHash("sha256").update(rawArtifact).digest("hex"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects a deployment that starts after the third production read", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "provenance-final-race-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const deployedRun = run({ id: 100, head_sha: SHA_A });
  const newerRun = run({
    id: 101,
    head_sha: SHA_B,
    status: "in_progress",
    conclusion: null,
    updated_at: "2026-10-08T10:20:00Z",
  });
  const snapshots = [[deployedRun], [deployedRun], [newerRun, deployedRun]];

  await assert.rejects(
    () =>
      resolveProvenanceVerifiedOpenApi({
        output: path.join(directory, "openapi.json"),
        workflowRunsLoader: async () => snapshots.shift(),
        openApiLoader: async () => capturedSpec(),
        exactOpenApiLoader: async () => spec(),
      }),
    /deployment changed|still in progress|unfinished/i,
  );
});

test("rejects any unfinished production-capable deployment", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "provenance-unfinished-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const deployedRun = run({ id: 200, updated_at: "2026-10-08T10:10:00Z" });
  const staleWaiting = run({
    id: 50,
    status: "waiting",
    conclusion: null,
    created_at: "2026-09-01T10:00:00Z",
    updated_at: "2026-09-01T10:10:00Z",
  });
  const snapshot = [deployedRun, staleWaiting];

  await assert.rejects(
    () =>
      resolveProvenanceVerifiedOpenApi({
        output: path.join(directory, "openapi.json"),
        workflowRunsLoader: async () => snapshot,
        openApiLoader: async () => capturedSpec(),
        exactOpenApiLoader: async () => spec(),
      }),
    /unfinished|still in progress/i,
  );
});

test("rejects production OpenAPI that cannot be reproduced from the deployment SHA", async () => {
  await assert.rejects(
    () =>
      resolveProvenanceVerifiedOpenApi({
        output: "/unused/openapi.json",
        workflowRunsLoader: async () => [run()],
        openApiLoader: async () => capturedSpec("2.0.0"),
        exactOpenApiLoader: async () => spec("1.0.0"),
      }),
    /does not match the exact deployment commit/i,
  );
});

test("rejects tied latest production completion timestamps", async () => {
  await assert.rejects(
    () =>
      resolveProvenanceVerifiedOpenApi({
        output: "/unused/openapi.json",
        workflowRunsLoader: async () => [run({ id: 100 }), run({ id: 101, head_sha: SHA_B })],
        openApiLoader: async () => capturedSpec(),
        exactOpenApiLoader: async () => spec(),
      }),
    /same completion time|ambiguous/i,
  );
});
