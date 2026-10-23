# Documentation review captures

Run the real Mintlify preview for the base and content branches. Supply a routes JSON array, for example:

```json
[
  { "name": "guide", "route": "/api-reference/getting-started", "maxHeight": 1100 },
  { "name": "section", "route": "/api-reference/getting-started", "selector": "#authentication", "maxHeight": 800 }
]
```

Then run the same subjects against each preview (choose the output directory explicitly):

```sh
node scripts/captures/docs.mjs --url http://localhost:3000 \
  --routes routes.json --output images/pr/review --phase before \
  --source-sha "$BASE_SHA" --browser "$CHROMIUM_PATH"
```

Use `after` and the content commit SHA for the second preview. `CAPTURES_URL`, `CHROMIUM_PATH`, and `CAPTURES_BROWSER_PATH` are supported fallbacks. Browser paths must identify an executable file. No browser is downloaded. Sandbox stays enabled by default; `--no-sandbox` is an explicit opt-out only for an isolated container that cannot run Chromium's sandbox. Proxy configuration is inherited without embedding credentials in manifests.

The script captures the actual article/fonts/styles at desktop width in light mode, crops by document coordinates, and writes WebPs plus source/route/style/browser-error manifests. This narrowed matrix is appropriate for editorial-only documentation, not responsive or theme changes. Inspect every image at PR display size and compare browser errors. Use different landmark selectors only when a section is new and the baseline must show its insertion context; record this in the PR.

Commit images on the content branch, pin the PR URLs to that image commit, then make a **final cleanup commit removing review-only images/manifests from head before merge**. The ancestor remains the review evidence. Do not delete unrelated base assets. Keep this script and Playwright dependency in the tooling PR, not in API content deliveries.

Content regression checks can run against another worktree without installing tooling in it:

```sh
DOCS_ROOT=/path/to/content-worktree node --test tests/release-content.test.mjs
```

These checks select explicitly named JSON fences, validate the transaction migration and APY/history examples, preserve EN/FR end-user scope and check public endpoint navigation/redirects. Contract-specific checks skip when the older baseline has no transaction-summary schema; always run them explicitly against the delivery as well. `npm test` runs the full tooling suite. No production refetch is needed.
