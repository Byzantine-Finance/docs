import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { exportIntegratorOpenApiAtCommit } from "../scripts/lib/api-openapi-export.mjs";

const SHA = "a".repeat(40);
const SPEC = {
  openapi: "3.0.3",
  info: { title: "Byzantine Integrator API", version: "0.2.0" },
  paths: {},
};

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "byzantine-openapi-export-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const apiRepository = path.join(directory, "api");
  const workspaceDirectory = path.join(directory, "worktrees");
  const cargoTargetDirectory = path.join(directory, "cargo-target");
  await mkdir(apiRepository, { recursive: true });
  return { directory, apiRepository, workspaceDirectory, cargoTargetDirectory };
}

function fakeExec({
  cargoStdout = JSON.stringify(SPEC),
  failCargo = false,
  missingOpenSslOnce = false,
  missingCommitOnce = false,
  failWorktreeRemoveOnce = false,
  calls,
}) {
  let cargoCalls = 0;
  let catFileCalls = 0;
  let removeCalls = 0;
  return async (file, args, options = {}) => {
    calls.push({ file, args: [...args], options });
    if (file === "git" && args.includes("cat-file")) {
      catFileCalls += 1;
      if (missingCommitOnce && catFileCalls === 1) throw new Error("missing commit");
      return { stdout: "", stderr: "" };
    }
    if (file === "git" && args.includes("get-url")) {
      return { stdout: "https://github.com/Byzantine-Finance/byzantine-api.git\n", stderr: "" };
    }
    if (file === "git" && args.includes("fetch")) return { stdout: "", stderr: "" };
    if (file === "git" && args.includes("add")) {
      const worktree = args.at(-2);
      await mkdir(path.join(worktree, "src", "bin"), { recursive: true });
      await writeFile(path.join(worktree, "Cargo.toml"), '[package]\nname = "fixture"\nversion = "0.1.0"\n');
      await writeFile(
        path.join(worktree, "Cargo.lock"),
        'version = 3\n\n[[package]]\nname = "fixture"\nversion = "0.1.0"\ndependencies = [\n]\n\n[[package]]\nname = "openssl"\nversion = "0.10.73"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "fixture"\n\n[[package]]\nname = "openssl-sys"\nversion = "0.9.109"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "fixture"\ndependencies = [\n "cc",\n "libc",\n "pkg-config",\n "vcpkg",\n]\n',
      );
      return { stdout: "", stderr: "" };
    }
    if (file === "cargo") {
      cargoCalls += 1;
      if (failCargo) throw new Error("cargo failed");
      if (missingOpenSslOnce && cargoCalls === 1) {
        throw Object.assign(new Error("cargo failed"), {
          stderr: "Could not find directory of OpenSSL installation",
        });
      }
      const manifest = args[args.indexOf("--manifest-path") + 1];
      const manifestText = await readFile(manifest, "utf8");
      const harness = path.join(path.dirname(manifest), "src", "bin", "__docs_openapi_export.rs");
      const source = await readFile(harness, "utf8");
      assert.match(source, /IntegratorApiDoc::openapi\(\)/u);
      if (cargoCalls > 1) {
        assert.match(manifestText, /package = "openssl"/u);
        assert.match(manifestText, /version = "=0\.10\.73"/u);
        assert.match(manifestText, /features = \["vendored"\]/u);
      }
      assert.equal(options.env.CARGO_TARGET_DIR, options.env.CARGO_TARGET_DIR);
      return { stdout: cargoStdout, stderr: "" };
    }
    if (file === "git" && args.includes("remove")) {
      removeCalls += 1;
      if (failWorktreeRemoveOnce && removeCalls === 1) {
        throw new Error("worktree remove failed");
      }
      await rm(args.at(-1), { recursive: true, force: true });
      return { stdout: "", stderr: "" };
    }
    if (file === "git" && args.includes("prune")) return { stdout: "", stderr: "" };
    throw new Error(`Unexpected command: ${file} ${args.join(" ")}`);
  };
}

test("exports IntegratorApiDoc from an exact detached commit and cleans the worktree", async (t) => {
  const paths = await fixture(t);
  const calls = [];
  const result = await exportIntegratorOpenApiAtCommit({
    ...paths,
    sourceCommit: SHA,
    execFileImpl: fakeExec({ calls }),
  });

  assert.deepEqual(result, SPEC);
  assert.deepEqual(await readdir(paths.workspaceDirectory), []);
  assert.deepEqual(calls[0].args, ["-C", paths.apiRepository, "cat-file", "-e", `${SHA}^{commit}`]);
  const cargo = calls.find(({ file }) => file === "cargo");
  assert.deepEqual(cargo.args.slice(0, 2), ["run", "--locked"]);
  assert.ok(cargo.args.includes("__docs_openapi_export"));
});

