# Byzantine documentation

This repository contains Byzantine's Mintlify documentation and deterministic tooling for reviewing API contract changes.

## Local preview

Install the [Mintlify CLI](https://www.npmjs.com/package/mint):

```bash
npm i -g mint
```

Run the documentation site from the repository root:

```bash
mint dev
```

The local preview is available at `http://localhost:3000`.

If the preview fails, run `mint update` and try again. A 404 usually means the page is missing from `docs.json` or its path is incorrect.

## Validation

Before opening a documentation pull request, run:

```bash
mint broken-links
npm test
```

`mint broken-links` checks documentation navigation and links. `npm test` checks the deterministic OpenAPI comparison and delivery-policy tooling.

## OpenAPI tooling

The repository includes commands to:

- resolve a recent production deployment and reproduce its OpenAPI from the exact API commit;
- validate and synchronize `api-reference/openapi-integrator.json` without reordering source keys;
- generate a semantic OpenAPI diff;
- detect affected endpoints and shared schemas;
- verify per-repository release watermarks;
- serialize one release event into coordinated docs and Integrator SDK pull requests;
- feed the same captured production-response bytes and SHA-256 into the docs watermark, both PR markers, and the SDK generator, avoiding any reserialization or second mutable production fetch;
- keep the raw production artifact byte-identical even when it is minified onto one line; GitHub's file diff may therefore be unreadable, so every PR must carry the generated semantic change table and documentation-impact review;
- encode the companion SDK outcome as its Integrator SDK PR URL, `none` after verified no-op generation, or `blocked` for a delivery that cannot proceed;
- enforce bounded retries, renewable leases, and pull-request consolidation policy.

Run `npm run` to list the available commands.

## Publishing

Changes merged into the default branch are published through the configured Mintlify GitHub integration. API documentation updates are always delivered through a reviewable pull request; the automation does not merge its own changes.

## Resources

- [Mintlify documentation](https://mintlify.com/docs)
