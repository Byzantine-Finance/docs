import { createHash } from "node:crypto";

import { loadOpenApi, syncOpenApi } from "./openapi-sync.mjs";

export const DEPLOY_WORKFLOW_RUNS_URL =
  "https://api.github.com/repos/Byzantine-Finance/byzantine-api/actions/workflows/deploy-api.yml/runs?per_page=100";
export const MAIN_COMMIT_URL =
  "https://api.github.com/repos/Byzantine-Finance/byzantine-api/commits/main";
export const PRODUCTION_OPENAPI_URL =
  "https://api.byzantine.fi/api-docs/openapi-integrator.json";

const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const MAX_GITHUB_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_WORKFLOW_PAGES = 100;

function timestamp(value) {
  return Date.parse(value);
}

function validateRun(run) {
  return (
    run &&
    typeof run === "object" &&
    Number.isSafeInteger(run.id) &&
    typeof run.event === "string" &&
    typeof run.head_branch === "string" &&
    typeof run.head_sha === "string" &&
    Number.isSafeInteger(run.run_attempt) &&
    run.run_attempt >= 1 &&
    typeof run.status === "string" &&
    typeof run.created_at === "string" &&
    Number.isFinite(timestamp(run.created_at)) &&
    typeof run.updated_at === "string" &&
    Number.isFinite(timestamp(run.updated_at))
  );
}

export function selectStableProductionDeployment(runs, currentMainSha) {
  if (!Array.isArray(runs) || runs.some((run) => !validateRun(run))) {
    throw new Error("GitHub returned malformed deployment workflow runs");
  }
  if (!SHA_PATTERN.test(currentMainSha ?? "")) {
    throw new Error("GitHub returned a malformed current main SHA");
  }

  const relevant = runs.filter(
    (run) =>
      (run.event === "push" && run.head_branch === "main") ||
      run.event === "workflow_dispatch",
  );
  if (relevant.some((run) => run.status !== "completed")) {
    throw new Error("A production-capable deployment is still in progress");
  }

  const latest = [...relevant].sort(
    (left, right) => timestamp(right.updated_at) - timestamp(left.updated_at),
  )[0];
  if (!latest) {
    throw new Error("No completed production deployment is available");
  }
  if (
    relevant.filter((run) => timestamp(run.updated_at) === timestamp(latest.updated_at)).length !== 1
  ) {
    throw new Error("Production deployment provenance is ambiguous at the same completion time");
  }
  if (latest.event === "workflow_dispatch") {
    throw new Error("A manual deployment can make the production source ambiguous");
  }
  if (latest.conclusion !== "success") {
    throw new Error("The latest completed deployment did not succeed");
  }
  if (!SHA_PATTERN.test(latest.head_sha)) {
    throw new Error("The latest deployment has a malformed source SHA");
  }
  if (latest.head_sha !== currentMainSha) {
    throw new Error("The latest successful deployment does not match current main");
  }

  return {
    runId: latest.id,
    sourceCommit: latest.head_sha,
    createdAt: latest.created_at,
  };
}

function relevantWorkflowFingerprint(runs) {
  return JSON.stringify(
    runs
      .filter(
        (run) =>
          (run.event === "push" && run.head_branch === "main") ||
          run.event === "workflow_dispatch",
      )
      .map((run) => ({
        id: run.id,
        runAttempt: run.run_attempt,
        event: run.event,
        headBranch: run.head_branch,
        headSha: run.head_sha,
        status: run.status,
        conclusion: run.conclusion ?? null,
        createdAt: run.created_at,
        updatedAt: run.updated_at,
      }))
      .sort((left, right) => left.id - right.id || left.runAttempt - right.runAttempt),
  );
}

