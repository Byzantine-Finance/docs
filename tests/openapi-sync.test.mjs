import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { loadOpenApi, syncOpenApi } from "../scripts/lib/openapi-sync.mjs";

const SPEC = {
  openapi: "3.0.3",
  info: { title: "Example", version: "1.0.0" },
  paths: { "/health": { get: { responses: { 200: { description: "OK" } } } } },
};

test("loadOpenApi reads and validates a local JSON file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openapi-sync-"));
  const source = join(dir, "source.json");
  await writeFile(source, JSON.stringify(SPEC));

  assert.deepEqual(await loadOpenApi(source), SPEC);
});

test("loadOpenApi fetches and validates an HTTPS-style URL", async (t) => {
  const server = createServer((request, response) => {
    assert.equal(request.url, "/openapi.json");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(SPEC));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const { port } = server.address();
  assert.deepEqual(await loadOpenApi(`http://127.0.0.1:${port}/openapi.json`), SPEC);
});

test("loadOpenApi authenticates loopback HTTP sources when a token is provided", async (t) => {
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer test-token");
    response.end(JSON.stringify(SPEC));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const { port } = server.address();
  assert.deepEqual(
    await loadOpenApi(`http://127.0.0.1:${port}/openapi.json`, { token: "test-token" }),
    SPEC,
  );
});

test("loadOpenApi rejects redirects before forwarding credentials", async (t) => {
  let redirectedRequests = 0;
  const target = createServer((_request, response) => {
    redirectedRequests += 1;
    response.end(JSON.stringify(SPEC));
  });
  await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
  t.after(() => target.close());

  const source = createServer((_request, response) => {
    response.statusCode = 302;
    response.setHeader("location", `http://127.0.0.1:${target.address().port}/openapi.json`);
    response.end();
  });
  await new Promise((resolve) => source.listen(0, "127.0.0.1", resolve));
  t.after(() => source.close());

  await assert.rejects(
    () =>
      loadOpenApi(`http://127.0.0.1:${source.address().port}/openapi.json`, {
        token: "test-token",
      }),
    /redirects are not allowed/,
  );
  assert.equal(redirectedRequests, 0);
});

test("loadOpenApi rejects credentials over non-loopback HTTP", async () => {
  await assert.rejects(
    () => loadOpenApi("http://example.com/openapi.json", { token: "test-token" }),
    /HTTPS is required when OPENAPI_AUTH_TOKEN is set/,
  );
});

test("loadOpenApi requires an explicit allowlist before sending credentials to remote HTTPS", async () => {
  await assert.rejects(
    () => loadOpenApi("https://example.com/openapi.json", { token: "test-token" }),
    /must be allowlisted before credentials are sent/,
  );
});

test("loadOpenApi bounds remote response bodies", async (t) => {
  const server = createServer((_request, response) => {
    response.end(JSON.stringify({ ...SPEC, padding: "x".repeat(1_000) }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  await assert.rejects(
    () =>
      loadOpenApi(`http://127.0.0.1:${server.address().port}/openapi.json`, {
        attempts: 1,
        maxBytes: 64,
      }),
    /exceeded 64 bytes/,
  );
});

test("loadOpenApi times out bounded remote requests", async (t) => {
  const server = createServer((_request, response) => {
    setTimeout(() => response.end(JSON.stringify(SPEC)), 200);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const { port } = server.address();
  await assert.rejects(
    () =>
      loadOpenApi(`http://127.0.0.1:${port}/openapi.json`, {
        attempts: 1,
        timeoutMs: 20,
      }),
    /timed out after 20ms/,
  );
});

test("loadOpenApi retries a transient remote failure", async (t) => {
  let attempts = 0;
  const server = createServer((_request, response) => {
    attempts += 1;
    if (attempts === 1) {
      response.statusCode = 503;
      response.end("try again");
      return;
    }
    response.end(JSON.stringify(SPEC));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const { port } = server.address();
  assert.deepEqual(await loadOpenApi(`http://127.0.0.1:${port}/openapi.json`), SPEC);
  assert.equal(attempts, 2);
});

test("loadOpenApi rejects unsupported OpenAPI versions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openapi-sync-"));
  const source = join(dir, "source.json");
  await writeFile(
    source,
    JSON.stringify({ openapi: "not-a-version", info: SPEC.info, paths: SPEC.paths }),
  );

  await assert.rejects(() => loadOpenApi(source), /supported OpenAPI version/);
});

test("loadOpenApi requires OpenAPI info metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openapi-sync-"));
  const source = join(dir, "source.json");
  await writeFile(source, JSON.stringify({ openapi: "3.0.3", paths: SPEC.paths }));

  await assert.rejects(() => loadOpenApi(source), /valid OpenAPI document/);
});

test("loadOpenApi rejects content that is not an OpenAPI document", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openapi-sync-"));
  const source = join(dir, "source.json");
  await writeFile(source, JSON.stringify({ hello: "world" }));

  await assert.rejects(() => loadOpenApi(source), /valid OpenAPI document/);
});

test("syncOpenApi preserves source object key order in written artifacts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openapi-sync-"));
  const target = join(dir, "openapi.json");
  const sourceOrdered = {
    paths: SPEC.paths,
    openapi: SPEC.openapi,
    info: { version: "1.0.0", title: "Example" },
  };

  await syncOpenApi({ spec: sourceOrdered, target });

  assert.equal(await readFile(target, "utf8"), `${JSON.stringify(sourceOrdered, null, 2)}\n`);
});

