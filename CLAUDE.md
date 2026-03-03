# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Byzantine Finance documentation site built with **Mintlify**. Bilingual (English + French). Configuration lives in `docs.json`.

## Development commands

```bash
# Start dev server (requires Node.js >= 19)
mint dev

# Custom port
mint dev --port 3333

# Validate broken links
mint broken-links

# Update Mintlify CLI
npm mint update
```

Install CLI globally if needed: `npm i -g mint`

## Architecture

- **docs.json** — Main config: navigation, theming, API settings, bilingual routing
- **api-reference/** — API documentation pages (MDX) + OpenAPI spec
  - **openapi-integrator.json** — OpenAPI 3.0.3 spec for Byzantine Integrator API
  - **endpoints/** — Individual endpoint pages referencing OpenAPI operations via `openapi` frontmatter
  - **lists/** — Reference data (countries, occupation codes, industry codes, company number types) as JSON + MDX
- **documentation/** — Academy/educational content
- **faq/** — FAQ sections organized by topic
- **fr/** — French translations (mirrors English structure)
- **images/**, **logo/** — Static assets

## Key conventions

### Page format
All pages are MDX with YAML frontmatter:
```yaml
---
title: "Page title"
description: "Page description"
---
```

### API endpoint pages
Endpoint pages in `api-reference/endpoints/` use the `openapi` frontmatter to auto-generate from the spec:
```yaml
---
title: "Human-readable title"
openapi: "POST /v1/submit/create-user"
---
```

### Navigation structure
The `docs.json` navigation uses nested groups. The "API endpoints" section manually references endpoint MDX files (no auto-generation from tags). The "Integrator API" section contains guide pages.

### Mintlify components
Use `<Info>`, `<Warning>`, `<Tip>`, `<Note>`, `<Check>` for callouts. Use `<Steps>`, `<Tabs>`, `<CodeGroup>`, `<Accordion>`, `<Card>`, `<Frame>` for structure. See `ai-tools/cursor.mdx` for full component reference.

### Writing style
- Second person ("you"), active voice, present tense
- **Sentence case everywhere** — only capitalize the first word and proper nouns (e.g., "Account management" not "Account Management", "Get user details" not "Get User Details")
- Step numbering for multi-step flows (e.g., "Step 1 - Get payload", "Step 2 - Sign payload")
- Use "Pre-step:" prefix for prerequisites

### Git commits
Use [Conventional Commits](https://www.conventionalcommits.org/) format:
- `feat:` — new feature or page
- `fix:` — bug fix or correction
- `docs:` — documentation content changes
- `refactor:` — restructuring without changing behavior
- `style:` — formatting, typos, wording
- `chore:` — maintenance, config changes

Examples: `feat: add OTP authentication endpoints`, `fix: correct typo in deposit page`, `refactor: restructure API endpoints navigation`

### Deployment
Pushes to the default branch on GitHub auto-deploy to production via Mintlify integration. No CI/CD config in repo.
