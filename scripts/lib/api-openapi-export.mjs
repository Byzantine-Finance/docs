import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

const execFileAsync = promisify(execFile);
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;
const EXPORT_TIMEOUT_MS = 30 * 60 * 1_000;
const HARNESS_NAME = "__docs_openapi_export";
const OPENSSL_HEADER_ERROR = /Could not find directory of OpenSSL installation|development packages of openssl/iu;
const API_REMOTE_URLS = new Set([
  "https://github.com/Byzantine-Finance/byzantine-api.git",
  "git@github.com:Byzantine-Finance/byzantine-api.git",
]);
const VENDORED_OPENSSL_SRC = {
  version: "300.6.1+3.6.3",
  source: "registry+https://github.com/rust-lang/crates.io-index",
  checksum: "46eb8fb9fb3b61ce1c0f8a026c4c1a0714d3a9e138e7fbde78753ce2babc3846",
};
const HARNESS_SOURCE = `use std::io::{self, Write};
use utoipa::OpenApi;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let document = byzantine_api::doc::IntegratorApiDoc::openapi();
    let stdout = io::stdout();
    let mut output = stdout.lock();
    serde_json::to_writer_pretty(&mut output, &document)?;
    output.write_all(b"\\n")?;
    Ok(())
}
`;

function validateAbsoluteDirectory(value, name) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path`);
  }
  return path.resolve(value);
}

function parseOpenApi(raw) {
  let document;
  try {
    document = JSON.parse(raw);
  } catch {
    throw new Error("Exact-commit exporter did not return valid OpenAPI JSON");
  }
  if (
    !document ||
    typeof document !== "object" ||
    !/^3\.(?:0|1)\.\d+$/u.test(document.openapi ?? "") ||
    !document.info ||
    typeof document.info !== "object" ||
    typeof document.info.title !== "string" ||
    typeof document.info.version !== "string" ||
    !document.paths ||
    typeof document.paths !== "object" ||
    Array.isArray(document.paths)
  ) {
    throw new Error("Exact-commit exporter did not return valid OpenAPI JSON");
  }
  return document;
}

function cargoEnvironment(cargoTarget) {
  const allowedNames = new Set([
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "TEMP",
    "TMP",
    "CARGO_HOME",
    "RUSTUP_HOME",
    "RUSTC",
    "RUSTDOC",
    "RUSTFLAGS",
    "CARGO_BUILD_JOBS",
    "CARGO_NET_OFFLINE",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "OPENSSL_DIR",
    "OPENSSL_INCLUDE_DIR",
    "OPENSSL_LIB_DIR",
    "OPENSSL_NO_VENDOR",
    "PKG_CONFIG_PATH",
    "PKG_CONFIG_LIBDIR",
    "PKG_CONFIG_SYSROOT_DIR",
    "PQ_LIB_DIR",
    "LIBRARY_PATH",
    "LD_LIBRARY_PATH",
    "CC",
    "CXX",
    "AR",
    "CFLAGS",
    "CXXFLAGS",
    "LDFLAGS",
  ]);
  const environment = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      (allowedNames.has(name) || /^CARGO_PROFILE_[A-Z0-9_]+$/u.test(name))
    ) {
      environment[name] = value;
    }
  }
  environment.CARGO_TARGET_DIR = cargoTarget;
  return environment;
}

async function runCargoExporter({ manifestPath, cwd, cargoTarget, locked, execFileImpl }) {
  const args = ["run"];
  if (locked) args.push("--locked");
  args.push("--quiet", "--manifest-path", manifestPath);
  if (locked) args.push("--bin", HARNESS_NAME);
  return execFileImpl("cargo", args, {
    cwd,
    env: cargoEnvironment(cargoTarget),
    encoding: "utf8",
    timeout: EXPORT_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
}

function addLockedDependency(lock, packageName, packageVersion, dependencyName) {
  const marker = `[[package]]\nname = "${packageName}"\nversion = "${packageVersion}"`;
  const packageStart = lock.indexOf(marker);
  if (packageStart < 0) {
    throw new Error(`Exact-commit Cargo.lock does not contain ${packageName} ${packageVersion}`);
  }
  const packageEndCandidate = lock.indexOf("\n[[package]]", packageStart + marker.length);
  const packageEnd = packageEndCandidate < 0 ? lock.length : packageEndCandidate;
  const dependenciesHeader = "dependencies = [\n";
  const dependenciesHeaderStart = lock.indexOf(dependenciesHeader, packageStart);
  if (dependenciesHeaderStart < 0 || dependenciesHeaderStart >= packageEnd) {
    throw new Error(`Exact-commit Cargo.lock ${packageName} dependencies are malformed`);
  }
  const dependenciesStart = dependenciesHeaderStart + dependenciesHeader.length;
  const dependenciesEnd = lock.indexOf("]", dependenciesStart);
  if (dependenciesEnd < 0 || dependenciesEnd >= packageEnd) {
    throw new Error(`Exact-commit Cargo.lock ${packageName} dependencies are malformed`);
  }
  const dependencyLines = lock
    .slice(dependenciesStart, dependenciesEnd)
    .split("\n")
    .filter((line) => line.length > 0);
  const dependencyLine = ` "${dependencyName}",`;
  if (!dependencyLines.includes(dependencyLine)) {
    dependencyLines.push(dependencyLine);
    dependencyLines.sort();
    return `${lock.slice(0, dependenciesStart)}${dependencyLines.join("\n")}\n${lock.slice(dependenciesEnd)}`;
  }
  return lock;
}

export async function enableLockedVendoredOpenSsl(apiWorktree) {
  const lockPath = path.join(apiWorktree, "Cargo.lock");
  const manifestPath = path.join(apiWorktree, "Cargo.toml");
  let lock = await readFile(lockPath, "utf8");
  const opensslVersion = lock.match(
    /\[\[package\]\]\s+name = "openssl"\s+version = "([0-9]+\.[0-9]+\.[0-9]+)"/u,
  )?.[1];
  const opensslSysVersion = lock.match(
    /\[\[package\]\]\s+name = "openssl-sys"\s+version = "([0-9]+\.[0-9]+\.[0-9]+)"/u,
  )?.[1];
  if (!opensslVersion || !opensslSysVersion) {
    throw new Error("Exact-commit Cargo.lock does not pin the OpenSSL crates");
  }
  const manifest = await readFile(manifestPath, "utf8");
  const packageName = manifest.match(/\[package\][\s\S]*?\nname\s*=\s*"([^"]+)"/u)?.[1];
  const packageVersion = manifest.match(/\[package\][\s\S]*?\nversion\s*=\s*"([^"]+)"/u)?.[1];
  if (!packageName || !packageVersion) {
    throw new Error("Exact-commit Cargo.toml has invalid package metadata");
  }
  const vendoredDependencies = `

