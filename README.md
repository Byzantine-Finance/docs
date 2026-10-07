# Byzantine API documentation automation

This repository contains the deterministic part of the API documentation workflow. A merge on `Byzantine-Finance/byzantine-api` wakes the Hermes worker; the worker runs these checks before it edits prose or opens a pull request.

## Commands

```bash
npm test
npm run openapi:sync -- --source <file-or-url> --target api-reference/openapi-integrator.json
npm run openapi:diff -- \
  --before <previous-openapi.json> \
  --after <current-openapi.json> \
  --json-out <report.json> \
  --markdown-out <report.md>
npm run openapi:resolve-deployed -- --output <scratch-openapi.json>
npm run delivery:queue -- acquire \
  --database /opt/data/state/byzantine-docs/queue.sqlite \
  --owner <worker-id>
```

`openapi:sync` validates the source, rejects redirects, bounds network requests and response bodies, retries transient failures, canonicalizes object key order, preserves the target file's indentation and newline convention, writes atomically, and does nothing when the semantic document is unchanged. If bearer authentication is required, set `OPENAPI_ALLOWED_ORIGINS` to a comma-separated list of exact HTTPS origins; credentials are never sent to an event-supplied host by default.

`openapi:diff` reports:

- added, removed, and directly changed operations;
- changed component schemas;
- operations indirectly affected through shared schemas;
- unresolved references and changes that require human escalation;
- a compact Markdown summary suitable for the pull-request body.

## Event flow

```text
Scheduled deployment reconciliation
  -> latest successful byzantine-api/main production deployment
  -> stable double-fetch of the fixed production OpenAPI URL
  -> durable SQLite queue, delivery deduplication, repository lease
  -> deterministic OpenAPI sync and semantic diff
  -> documentation impact scan across every locale in docs.json
  -> update an eligible open PR or create a new one
  -> tests, secret scan, independent review, then push
```

The scheduled job is sufficient for production operation; no public ingress is required. An optional webhook can reduce latency, but its payload is only a wake-up hint. The filter bounds and validates the JSON object, accepts `Byzantine-Finance/byzantine-api` on `refs/heads/main`, validates the commit identifiers, removes untrusted commit text, derives a deterministic delivery ID, and persists the event before an agent run starts. Duplicate events do not wake the agent. `scripts/lib/delivery-queue.mjs` uses SQLite WAL, unique delivery IDs, forced-push preservation, owner-guarded renewable leases, retries, and terminal failure records.

`scripts/resolve-deployed-openapi.mjs` is the source preflight. It exhaustively paginates the fixed workflow history, rejects every still-running production-capable workflow, validates timestamps, rejects tied latest completion times, orders completed runs by completion update rather than creation time, requires the last completed run to be a successful `main` push whose SHA still equals current `main`, and rejects a later failed or manual run. It then fetches the fixed production OpenAPI endpoint twice without forwarding GitHub credentials, requires identical hashes, and requires three matching snapshots of `main` plus every production-capable run, including run attempt and status, before accepting the snapshot. These invariants close the mutable-branch checkout, hidden or rerun older workflow, and out-of-order completion races in the existing deployment workflow without changing the API repository. `scripts/reconcile-delivery.mjs` then verifies the watermark artifact hash and queues the complete undocumented deployed range once.

## Pull-request consolidation

`scripts/lib/pr-policy.mjs` implements the agreed policy:

- create a PR when no automation PR is open;
- update the same PR for a small compatible merge during its first 24 hours;
- update the same PR for a clearly related corrective merge, including after that window;
- escalate before combining breaking, broad, or semantically unrelated work;
- queue unrelated work after the 24-hour window until the older PR is resolved.

Automation PRs carry a machine-readable HTML marker containing the documented source range, window start, generator version, and included commits. The merged docs branch carries `.github/byzantine-docs-watermark.json`, including the exact source commit and OpenAPI SHA-256. These records prevent title-based guessing and support idempotent retries.

## Anti-hallucination rule

Deterministic evidence from the deployed OpenAPI snapshot, API implementation at the associated deployment SHA, tests, or existing product documentation must support every substantive statement. If those sources conflict or do not establish the product meaning, the worker pauses the affected edits and sends Benoît a Slack DM containing:

- the source commits and affected endpoints or schemas;
- facts already verified;
- the exact uncertainty;
- potentially affected documentation or SDK files;
- one concrete question.

The worker never merges its own PR.

## Runtime setup

Hermes has a scheduled reconciliation job and an optional local subscription named `byzantine-api-docs`, with Slack delivery to the existing `benoit-brain` DM. The route script is installed at `/opt/data/scripts/byzantine-api-push.py` on the worker host, but production correctness does not depend on a public webhook.

Production activation still requires:

1. merge of this automation PR;
2. an initial validated `.github/byzantine-docs-watermark.json` on docs main;
3. activation of the existing 15-minute reconciliation job.

Do not pass a GitHub token to an OpenAPI host. Both the GitHub workflow endpoint and production OpenAPI source are fixed in code; any ambiguous deployment state fails closed.