async function readBoundedText(response, maximumBytes) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    throw new Error(`GitHub response exceeds ${maximumBytes} bytes`);
  }
  if (!response.body) return response.text();

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel();
        throw new Error(`GitHub response exceeds ${maximumBytes} bytes`);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function loadWorkflowRuns({ githubToken, fetchImpl }) {
  if (!githubToken) throw new Error("GH_TOKEN is required to inspect deployment workflow runs");
  const allRuns = [];
  const seenRunIds = new Set();
  let expectedTotal;

  for (let page = 1; page <= MAX_WORKFLOW_PAGES; page += 1) {
    const url = `${DEPLOY_WORKFLOW_RUNS_URL}&page=${page}`;
    let response;
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        response = await fetchImpl(url, {
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${githubToken}`,
            "X-GitHub-Api-Version": "2022-11-28",
          },
          redirect: "error",
        });
        if (response.status !== 429 && response.status < 500) break;
        await response.body?.cancel();
        lastError = new Error(`GitHub deployment lookup failed with HTTP ${response.status}`);
      } catch (error) {
        lastError = error;
      }
      if (attempt < 3) await wait(200 * attempt);
    }
    if (!response || response.status === 429 || response.status >= 500) throw lastError;
    if (!response.ok) {
      throw new Error(`GitHub deployment lookup failed with HTTP ${response.status}`);
    }

    const raw = await readBoundedText(response, MAX_GITHUB_RESPONSE_BYTES);
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new Error("GitHub deployment lookup returned invalid JSON");
    }
    if (!Number.isSafeInteger(payload.total_count) || payload.total_count < 0 || !Array.isArray(payload.workflow_runs)) {
      throw new Error("GitHub returned malformed paginated deployment workflow runs");
    }
    if (expectedTotal === undefined) expectedTotal = payload.total_count;
    if (payload.total_count !== expectedTotal) {
      throw new Error("GitHub deployment workflow history changed during pagination");
    }
    for (const run of payload.workflow_runs) {
      if (!run || !Number.isSafeInteger(run.id) || seenRunIds.has(run.id)) {
        throw new Error("GitHub returned duplicate or malformed paginated workflow runs");
      }
      seenRunIds.add(run.id);
      allRuns.push(run);
    }
    if (allRuns.length === expectedTotal) return allRuns;
    if (allRuns.length > expectedTotal || payload.workflow_runs.length === 0) {
      throw new Error("GitHub returned an incomplete paginated workflow history");
    }
  }

  throw new Error("GitHub deployment workflow history exceeds the safe pagination limit");
}

async function loadMainSha({ githubToken, fetchImpl }) {
  if (!githubToken) throw new Error("GH_TOKEN is required to inspect the current main commit");
  const response = await fetchImpl(MAIN_COMMIT_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${githubToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    redirect: "error",
  });
  if (!response.ok) throw new Error(`GitHub main lookup failed with HTTP ${response.status}`);
  const raw = await readBoundedText(response, MAX_GITHUB_RESPONSE_BYTES);
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error("GitHub main lookup returned invalid JSON");
  }
  if (!SHA_PATTERN.test(payload.sha ?? "")) {
    throw new Error("GitHub returned a malformed main SHA");
  }
  return payload.sha;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

function semanticHash(spec) {
  return createHash("sha256").update(JSON.stringify(canonicalize(spec))).digest("hex");
}

function selectRecentProductionCandidate(runs) {
  if (!Array.isArray(runs) || runs.length === 0 || runs.some((run) => !validateRun(run))) {
    throw new Error("GitHub returned malformed recent deployment workflow runs");
  }
  const relevant = runs
    .filter(
      (run) =>
        (run.event === "push" && run.head_branch === "main") ||
        run.event === "workflow_dispatch",
    );
  if (relevant.some((run) => run.status !== "completed")) {
    throw new Error("A production-capable deployment is unfinished");
  }
  relevant.sort(
      (left, right) =>
        timestamp(right.updated_at) - timestamp(left.updated_at) || right.id - left.id,
    );
  const latest = relevant[0];
  if (!latest) throw new Error("No recent production deployment is available");
  if (
    relevant.filter((run) => timestamp(run.updated_at) === timestamp(latest.updated_at)).length !== 1
  ) {
    throw new Error("Production deployment provenance is ambiguous at the same completion time");
  }
  if (latest.status !== "completed") {
    throw new Error("The latest production deployment is still in progress");
  }
  if (latest.event === "workflow_dispatch") {
    throw new Error("The latest production deployment is manual and ambiguous");
  }
  if (latest.conclusion !== "success") {
    throw new Error("The latest production deployment did not succeed");
  }
  if (!SHA_PATTERN.test(latest.head_sha)) {
    throw new Error("The latest production deployment has a malformed source SHA");
  }
  return {
    runId: latest.id,
    sourceCommit: latest.head_sha,
    createdAt: latest.created_at,
  };
}

export async function resolveProvenanceVerifiedOpenApi({
  output,
  workflowRunsLoader,
  openApiLoader,
  exactOpenApiLoader,
}) {
  if (!output) throw new Error("An output path is required");
  if (
    typeof workflowRunsLoader !== "function" ||
    typeof openApiLoader !== "function" ||
    typeof exactOpenApiLoader !== "function"
  ) {
    throw new Error("Deployment, production OpenAPI, and exact-commit loaders are required");
  }

  const beforeRuns = await workflowRunsLoader();
  const deployment = selectRecentProductionCandidate(beforeRuns);
  const first = await openApiLoader();
  const second = await openApiLoader();
  const productionHash = semanticHash(first);
  if (productionHash !== semanticHash(second)) {
    throw new Error("The production OpenAPI snapshot changed during capture");
  }

  const exact = await exactOpenApiLoader(deployment.sourceCommit);
  if (semanticHash(exact) !== productionHash) {
    throw new Error("The production OpenAPI does not match the exact deployment commit");
  }

  const afterRuns = await workflowRunsLoader();
  const confirmed = selectRecentProductionCandidate(afterRuns);
  if (
    relevantWorkflowFingerprint(beforeRuns) !== relevantWorkflowFingerprint(afterRuns) ||
    confirmed.runId !== deployment.runId ||
    confirmed.sourceCommit !== deployment.sourceCommit
  ) {
    throw new Error("The production deployment changed during OpenAPI capture");
  }

  const third = await openApiLoader();
  if (semanticHash(third) !== productionHash) {
    throw new Error("The production OpenAPI snapshot changed during confirmation");
  }

  const finalRuns = await workflowRunsLoader();
  const finalConfirmation = selectRecentProductionCandidate(finalRuns);
  if (
    relevantWorkflowFingerprint(beforeRuns) !== relevantWorkflowFingerprint(finalRuns) ||
    finalConfirmation.runId !== deployment.runId ||
    finalConfirmation.sourceCommit !== deployment.sourceCommit
  ) {
    throw new Error("The production deployment changed during OpenAPI confirmation");
  }

  const sync = await syncOpenApi({ spec: first, target: output });
  return {
    ...deployment,
    openapiSha256: sync.sha256,
    output,
    changed: sync.changed,
    provenanceVerified: true,
  };
}

export async function resolveDeployedOpenApi({
  githubToken,
  output,
  fetchImpl = fetch,
  mainShaLoader = () => loadMainSha({ githubToken, fetchImpl }),
  workflowRunsLoader = () => loadWorkflowRuns({ githubToken, fetchImpl }),
  openApiLoader = () => loadOpenApi(PRODUCTION_OPENAPI_URL, { fetchImpl }),
}) {
  if (!output) throw new Error("An output path is required");

  const beforeMainSha = await mainShaLoader();
  const beforeRuns = await workflowRunsLoader();
  const beforeDeployment = selectStableProductionDeployment(
    beforeRuns,
    beforeMainSha,
  );
  const first = await openApiLoader();
  const second = await openApiLoader();
  if (semanticHash(first) !== semanticHash(second)) {
    throw new Error("The production OpenAPI snapshot changed during capture");
  }

  const afterMainSha = await mainShaLoader();
  if (beforeMainSha !== afterMainSha) {
    throw new Error("The main branch changed during OpenAPI capture");
  }
  const afterRuns = await workflowRunsLoader();
  const afterDeployment = selectStableProductionDeployment(
    afterRuns,
    afterMainSha,
  );
  const confirmMainSha = await mainShaLoader();
  if (afterMainSha !== confirmMainSha) {
    throw new Error("The main branch changed during deployment confirmation");
  }
  const confirmRuns = await workflowRunsLoader();
  const confirmDeployment = selectStableProductionDeployment(confirmRuns, confirmMainSha);
  const beforeFingerprint = relevantWorkflowFingerprint(beforeRuns);
  if (
    beforeFingerprint !== relevantWorkflowFingerprint(afterRuns) ||
    beforeFingerprint !== relevantWorkflowFingerprint(confirmRuns)
  ) {
    throw new Error("The production deployment workflow history changed during capture");
  }
  if (
    beforeDeployment.runId !== afterDeployment.runId ||
    beforeDeployment.sourceCommit !== afterDeployment.sourceCommit ||
    beforeDeployment.runId !== confirmDeployment.runId ||
    beforeDeployment.sourceCommit !== confirmDeployment.sourceCommit
  ) {
    throw new Error("The production deployment changed during OpenAPI capture");
  }

  const sync = await syncOpenApi({ spec: first, target: output });
  return {
    ...beforeDeployment,
    openapiSha256: sync.sha256,
    output,
    changed: sync.changed,
  };
}
