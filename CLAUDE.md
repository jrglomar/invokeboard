# CLAUDE.md — InvokeBoard

## What this repo is

A proof-of-concept monorepo that integrates GitHub Copilot (powered by Claude) into an Agile team's workflow via the Model Context Protocol (MCP). Two Node.js+TypeScript MCP servers (`mcp-jira`, `mcp-github`) expose tools for ticket creation, sprint reads, and PR linking — served over **stdio** to VS Code Copilot and over an **HTTP bridge** to a Vite+React dashboard. The React app (`react-app`) provides a sprint board, daily huddle digest, ticket generator, and a deterministic chat command panel. Phase 1 (Jira tools) and Phase 2 (GitHub tools + React dashboard) are fully built. Phase 3 (sprint reports) is planned.

---

## Commands

### Root (all packages)

```
npm install                   # install workspace dependencies
npm run typecheck             # tsc --noEmit across all packages
npm run build                 # build all packages
npm run test                  # vitest across all packages (no .env, no network required)
node scripts/smoke.mjs        # keyless smoke: boots both bridges with stub creds
```

### Start the three dev processes (each in its own terminal)

```
npm run dev:jira:http         # Jira HTTP bridge on :4001
npm run dev:github:http       # GitHub HTTP bridge on :4002
npm run dev:app               # Vite dev server on :5173
```

### Per-package (watch mode)

```
npm run dev:http -w packages/mcp-jira      # Jira bridge with watch
npm run dev:http -w packages/mcp-github    # GitHub bridge with watch
npm run typecheck -w packages/react-app    # type-check react-app only
npm run test -w packages/mcp-jira          # run mcp-jira tests only
```

### stdio MCP servers (VS Code manages these automatically)

```
npm run dev:jira              # stdio server for Copilot — do not start manually in normal use
npm run dev:github            # stdio server for Copilot — do not start manually in normal use
```

---

## Delivery workflow: commit → push → PR (every phase)

When a phase is delivered (all gates green) — or whenever the user asks — ship it to GitHub
(`origin` = https://github.com/jrglomar/invokeboard.git):

1. **Gates first, never commit red.** `npm run typecheck && npm run test && npm run build` +
   `node scripts/smoke.mjs` all green — judge by EXIT CODES / `grep "error TS"`, never by output tails
   (npm `--workspaces` keeps going past a failing package).
2. **Branch from `main`**: `phase/v<version>-<short-slug>` (e.g. `phase/v1.59-p4-trends-kpis`).
   Phase work is never committed directly to `main`. If the previous phase's PR is not yet merged
   and the new phase builds on it, branch from that phase's branch instead (stacked PR — set the
   PR base to the earlier branch and say so in the PR body; GitHub retargets to `main` when the
   base branch is deleted on merge).
3. **Commit only the phase's files.** Subject: `v<version>[-P<n>]: <what shipped> (ADR-<nnn>)`;
   body: surface changes, test-count delta, smoke count; end with the Co-Authored-By footer.
4. **Secrets check, then push.** `git status` must show no `.env` / `.invokeboard-*` files staged
   (they are git-ignored — if one ever appears, STOP and fix before pushing). `git push -u origin <branch>`.
5. **Open a PR** with `gh pr create` — title = commit subject; body = summary, test counts,
   ADR/contract refs, honest caveats (e.g. "not live-eyeballed"). Claude NEVER merges the PR —
   the user reviews and merges. gh lives at `C:\Program Files\GitHub CLI\gh.exe` (full path may be
   needed in shells started before the install). If gh is unauthenticated (`gh auth status`), push
   anyway and give the user the one-click compare URL
   `https://github.com/jrglomar/invokeboard/compare/main...<branch>?expand=1` plus a paste-ready
   title/body, and note that `gh auth login` (user-run, once) makes this automatic.
6. **Report the PR URL** in chat.

---

## Architecture in 5 lines

1. **3 packages** — `mcp-jira` (Jira tools), `mcp-github` (GitHub PR tools), `react-app` (dashboard); connected via npm workspaces.
2. **Dual transport** — each MCP package has `src/index.ts` (stdio, consumed by Copilot) and `src/http.ts` (Express HTTP bridge on :4001/:4002, consumed by react-app).
3. **Tool registry pattern** — `src/tools/index.ts` exports a `ToolDef[]` array; both transport adapters consume it; no business logic is duplicated.
4. **No LLM calls in servers** — all digest generation is deterministic; Claude is the *caller* of the tools, not a dependency of them (ADR-002).
5. **Contract-first** — `docs/CONTRACTS.md` defines all tool IO, HTTP routes, env vars, and error codes; it supersedes the spec on implementation details.

---

## THE RULE: contract before surface

