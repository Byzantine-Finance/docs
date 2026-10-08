const CONSOLIDATION_WINDOW_MS = 24 * 60 * 60 * 1_000;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const COMPANION_SDK_OUTCOME_PATTERN =
  /^(?:https:\/\/github\.com\/Byzantine-Finance\/integrator-sdk\/pull\/[1-9][0-9]*|none|blocked)$/u;

function isCompleteMarker({
  deploymentRunId,
  baseSourceSha,
  targetSha,
  openapiSha256,
  windowStart,
  generatorVersion,
  includedCommits,
  companionSdkPr,
} = {}, now) {
  const windowTime = Date.parse(windowStart);
  return (
    Number.isSafeInteger(deploymentRunId) &&
    deploymentRunId > 0 &&
    SHA_PATTERN.test(baseSourceSha ?? "") &&
    SHA_PATTERN.test(targetSha ?? "") &&
    SHA256_PATTERN.test(openapiSha256 ?? "") &&
    baseSourceSha !== targetSha &&
    Number.isFinite(windowTime) &&
    (now === undefined || windowTime <= Date.parse(now)) &&
    Number.isInteger(generatorVersion) &&
    generatorVersion > 0 &&
    Array.isArray(includedCommits) &&
    includedCommits.length > 0 &&
    includedCommits.every((commit) => SHA_PATTERN.test(commit)) &&
    new Set(includedCommits).size === includedCommits.length &&
    includedCommits.includes(targetSha) &&
    typeof companionSdkPr === "string" &&
    COMPANION_SDK_OUTCOME_PATTERN.test(companionSdkPr)
  );
}

export function renderPrMarker(marker) {
  if (!isCompleteMarker(marker)) {
    throw new Error("A complete PR marker is required");
  }

  const {
    deploymentRunId,
    baseSourceSha,
    targetSha,
    openapiSha256,
    windowStart,
    generatorVersion,
    includedCommits,
    companionSdkPr,
  } = marker;
  return `<!-- byzantine-docs-pr:${JSON.stringify({
    deploymentRunId,
    baseSourceSha,
    targetSha,
    openapiSha256,
    windowStart,
    generatorVersion,
    includedCommits,
    companionSdkPr,
  })} -->`;
}

export function parsePrMarker(body) {
  if (typeof body !== "string") return null;

  const match = body.match(/<!-- byzantine-docs-pr:(\{[^\n]*\}) -->/);
  if (!match) return null;

  try {
    const marker = JSON.parse(match[1]);
    return isCompleteMarker(marker) ? marker : null;
  } catch {
    return null;
  }
}

export function decidePrPolicy({ now, pullRequest, change }) {
  if (!pullRequest) {
    return { action: "create", source: "docs-main", reason: "no-existing-pr" };
  }

  if (pullRequest.state === "merged" || pullRequest.state === "closed") {
    return { action: "create", source: "docs-main", reason: "previous-pr-finished" };
  }

  if (pullRequest.state === "open" && !pullRequest.marker) {
    return { action: "escalate", source: "open-pr", reason: "requires-review" };
  }
  if (pullRequest.state === "open" && !isCompleteMarker(pullRequest.marker, now)) {
    return { action: "escalate", source: "open-pr", reason: "invalid-marker" };
  }

  if (pullRequest.state === "open" && change.relationship === "fix") {
    return { action: "update", source: "open-pr", reason: "related-fix" };
  }

  const ageMs = Date.parse(now) - Date.parse(pullRequest.marker?.windowStart);
  if (
    pullRequest.state === "open" &&
    change.relationship === "compatible" &&
    change.size === "small" &&
    ageMs < CONSOLIDATION_WINDOW_MS
  ) {
    return { action: "update", source: "open-pr", reason: "compatible-within-window" };
  }

  if (
    pullRequest.state === "open" &&
    change.relationship === "unrelated" &&
    ageMs > CONSOLIDATION_WINDOW_MS
  ) {
    return { action: "queue", source: "docs-main", reason: "unrelated-after-window" };
  }

  if (pullRequest.state === "open") {
    return { action: "escalate", source: "open-pr", reason: "requires-review" };
  }
}
