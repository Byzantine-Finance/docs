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
GitHub push on byzantine-api/main
  -> public HTTPS webhook
  -> Hermes HMAC verification
  -> scripts/hermes/byzantine-api-push.py
  -> durable SQLite queue, delivery deduplication, repository lease
  -> deterministic OpenAPI export, sync, and semantic diff
  -> documentation impact scan across every locale in docs.json
  -> update an eligible open PR or create a new one
  -> tests, secret scan, independent review, then push
```

The webhook payload is only a wake-up signal. The filter bounds and validates the JSON object, accepts `Byzantine-Finance/byzantine-api` on `refs/heads/main`, validates the commit identifiers, removes untrusted commit text, derives a deterministic delivery ID, and persists the event before an agent run starts. Duplicate events do not wake the agent. `scripts/lib/delivery-queue.mjs` uses SQLite WAL, unique delivery IDs, forced-push preservation, owner-guarded renewable leases, retries, and terminal failure records. The worker must re-read the current GitHub default branch instead of trusting payload descriptions.

`scripts/reconcile-delivery.mjs` is the polling safety net. It first verifies that the watermark's SHA-256 matches the committed OpenAPI artifact, then compares the merged documentation watermark with the current API main SHA and queues the complete undocumented range once. It does not replace the webhook.

## Pull-request consolidation

`scripts/lib/pr-policy.mjs` implements the agreed policy:

- create a PR when no automation PR is open;
- update the same PR for a small compatible merge during its first 24 hours;
- update the same PR for a clearly related corrective merge, including after that window;
- escalate before combining breaking, broad, or semantically unrelated work;
- queue unrelated work after the 24-hour window until the older PR is resolved.

Automation PRs carry a machine-readable HTML marker containing the documented source range, window start, generator version, and included commits. The merged docs branch carries `.github/byzantine-docs-watermark.json`, including the exact source commit and OpenAPI SHA-256. These records prevent title-based guessing and support idempotent retries.

## Anti-hallucination rule

Deterministic evidence from the API implementation, exact OpenAPI export, tests, or existing product documentation must support every substantive statement. If those sources conflict or do not establish the product meaning, the worker pauses the affected edits and sends Benoît a Slack DM containing:

- the source commits and affected endpoints or schemas;
- facts already verified;
- the exact uncertainty;
- potentially affected documentation or SDK files;
- one concrete question.

The worker never merges its own PR.

## Runtime setup

Hermes has a local subscription named `byzantine-api-docs` on port `8644`, with Slack delivery to the existing `benoit-brain` DM. The route script is installed at `/opt/data/scripts/byzantine-api-push.py` on the worker host.

Production activation still requires:

1. a stable public HTTPS endpoint for port `8644`;
2. the GitHub App webhook URL and matching HMAC secret;
3. push-event delivery for `Byzantine-Finance/byzantine-api`;
4. merge of the API helper that exposes `cargo run --bin export_integrator_openapi` at an exact commit;
5. an initial validated `.github/byzantine-docs-watermark.json` on docs main.

Do not pass a GitHub write token to a URL supplied by a webhook payload. The OpenAPI source must be fixed or exported from an exact checked-out API commit.