[dependencies.__docs_openapi_export_openssl]
package = "openssl"
version = "=${opensslVersion}"
features = ["vendored"]

[dependencies.__docs_openapi_export_openssl_src]
package = "openssl-src"
version = "=${VENDORED_OPENSSL_SRC.version}"
`;
  await writeFile(manifestPath, `${manifest.trimEnd()}${vendoredDependencies}`, "utf8");

  lock = addLockedDependency(lock, packageName, packageVersion, "openssl");
  lock = addLockedDependency(lock, packageName, packageVersion, "openssl-src");
  lock = addLockedDependency(lock, "openssl-sys", opensslSysVersion, "openssl-src");

  const opensslSrcMarker = '[[package]]\nname = "openssl-src"';
  if (!lock.includes(opensslSrcMarker)) {
    const opensslSysMarker = '[[package]]\nname = "openssl-sys"';
    const insertionPoint = lock.indexOf(opensslSysMarker);
    if (insertionPoint < 0) {
      throw new Error("Exact-commit Cargo.lock does not contain openssl-sys");
    }
    const opensslSrcPackage = `[[package]]
name = "openssl-src"
version = "${VENDORED_OPENSSL_SRC.version}"
source = "${VENDORED_OPENSSL_SRC.source}"
checksum = "${VENDORED_OPENSSL_SRC.checksum}"
dependencies = [
 "cc",
]

