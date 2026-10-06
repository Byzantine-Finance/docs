import { createHash } from "node:crypto";

const SOURCE_REPOSITORY = "Byzantine-Finance/byzantine-api";
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

function valid(watermark) {
  return (
    watermark?.schemaVersion === 1 &&
    watermark.sourceRepository === SOURCE_REPOSITORY &&
    SHA_PATTERN.test(watermark.sourceCommit ?? "") &&
    SHA256_PATTERN.test(watermark.openapiSha256 ?? "") &&
    Number.isInteger(watermark.generatorVersion) &&
    watermark.generatorVersion > 0
  );
}

function assertValid(watermark) {
  if (!valid(watermark)) throw new Error("Invalid API watermark");
  return watermark;
}

export function renderWatermark(watermark) {
  return `${JSON.stringify(assertValid(watermark), null, 2)}\n`;
}

export function parseWatermark(raw) {
  try {
    return assertValid(JSON.parse(raw));
  } catch {
    throw new Error("Invalid API watermark");
  }
}

export function verifyWatermarkArtifact(watermark, artifact) {
  const validated = assertValid(watermark);
  const actual = createHash("sha256").update(artifact).digest("hex");
  if (actual !== validated.openapiSha256) {
    throw new Error("API watermark does not match the committed OpenAPI artifact");
  }
  return true;
}