`docs/CONTRACTS.md` is authoritative. If you need to change a tool name, field name, port, error code, or env variable:
1. Update `docs/CONTRACTS.md` first.
2. Then update the implementation.

Do not change implementation surface area without updating the contract. Builders implement exactly what the contract says.

**AI calls live ONLY in `packages/mcp-jira/src/lib/ai/` (v1.1, ADR-006 amends ADR-002).**
The Jira bridge exposes `POST /api/ai/draft-tickets` and `POST /api/ai/enhance-ticket` —
bridge-only REST endpoints, NEVER registered as MCP tools (would be circular for Copilot).
Two providers behind the `AiProvider` port: `anthropic` (official `@anthropic-ai/sdk`,
`messages.parse` + `zodOutputFormat`; AI schemas import from the `zod/v4` subpath, all
other code stays on `"zod"` v3) and `github` (GitHub Models REST via fetch). `AI_PROVIDER`
unset = disabled = 503 `AI_UNAVAILABLE`, and the React app falls back to deterministic
templates. The chat panel's command ROUTER stays deterministic (ADR-002); only draft
content generation is AI-powered when enabled.

**Tests must pass keyless and offline.** `npm run test` across all packages must succeed
with no `.env` file and no network — and ALSO with a developer `.env` present: both
servers' `config.ts` skip dotenv loading when `VITEST=true`, so tests own `process.env`.
Axios, the Anthropic SDK, and global fetch are mocked with `vi.mock`/`vi.stubGlobal`.
Do not add tests that require real credentials or network calls.

---

## Where things live

| What | Where |
|---|---|
| Tool implementations | `packages/<pkg>/src/tools/` — one file per tool |
| Tool registry | `packages/<pkg>/src/tools/index.ts` — exports `tools: ToolDef[]` |
| stdio MCP entry (Copilot) | `packages/<pkg>/src/index.ts` |
| HTTP bridge entry (react-app) | `packages/<pkg>/src/http.ts` |
| Jira REST client / auth | `packages/mcp-jira/src/lib/jiraClient.ts` |
| GitHub REST client / auth | `packages/mcp-github/src/lib/githubClient.ts` |
| ADF helpers (textToAdf / adfToText) | `packages/mcp-jira/src/lib/adf.ts` |
| MCP prompt templates (draft_tickets, enhance_ticket, daily_huddle) | `packages/mcp-jira/src/lib/prompts.ts` |
| Config validation (zod, getConfig / resetConfigCache) | `packages/<pkg>/src/lib/config.ts` |
| Shared domain types (TicketRef, IssueSummary, HuddleItem) | `packages/mcp-jira/src/lib/types.ts` |
| Jira key regex detection (pure function) | `packages/mcp-github/src/lib/jiraKeys.ts` |
| AI provider port + adapters (anthropic/github) | `packages/mcp-jira/src/lib/ai/` |
| Active-sprint selection (latest-first, pure) | `packages/mcp-jira/src/lib/sprintSelect.ts` |
| PO draft capacity plan store | `packages/mcp-jira/src/lib/draftPlanStore.ts` |
| Draft Capacity Plan card + PO↔Dev sprint pairing | `packages/react-app/src/components/DraftPlanCard.tsx`, `src/lib/sprintPairing.ts` |
| Linking page modes (create-dev / link-existing / new-po) + shared Dev picker | `packages/react-app/src/components/linking/` |
| Sequential bulk-write machine + status log (Linking modes) | `packages/react-app/src/hooks/useBulkRun.ts`, `src/components/BulkStatusLog.tsx` |
| PO↔Dev link/unlink tools (existing issues) | `packages/mcp-jira/src/tools/linkDevToPo.ts`, `unlinkDevFromPo.ts` |
| Shared per-ticket action cells (points/status/move/rename) — Assign Tickets only | `packages/react-app/src/components/ticketCells.tsx` |
| Real breakdown dialog (creates PO sub-stories) — Assign Tickets | `packages/react-app/src/components/BreakdownDialog.tsx` |
| Draft point-split rollups (per-developer share totals) | `packages/react-app/src/lib/draftPlan.ts` |
| React AI client (`getAiStatus`, draft, enhance) | `packages/react-app/src/lib/aiClient.ts` |
| React HTTP client | `packages/react-app/src/lib/mcpClient.ts` |
| Chat command router (pure function) | `packages/react-app/src/lib/chatRouter.ts` |
| MCP tool catalog (Guide reference data) | `packages/react-app/src/lib/toolCatalog.ts` |
| Ticket draft builder (deterministic, no network) | `packages/react-app/src/lib/ticketTemplates.ts` |
| Architectural Decision Records | `docs/adr/ADR-001.md` through `ADR-081.md` |
| Integration contract | `docs/CONTRACTS.md` |
| Setup guide | `docs/SETUP.md` |