`;
    lock = `${lock.slice(0, insertionPoint)}${opensslSrcPackage}${lock.slice(insertionPoint)}`;
  }
  await writeFile(lockPath, lock, "utf8");
  return manifestPath;
}

async function ensureCommitAvailable({ repository, sourceCommit, execFileImpl }) {
  const catFileArguments = ["-C", repository, "cat-file", "-e", `${sourceCommit}^{commit}`];
  try {
    await execFileImpl("git", catFileArguments, {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return;
  } catch {
    const { stdout } = await execFileImpl(
      "git",
      ["-C", repository, "remote", "get-url", "origin"],
      { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 },
    );
    const remote = stdout.trim();
    if (!API_REMOTE_URLS.has(remote)) {
      throw new Error("API repository origin is not the allowlisted GitHub repository");
    }
    await execFileImpl(
      "git",
      ["-C", repository, "fetch", "--no-tags", "--depth=1", "origin", sourceCommit],
      { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 },
    );
    await execFileImpl("git", catFileArguments, {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
  }
}

export async function exportIntegratorOpenApiAtCommit({
  apiRepository,
  sourceCommit,
  workspaceDirectory,
  cargoTargetDirectory,
  execFileImpl = execFileAsync,
}) {
  if (!SHA_PATTERN.test(sourceCommit ?? "")) {
    throw new Error("sourceCommit must be a 40-character lowercase commit SHA");
  }
  const repository = validateAbsoluteDirectory(apiRepository, "apiRepository");
  const workspace = validateAbsoluteDirectory(workspaceDirectory, "workspaceDirectory");
  const cargoTarget = validateAbsoluteDirectory(cargoTargetDirectory, "cargoTargetDirectory");
  await mkdir(workspace, { recursive: true });
  await mkdir(cargoTarget, { recursive: true });

  await ensureCommitAvailable({ repository, sourceCommit, execFileImpl });

  const worktree = path.join(workspace, `api-openapi-${randomUUID()}`);
  let worktreeCreated = false;
  try {
    await execFileImpl(
      "git",
      ["-C", repository, "worktree", "add", "--detach", worktree, sourceCommit],
      { timeout: 60_000, maxBuffer: 2 * 1024 * 1024 },
    );
    worktreeCreated = true;

    const binaryDirectory = path.join(worktree, "src", "bin");
    const harnessPath = path.join(binaryDirectory, `${HARNESS_NAME}.rs`);
    await mkdir(binaryDirectory, { recursive: true });
    await writeFile(harnessPath, HARNESS_SOURCE, { encoding: "utf8", flag: "wx" });

    let result;
    try {
      result = await runCargoExporter({
        manifestPath: path.join(worktree, "Cargo.toml"),
        cwd: worktree,
        cargoTarget,
        locked: true,
        execFileImpl,
      });
    } catch (error) {
      const diagnostic = `${error?.message ?? ""}\n${error?.stderr ?? ""}`;
      if (!OPENSSL_HEADER_ERROR.test(diagnostic)) throw error;
      const manifestPath = await enableLockedVendoredOpenSsl(worktree);
      result = await runCargoExporter({
        manifestPath,
        cwd: worktree,
        cargoTarget,
        locked: true,
        execFileImpl,
      });
    }
    return parseOpenApi(result.stdout);
  } finally {
    if (worktreeCreated) {
      try {
        await execFileImpl(
          "git",
          ["-C", repository, "worktree", "remove", "--force", worktree],
          { timeout: 60_000, maxBuffer: 2 * 1024 * 1024 },
        );
      } catch {
        await rm(worktree, { recursive: true, force: true });
        await execFileImpl("git", ["-C", repository, "worktree", "prune"], {
          timeout: 60_000,
          maxBuffer: 2 * 1024 * 1024,
        });
      }
    } else {
      await rm(worktree, { recursive: true, force: true });
    }
  }
}