test("syncOpenApi writes deterministic formatted JSON and reports a change", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openapi-sync-"));
  const target = join(dir, "openapi.json");

  const result = await syncOpenApi({ spec: SPEC, target });

  assert.equal(result.changed, true);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.equal(
    await readFile(target, "utf8"),
    `${JSON.stringify(SPEC, null, 2)}\n`,
  );
});

test("syncOpenApi preserves the target indentation and final-newline style on changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openapi-sync-"));
  const target = join(dir, "openapi.json");
  await writeFile(target, JSON.stringify(SPEC, null, 4));
  const changedSpec = structuredClone(SPEC);
  changedSpec.info.version = "1.1.0";

  const result = await syncOpenApi({ spec: changedSpec, target });

  assert.equal(result.changed, true);
  assert.equal(
    await readFile(target, "utf8"),
    JSON.stringify(changedSpec, null, 4),
  );
});

test("syncOpenApi is a no-op when the semantic document is unchanged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openapi-sync-"));
  const target = join(dir, "openapi.json");
  const preserved = `${JSON.stringify(SPEC, null, 4)}\n`;
  await writeFile(target, preserved);

  const result = await syncOpenApi({ spec: SPEC, target });

  assert.equal(result.changed, false);
  assert.equal(await readFile(target, "utf8"), preserved);
  assert.equal(
    result.sha256,
    (await import("node:crypto")).createHash("sha256").update(preserved).digest("hex"),
  );
});

test("the diff CLI writes machine-readable and compact Markdown reports", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openapi-diff-"));
  const before = join(dir, "before.json");
  const after = join(dir, "after.json");
  const jsonTarget = join(dir, "diff.json");
  const markdownTarget = join(dir, "diff.md");
  const changed = structuredClone(SPEC);
  changed.paths["/accounts"] = {
    post: { operationId: "createAccount", responses: { 200: { description: "OK" } } },
  };
  await writeFile(before, JSON.stringify(SPEC));
  await writeFile(after, JSON.stringify(changed));

  await promisify(execFile)(
    process.execPath,
    [
      "scripts/analyze-openapi.mjs",
      "--before",
      before,
      "--after",
      after,
      "--json-out",
      jsonTarget,
      "--markdown-out",
      markdownTarget,
    ],
    { cwd: new URL("..", import.meta.url) },
  );

  const report = JSON.parse(await readFile(jsonTarget, "utf8"));
  assert.deepEqual(report.operations.added.map(({ method, path }) => ({ method, path })), [
    { method: "POST", path: "/accounts" },
  ]);
  assert.match(await readFile(markdownTarget, "utf8"), /`POST \/accounts`/);
});

test("the CLI fetches the configured source and updates the target", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openapi-sync-"));
  const source = join(dir, "source.json");
  const target = join(dir, "target.json");
  await writeFile(source, JSON.stringify(SPEC));

  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["scripts/sync-openapi.mjs", "--source", source, "--target", target],
    { cwd: new URL("..", import.meta.url) },
  );

  assert.match(stdout, /OpenAPI updated/);
  assert.deepEqual(JSON.parse(await readFile(target, "utf8")), SPEC);
});
