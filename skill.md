---
name: byzantine
description: Use when integrating Byzantine Finance, the non-custodial yield API for EUR and USD balances: account onboarding (KYC/KYB), request signing, passkey-approved deposits and withdrawals, balances and yield, webhooks.
license: Apache-2.0
---

# Byzantine Finance

Byzantine lets a platform offer yield on EUR and USD balances to its users through an API. It is non-custodial: every deposit and withdrawal must be approved by the end user's passkey, so no server or agent can move funds on its own.

## Install the full integration skills

This page is a short entry point. The complete, API-checked skills (onboarding, signing, money movement, webhooks, reporting) are maintained here:

```bash
npx skills add Byzantine-Finance/agent-skills
```

## Where to look

- Integration map, flows and build order: https://docs.byzantine.fi/api-reference/integration-guide
- API contract (the source of truth): https://api.byzantine.fi/api-docs/openapi-integrator.json
- Sandbox (build here first): https://sandbox.api.byzantine.fi, see https://docs.byzantine.fi/api-reference/sandbox
- Any docs page as markdown: append `.md` to its URL; index at https://docs.byzantine.fi/llms.txt
- Docs search over MCP: https://docs.byzantine.fi/mcp

## Rules

- Never guess endpoints, fields or enum values: read them from the OpenAPI spec.
- Use the sandbox, never production, while building. Never ask for or paste private keys in the conversation.
- Do not promise automatic or scheduled deposits or withdrawals: they need the user's passkey each time.
