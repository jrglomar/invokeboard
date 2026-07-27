# @invokeboard/mcp-jira

> Jira MCP server — exposes ticket and sprint tools to GitHub Copilot (Claude) via MCP stdio, and to the React dashboard via an HTTP bridge on port 4001.

## Tools

| Tool | Input | Purpose |
|---|---|---|
| `create_po_ticket` | `summary`, `description`, `storyPoints?` | Create a PO story on the PO board |
| `create_dev_ticket` | `summary`, `description`, `linkedPoTicketKey?` | Create a Dev task and link to a PO story |
| `get_active_sprint` | `boardId?`, `maxResults?` | Fetch the active sprint with issues by status and totals |
| `get_ticket` | `ticketKey` | Read full ticket fields |
| `update_ticket` | `ticketKey`, `summary?`, `description?` | Rewrite a ticket description or summary |
| `get_daily_huddle` | `boardId?` | Generate a deterministic standup digest (no LLM call) |
| `link_dev_to_po` | `poKey`, `devKey` | Link an EXISTING Dev ticket to an EXISTING PO story (PO depends on Dev) |
| `unlink_dev_from_po` | `linkId`, `poKey?`, `devKey?` | Remove a PO ↔ Dev issue link by its link id |

A representative selection — see `docs/CONTRACTS.md` §4 for the full registry (47 tools) and
exact input/output types.

## Scripts

| Script | Description |
|---|---|
| `npm run dev` | Start the stdio MCP server (consumed by VS Code Copilot) |
| `npm run dev:http` | Start the HTTP bridge on port 4001 with watch mode (consumed by react-app) |
| `npm run typecheck` | TypeScript type-check (no emit) |
| `npm run build` | Alias for typecheck |
| `npm run test` | Run vitest test suite (no .env or network required) |

Run from the monorepo root with `-w packages/mcp-jira`, e.g.:

```
npm run dev:http -w packages/mcp-jira
```

## Environment variables

All variables are loaded from `packages/mcp-jira/.env` (package wins) then the repo-root `.env` (fills gaps). Copy `.env.example` in this directory to `.env` for package-local overrides. Full key-acquisition instructions are in [docs/SETUP.md](../../docs/SETUP.md).

| Variable | Required | Default | Description |
|---|---|---|---|
| `JIRA_BASE_URL` | yes | — | Base URL of your Jira instance, e.g. `https://yourco.atlassian.net` |
| `JIRA_EMAIL` | yes | — | Email for HTTP Basic auth |
| `JIRA_API_TOKEN` | yes | — | API token for HTTP Basic auth (never committed) |
| `JIRA_PO_BOARD_ID` | yes | — | Jira board ID for the PO board |
| `JIRA_DEV_BOARD_ID` | yes | — | Jira board ID for the Dev board |
| `JIRA_PO_PROJECT_KEY` | optional | `PO` | Project key for PO stories |
| `JIRA_DEV_PROJECT_KEY` | optional | `DEV` | Project key for Dev tasks |
| `JIRA_STORY_POINTS_FIELD` | optional | `customfield_10016` | Custom field ID for story points |
| `JIRA_LINK_TYPE` | optional | `Depends on` | Issue link type name; PO story "depends on" its Dev task(s) (ADR-046). Must match a link type in your Jira. |
| `JIRA_FLAGGED_FIELD` | optional | `""` (disabled) | Custom field ID for flagged/impediment detection |
| `MCP_JIRA_HTTP_PORT` | optional | `4001` | Port for the HTTP bridge |

## Architecture notes

- `src/index.ts` — stdio MCP entry; consumed by VS Code Copilot via `@modelcontextprotocol/sdk`.
- `src/http.ts` — Express HTTP bridge; consumed by `packages/react-app` at `:4001`.
- `src/tools/` — transport-agnostic tool registry (`ToolDef[]`); both entries consume it.
- `src/lib/jiraClient.ts` — anti-corruption layer for Jira REST API v3 and Agile API 1.0.
- `src/lib/adf.ts` — ADF (Atlassian Document Format) helpers; no external deps.
- `src/lib/prompts.ts` — MCP prompt templates registered via `server.registerPrompt()` (stdio entry only).

See [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) and [docs/CONTRACTS.md](../../docs/CONTRACTS.md) for the full design.