test("does not expose worker credentials to exact-commit Cargo execution", async (t) => {
  const paths = await fixture(t);
  const calls = [];
  const previousSecret = process.env.TEST_WORKER_SECRET;
  process.env.TEST_WORKER_SECRET = "must-not-reach-build-scripts";
  try {
    await exportIntegratorOpenApiAtCommit({
      ...paths,
      sourceCommit: SHA,
      execFileImpl: fakeExec({ calls }),
    });
  } finally {
    if (previousSecret === undefined) delete process.env.TEST_WORKER_SECRET;
    else process.env.TEST_WORKER_SECRET = previousSecret;
  }

  const cargo = calls.find(({ file }) => file === "cargo");
  assert.equal(cargo.options.env.TEST_WORKER_SECRET, undefined);
  assert.equal(cargo.options.env.CARGO_TARGET_DIR, paths.cargoTargetDirectory);
});

test("fetches a missing exact commit only from the allowlisted API origin", async (t) => {
  const paths = await fixture(t);
  const calls = [];
  const result = await exportIntegratorOpenApiAtCommit({
    ...paths,
    sourceCommit: SHA,
    execFileImpl: fakeExec({ missingCommitOnce: true, calls }),
  });

  assert.deepEqual(result, SPEC);
  const fetchCall = calls.find(({ file, args }) => file === "git" && args.includes("fetch"));
  assert.deepEqual(fetchCall.args, [
    "-C",
    paths.apiRepository,
    "fetch",
    "--no-tags",
    "--depth=1",
    "origin",
    SHA,
  ]);
});

test("rejects malformed commit identifiers before running commands", async (t) => {
  const paths = await fixture(t);
  let called = false;
  await assert.rejects(
    () =>
      exportIntegratorOpenApiAtCommit({
        ...paths,
        sourceCommit: "main",
        execFileImpl: async () => {
          called = true;
        },
      }),
    /40-character lowercase commit SHA/u,
  );
  assert.equal(called, false);
});

test("rejects malformed exporter output and removes the worktree", async (t) => {
  const paths = await fixture(t);
  const calls = [];
  await assert.rejects(
    () =>
      exportIntegratorOpenApiAtCommit({
        ...paths,
        sourceCommit: SHA,
        execFileImpl: fakeExec({ cargoStdout: "not json", calls }),
      }),
    /valid OpenAPI JSON/u,
  );
  assert.deepEqual(await readdir(paths.workspaceDirectory), []);
});

test("removes the worktree when Cargo fails", async (t) => {
  const paths = await fixture(t);
  const calls = [];
  await assert.rejects(
    () =>
      exportIntegratorOpenApiAtCommit({
        ...paths,
        sourceCommit: SHA,
        execFileImpl: fakeExec({ failCargo: true, calls }),
      }),
    /cargo failed/u,
  );
  assert.deepEqual(await readdir(paths.workspaceDirectory), []);
});

test("retries through a vendored OpenSSL harness when system headers are absent", async (t) => {
  const paths = await fixture(t);
  const calls = [];
  const result = await exportIntegratorOpenApiAtCommit({
    ...paths,
    sourceCommit: SHA,
    execFileImpl: fakeExec({ missingOpenSslOnce: true, calls }),
  });

  assert.deepEqual(result, SPEC);
  const cargoCalls = calls.filter(({ file }) => file === "cargo");
  assert.equal(cargoCalls.length, 2);
  assert.ok(cargoCalls[1].args.includes("--locked"));
  assert.ok(cargoCalls[1].args.includes("--manifest-path"));
  assert.deepEqual(await readdir(paths.workspaceDirectory), []);
});

test("prunes stale worktree metadata when normal removal fails", async (t) => {
  const paths = await fixture(t);
  const calls = [];
  const result = await exportIntegratorOpenApiAtCommit({
    ...paths,
    sourceCommit: SHA,
    execFileImpl: fakeExec({ failWorktreeRemoveOnce: true, calls }),
  });

  assert.deepEqual(result, SPEC);
  assert.ok(calls.some(({ file, args }) => file === "git" && args.includes("prune")));
  assert.deepEqual(await readdir(paths.workspaceDirectory), []);
});
