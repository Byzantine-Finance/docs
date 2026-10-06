import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, resolve } from "node:path";

function isUrl(source) {
  return /^https?:\/\//i.test(source);
}

function isLoopback(hostname) {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (normalized === "localhost" || normalized === "::1") return true;
  return isIP(normalized) === 4 && normalized.startsWith("127.");
}

function validateOpenApi(spec, source) {
  const openApiVersion = typeof spec?.openapi === "string" && /^3\.(?:0|1)\.\d+$/.test(spec.openapi);
  const swaggerVersion = spec?.swagger === "2.0";
  const declaresVersion = typeof spec?.openapi === "string" || typeof spec?.swagger === "string";

  if (declaresVersion && !openApiVersion && !swaggerVersion) {
    throw new Error(`${source} does not declare a supported OpenAPI version`);
  }

  const validInfo =
    spec?.info &&
    typeof spec.info === "object" &&
    !Array.isArray(spec.info) &&
    typeof spec.info.title === "string" &&
    spec.info.title.length > 0 &&
    typeof spec.info.version === "string" &&
    spec.info.version.length > 0;
  const validPaths = spec?.paths && typeof spec.paths === "object" && !Array.isArray(spec.paths);

  if ((!openApiVersion && !swaggerVersion) || !validInfo || !validPaths) {
    throw new Error(`${source} is not a valid OpenAPI document`);
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.keys(value)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function semanticJson(value) {
  return JSON.stringify(canonicalize(value));
}

function jsonStyle(raw) {
  if (raw === undefined) return { indent: 2, newline: "\n", finalNewline: true };
  const newline = raw.includes("\r\n") ? "\r\n" : "\n";
  const indent = raw.match(/^\{\r?\n([ \t]+)"/u)?.[1] ?? 2;
  return { indent, newline, finalNewline: raw.endsWith(newline) };
}

async function atomicWrite(path, content) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function boundedResponseText(response, maxBytes) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel();
    throw new RangeError(`OpenAPI response exceeded ${maxBytes} bytes`);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw new RangeError(`OpenAPI response exceeded ${maxBytes} bytes`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

async function fetchTextWithRetry(
  source,
  options,
  { attempts = 3, timeoutMs = 10_000, maxBytes = 10 * 1024 * 1024 } = {},
) {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error("attempts must be a positive integer");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("timeoutMs must be a positive number");
  }
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new Error("maxBytes must be a positive integer");
  }

  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(source, {
        ...options,
        redirect: "manual",
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        return { ok: false, status: response.status, redirect: true };
      }
      const retryable = response.status === 429 || response.status >= 500;

      if (retryable && attempt < attempts) {
        await response.body?.cancel();
        lastError = new Error(`HTTP ${response.status}`);
      } else if (!response.ok) {
        await response.body?.cancel();
        return { ok: false, status: response.status };
      } else {
        return { ok: true, status: response.status, text: await boundedResponseText(response, maxBytes) };
      }
    } catch (error) {
      const timedOut = controller.signal.aborted;
      lastError = timedOut ? new Error(`${source} timed out after ${timeoutMs}ms`) : error;
      if (error instanceof RangeError) throw error;
      if (attempt === attempts) throw lastError;
    } finally {
      clearTimeout(timer);
    }

    await wait(200 * attempt);
  }

  throw lastError;
}

export async function loadOpenApi(
  source,
  {
    token,
    attempts = 3,
    timeoutMs = 10_000,
    maxBytes = 10 * 1024 * 1024,
    allowedOrigins = [],
  } = {},
) {
  if (!source) throw new Error("An OpenAPI source URL or file path is required");

  let raw;
  if (isUrl(source)) {
    const sourceUrl = new URL(source);
    if (token && sourceUrl.protocol !== "https:" && !isLoopback(sourceUrl.hostname)) {
      throw new Error("HTTPS is required when OPENAPI_AUTH_TOKEN is set");
    }
    if (
      token &&
      !isLoopback(sourceUrl.hostname) &&
      !allowedOrigins.map((origin) => new URL(origin).origin).includes(sourceUrl.origin)
    ) {
      throw new Error(`${sourceUrl.origin} must be allowlisted before credentials are sent`);
    }

    const headers = {
      accept: "application/json",
      "user-agent": "Byzantine-Docs-OpenAPI-Sync/1.0",
    };
    if (token) headers.authorization = `Bearer ${token}`;

    const response = await fetchTextWithRetry(
      source,
      { headers },
      { attempts, timeoutMs, maxBytes },
    );
    if (!response.ok) {
      if (response.redirect) throw new Error(`${source} redirects are not allowed`);
      throw new Error(`Unable to fetch ${source}: HTTP ${response.status}`);
    }
    raw = response.text;
  } else {
    raw = await readFile(resolve(source), "utf8");
  }

  let spec;
  try {
    spec = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${source} did not return valid JSON: ${error.message}`);
  }

  validateOpenApi(spec, source);
  return spec;
}

export async function syncOpenApi({ spec, target }) {
  validateOpenApi(spec, "OpenAPI source");
  const targetPath = resolve(target);
  let current;
  let currentRaw;

  try {
    currentRaw = await readFile(targetPath, "utf8");
    current = JSON.parse(currentRaw);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const changed = current === undefined || semanticJson(current) !== semanticJson(spec);
  const style = jsonStyle(currentRaw);
  const serialized = JSON.stringify(canonicalize(spec), null, style.indent).replaceAll(
    "\n",
    style.newline,
  );
  const output = changed
    ? `${serialized}${style.finalNewline ? style.newline : ""}`
    : currentRaw;
  const sha256 = createHash("sha256").update(output).digest("hex");

  if (changed) {
    await mkdir(dirname(targetPath), { recursive: true });
    await atomicWrite(targetPath, output);
  }

  return { changed, sha256, target: targetPath };
}
