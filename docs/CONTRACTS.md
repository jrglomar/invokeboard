# Integration Contracts

**Status: FINAL — AUTHORITATIVE (v1.44)**  
Builder agents implement exactly what this document says. If something here is
ambiguous, file a note to the Architect agent; do NOT invent new surface area or
prefer the spec over this document — this document supersedes the spec on all
implementation details.

> **v1.1 (2026-06-11), user-directed:** multiple-active-sprint selection (latest wins,
> explicit `sprintId`, `activeSprints` in output — supersedes the v1.0 `values[0]` rule)
> and optional dual-provider AI drafting endpoints on the mcp-jira bridge (§4.9,
> ADR-006/ADR-007). See Changelog v1.1 at the bottom.

---

## 1. Topology and ports

```
 VS Code Copilot (Claude)          Browser
        │ stdio (MCP)                │ HTTP (fetch)
        ▼                            ▼
 ┌──────────────┐   ┌─────────────────────────────┐
 │ mcp-jira     │   │ react-app (Vite, :5173)     │
 │ src/index.ts │   └──────┬───────────────┬──────┘
 └──────┬───────┘          │ :4001         │ :4002
        │            ┌─────▼──────┐  ┌─────▼────────┐
        │            │ mcp-jira   │  │ mcp-github   │
        │            │ src/http.ts│  │ src/http.ts  │
        │            └─────┬──────┘  └─────┬────────┘
        ▼                  ▼               ▼
   Jira Cloud REST v3 + Agile 1.0     GitHub REST + Jira REST
```

- `mcp-jira` — **stdio MCP server** (`src/index.ts`, for Copilot) **and** an
  **HTTP bridge** (`src/http.ts`, for the React app). Port **4001** (`MCP_JIRA_HTTP_PORT`).
- `mcp-github` — same dual shape. Port **4002** (`MCP_GITHUB_HTTP_PORT`).
- `react-app` — Vite dev server on **5173**; talks ONLY to the two HTTP bridges.

### 1.1 Tool registry pattern (both MCP packages — normative)

Tool handlers are transport-agnostic. Each tool module under `src/tools/` exports:

```ts
// src/lib/toolDef.ts
import { z } from "zod";

export interface ToolDef {
  name: string;
  description: string;            // read by Claude to decide when to call it
  schema: z.ZodObject<z.ZodRawShape>;
  handler: (input: unknown) => Promise<unknown>; // impl parses with schema internally
}
```

`src/tools/index.ts` exports `export const tools: ToolDef[]`. Both entries consume it:

- **stdio entry** (`src/index.ts`): `new McpServer(...)`; for each tool call
  `server.registerTool(t.name, { description, inputSchema: t.schema.shape }, ...)`
  wrapping the result as `{ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }`.
  On startup log **to stderr** exactly: `Jira MCP server running — waiting for tool calls...`
  (github: `GitHub MCP server running — waiting for tool calls...`).
  **Never write to stdout in stdio mode** — stdout carries MCP protocol frames.
  **Error handling in stdio adapter:** if a handler throws, catch the error and return
  `{ content: [{ type: "text", text: JSON.stringify({ error: err.message }) }], isError: true }`.
  Do not rethrow; do not write the error to stdout.
- **HTTP bridge** (`src/http.ts`): express app exposing the registry (see §2).
  Startup log: `<service> HTTP bridge listening on http://localhost:<port>`.

## 2. HTTP bridge API (identical on both servers)

| Route | Response |
|---|---|
| `GET /api/health` | `200 { ok: true, service: "mcp-jira"\|"mcp-github", version: string, ai?: {...}, boards?: { dev: ProjectRef[]; po: ProjectRef[] } }` where `ProjectRef = { id: number; projectKey: string }` (v1.25: **arrays** — multi-project; element 0 = the default). `ai` + `boards` are **mcp-jira only**; mcp-github omits them |
| `GET /api/tools` | `200 { ok: true, data: Array<{ name: string; description: string }> }` |
| `POST /api/tools/:name` (JSON body = tool input) | `200 { ok: true, data: <tool output> }` |

The `version` field in `/api/health` is the `version` string from the package's own
`package.json`. Read it at startup; do not hardcode.

Error envelope (all non-200s): `{ ok: false, error: { code: string; message: string; issues?: unknown[] } }`

| Case | Status | `code` |
|---|---|---|
| zod validation failure | 400 | `VALIDATION` (include `issues` array from zod) |
| unknown tool name | 404 | `UNKNOWN_TOOL` |
| Jira/GitHub API failure | 502 | `UPSTREAM` (friendly message, e.g. 401 → "Jira authentication failed — check JIRA_EMAIL / JIRA_API_TOKEN") |
| missing/invalid env config | 500 | `CONFIG` (message lists missing variables by name) |
| anything else | 500 | `INTERNAL` |

CORS: allowlist from **`CORS_ORIGINS`** (comma-separated; `*` = any), read at
request time, default `http://localhost:5173,http://127.0.0.1:5173` (v1.9 — was
hardcoded). Requests with no `Origin` (server-to-server / same-origin) are always
allowed. Methods `GET,POST`, header `Content-Type`. In the Docker reverse-proxy
topology the browser is same-origin, so CORS is not exercised (see
`docs/DEPLOYMENT.md`, `docs/ARCHITECTURE.md` §8).

**Credentials + wildcard (security, v1.66):** the mcp-jira bridge sends the Task
Helper session cookie (`credentials: true`). To prevent any site from making
*authenticated* cross-origin requests when an operator sets `CORS_ORIGINS=*`, the
Jira bridge only sets `Access-Control-Allow-Credentials: true` for an origin that is
**explicitly listed** (or a no-`Origin` same-origin request). A `*` wildcard still
reflects the requesting origin for cross-origin **reads**, but with credentials
**disabled** — so the cookie is never honored against a wildcard. Explicitly listing
the SPA origin (the normal deployment) keeps credentials working. The mcp-github
bridge sends no credentials, so its `*` behavior is unchanged.

## 3. Environment

Loading (dotenv, which never overrides already-set process env values), in order:
1. package-local `.env` (e.g. `packages/mcp-jira/.env`) — wins
2. repo-root `.env` — fills the gaps

`src/lib/config.ts` validates with zod, exposes `getConfig()` (lazy, cached) and
`resetConfigCache()` (for tests). stdio/http entries call `getConfig()` at startup to
fail fast with a clear list of missing variables (matches spec §9 "Missing Jira
credentials"). **Tool modules must not read env at import time** — only inside handlers —
so tests run with no `.env`.

| Variable | Used by | Required | Default |
|---|---|---|---|
| `JIRA_BASE_URL` | both servers | yes (no default) | — |
| `JIRA_EMAIL` | both servers | yes (no default) | — |
| `JIRA_API_TOKEN` | both servers | yes (no default) | — |
| `JIRA_PO_PROJECT_KEY` | mcp-jira | optional | `"PO"` |
| `JIRA_DEV_PROJECT_KEY` | mcp-jira | optional | `"DEV"` |
| `JIRA_PO_BOARD_ID` | mcp-jira | yes (no default) | — |
| `JIRA_DEV_BOARD_ID` | mcp-jira | yes (no default) | — |
| `JIRA_PO_PROJECTS` | mcp-jira | optional | `""` — extra PO projects as `KEY:boardId,KEY2:boardId2` (v1.25). When empty, the single `JIRA_PO_PROJECT_KEY`+`JIRA_PO_BOARD_ID` is the only PO project. |
| `JIRA_DEV_PROJECTS` | mcp-jira | optional | `""` — extra Dev projects as `KEY:boardId,…` (v1.25); falls back to `JIRA_DEV_PROJECT_KEY`+`JIRA_DEV_BOARD_ID`. |
| `JIRA_STORY_POINTS_FIELD` | mcp-jira | optional | `"customfield_10016"` |
| `JIRA_LINK_TYPE` | mcp-jira | optional | `"Depends on"` (v1.42 — default is now the exact link-type name in the team's Jira; was `"Depends"`/`"Relates"`. Must exist in the Jira instance. Direction: PO story **depends on** its Dev task(s) — **PO is the inward side, Dev the outward side** (§4.2). The team's `"Depends on"` type has outward = "depends on"; live-verified the PO reads "depends on VRDB-x". Pre-v1.42 payload read backwards and was swapped.) |
| `JIRA_FLAGGED_FIELD` | mcp-jira | optional | `""` (disabled) |
| `JIRA_CODE_REVIEW_STATUSES` | mcp-jira | optional | `"code review,in review,peer review,review"` (v1.2) |
| `JIRA_VELOCITY_SPRINTS` | mcp-jira | optional | `6` — closed sprints averaged for velocity/forecast (v1.4) |
| `JIRA_LEAVES_FILE` | mcp-jira | optional | `<mcp-jira pkg>/.invokeboard-leaves.json` — JSON store for per-sprint leaves (v1.5) |
| `JIRA_REQUIRED_POINTS` | mcp-jira | optional | `8` — N, required points/sprint per member (offset engine, v1.26) |
| `JIRA_OFFSET_THRESHOLD` | mcp-jira | optional | `2` — N2, surplus threshold to earn an offset point (v1.26) |
| `JIRA_AGING_BASE_DAYS` | mcp-jira | optional | `1` — aging policy: base expected days in a status (v1.58, ADR-070) |
| `JIRA_AGING_DAYS_PER_POINT` | mcp-jira | optional | `1` — aging policy: extra expected days per story point; expected = base + perPoint×points, unpointed = base only (v1.58) |
| `JIRA_OFFSET_FILE` | mcp-jira | optional | `<mcp-jira pkg>/.invokeboard-offset.json` — JSON store for the offset ledger (v1.26) |
| `JIRA_TEAM_FILE` | mcp-jira | optional | `<mcp-jira pkg>/.invokeboard-team.json` — JSON store for the per-board team roster (v1.8) |
| `JIRA_DRAFT_PLAN_FILE` | mcp-jira | optional | `<mcp-jira pkg>/.invokeboard-draft-plan.json` — JSON store for per-PO-sprint draft capacity plans (v1.68) |
| `GITHUB_TOKEN` | mcp-github | yes (no default) | — |
| `GITHUB_REPO` | mcp-github | optional (used as default repo) | — |
| `MCP_JIRA_HTTP_PORT` | mcp-jira | optional | `4001` |
| `MCP_GITHUB_HTTP_PORT` | mcp-github | optional | `4002` |
| `CORS_ORIGINS` | mcp-jira, mcp-github | optional | `"http://localhost:5173,http://127.0.0.1:5173"` — comma-separated allowlist; `*` = any (v1.9) |
| `AI_PROVIDER` | mcp-jira | optional | `""` (AI drafting disabled) — `"anthropic"` or `"github"` |
| `ANTHROPIC_API_KEY` | mcp-jira | required iff `AI_PROVIDER=anthropic` | — |
| `ANTHROPIC_MODEL` | mcp-jira | optional | `"claude-opus-4-8"` |
| `GITHUB_MODELS_TOKEN` | mcp-jira | optional (falls back to `GITHUB_TOKEN`) | — |
| `GITHUB_MODELS_MODEL` | mcp-jira | optional | `"openai/gpt-4o-mini"` |
| `GITHUB_MODELS_BASE_URL` | mcp-jira | optional | `"https://models.github.ai/inference"` |
| `VITE_MCP_JIRA_URL` | react-app | optional | `"http://localhost:4001"` |
| `VITE_MCP_GITHUB_URL` | react-app | optional | `"http://localhost:4002"` |

**Clarification on Required vs. Optional:** "yes (no default)" means the server will exit
at startup with a `CONFIG` error if the variable is absent. "optional" means the server
starts with the listed default; no startup failure. `GITHUB_REPO` is optional because
individual tool calls may supply `repo` explicitly; if a call omits `repo` and
`GITHUB_REPO` is also unset, return a `VALIDATION` error for that call.

Jira auth: HTTP Basic — `Authorization: Basic base64(email:token)`.
GitHub auth: `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`,
`X-GitHub-Api-Version: 2022-11-28`. Base URL `https://api.github.com`.

## 4. mcp-jira tools (Phase 1) — exact IO

Shared types (define in `src/lib/types.ts`):

```ts
export interface TicketRef { key: string; url: string; board: "PO" | "DEV" }

export interface IssueSummary {
  key: string;
  summary: string;
  status: string;                       // e.g. "In Progress"
  statusCategory: "todo" | "inprogress" | "done";
  assignee: string | null;              // display name
  assigneeAccountId: string | null;     // v1.8 — Jira accountId (for assignment + roster derivation)
  storyPoints: number | null;
  issueType: string;                    // "Story", "Task", "Bug", ...
  url: string;                          // browse URL
  blocked: boolean;
  resolvedAt?: string | null;           // v1.42 (ADR-052) — Jira resolutiondate; burndown input
  updatedAt?: string | null;            // v1.42 (ADR-052) — Jira updated; staleness detection
  inProgressSince?: string | null;      // v1.58 (ADR-070) — latest transition into the CURRENT status
                                        // (changelog-derived); populated only for inprogress/codereview
                                        // issues when get_active_sprint is called with withAging: true.
                                        // null = unknown (no matching transition, fetch failed, or not requested).
}

export interface HuddleItem {
  key: string;
  summary: string;
  assignee: string | null;
  status: string;
}
```

`url` is always `${JIRA_BASE_URL}/browse/${key}`.

**Blocked detection** (used by `get_active_sprint` and `get_daily_huddle`): an issue is
blocked if `JIRA_FLAGGED_FIELD` is set (non-empty string) and that field is truthy/non-empty
on the issue, OR the issue's labels array includes `"blocked"` (case-insensitive match),
OR the issue's status name contains `"block"` (case-insensitive substring match).

**Category precedence in `get_daily_huddle`:** done always wins — an issue in statusCategory
`"done"` goes into the `done` bucket even if `blocked === true`.

**Code-review detection (v1.2 — used by `get_active_sprint` and `get_daily_huddle`):**
an issue is *in code review* iff its `statusCategory` is `"inprogress"` AND its status
name — lowercased and trimmed — exactly matches one of the entries in
`JIRA_CODE_REVIEW_STATUSES` (comma-separated env var, each entry lowercased/trimmed;
default `"code review,in review,peer review,review"`). The category guard means a
done-category status like "Reviewed" can never be pulled out of `done`, and a todo-category
status never out of `todo`. `IssueSummary.statusCategory` keeps reporting Jira's raw
category — code review is a *bucketing* concept, not a field change.

**Add-to-sprint helper (v1.4 — shared by §4.1/§4.2, ADR-011):** when a creation tool is
given an optional `sprintId`, after the issue is created call
`POST /rest/agile/1.0/sprint/{sprintId}/issue` with `{ "issues": ["<new-key>"] }` to move
it into that sprint. This **must be non-fatal** — failure (e.g. the issue's project is not
on that sprint's board) returns the created ticket with `sprintWarning: "<message>"`; on
success the output includes `sprintId: <number>`. Tickets can only join a sprint whose
board filter includes their project; Dev tickets → the Dev board's sprints is the common
case.

### 4.1 `create_po_ticket`
- **Input:** `{ summary: string (1–255 chars), description: string, storyPoints?: number (≥ 0), sprintId?: number }`
- **Behavior:** create issue type `Story` in `JIRA_PO_PROJECT_KEY` via
  `POST /rest/api/3/issue`. Description converted to ADF (§4.7). `storyPoints` →
  `JIRA_STORY_POINTS_FIELD`, omitted from the payload when not provided. If `sprintId` is
  present, apply the add-to-sprint helper above (non-fatal).
- **Output:** `TicketRef & { sprintId?: number; sprintWarning?: string }` with `board: "PO"`.

### 4.2 `create_dev_ticket`
- **Input:** `{ summary: string (1–255 chars), description: string, storyPoints?: number (≥ 0), assigneeAccountId?: string (≥ 1), linkedPoTicketKey?: string, sprintId?: number }`
  (v1.30, ADR-042: `storyPoints` written to `JIRA_STORY_POINTS_FIELD` like `create_po_ticket`.
  v1.36, ADR-046: `assigneeAccountId` — assign the new Dev task to a developer at create time.)
- **Behavior:** create issue type `Task` in `JIRA_DEV_PROJECT_KEY`. If
  `linkedPoTicketKey` is present, call `POST /rest/api/3/issueLink` with payload:
  ```json
  { "type": { "name": "<JIRA_LINK_TYPE>" },
    "inwardIssue": { "key": "<linkedPoTicketKey>" },
    "outwardIssue": { "key": "<dev-key>" } }
  ```
  (See ADR-003 for the deliberate deviation from spec §4.3 "parent/child". v1.42, ADR-046: the
  **PO is the inward side**, the Dev task the outward side. Empirically, in the team's Jira the
  inward issue displays the link type's OUTWARD description, so with `JIRA_LINK_TYPE="Depends on"`
  (outward = "depends on") this reads **"PO story depends on Dev task"** — live-verified on the
  PO issue itself. This is a **swap** from the pre-v1.42 payload, which read backwards
  ("Dev depends on PO").)
  Link failure must NOT fail the creation: return the ticket and include
  `linkWarning: "<error message>"` in the output. On success with linking,
  `linkedTo` is the value of `linkedPoTicketKey`. If `sprintId` is present, apply the
  add-to-sprint helper above (non-fatal) AFTER the link step. **v1.36:** if `assigneeAccountId`
  is present, call the shared `assignIssue` (PUT assignee) AFTER the sprint step, **non-fatally** —
  a failure returns `assignWarning: "<message>"` and does not fail the creation.
- **Output:**
  ```ts
  TicketRef & { linkedTo?: string; linkWarning?: string;
                sprintId?: number; sprintWarning?: string;
                assigneeAccountId?: string; assignWarning?: string } // v1.36
  // board is always "DEV"
  ```

### 4.3 `get_active_sprint`
- **Input:** `{ boardId?: number, sprintId?: number, maxResults?: number, withAging?: boolean }` — `boardId`
  defaults to `parseInt(JIRA_DEV_BOARD_ID)`; `maxResults` defaults to `50`; `sprintId`
  selects a specific **active OR future** sprint on the board (v1.4); `withAging` defaults
  to `false` (v1.58, ADR-070 — see the aging step below).
- **Sprint selection (v1.4 — extends ADR-007 to future sprints; ADR-011):**
  1. `GET /rest/agile/1.0/board/{boardId}/sprint?state=active,future` → split `values`
     into active and future lists. If BOTH are empty/absent, return an `UPSTREAM` error
     `"No active or future sprint found for board <boardId>"`.
  2. Map active → `activeSprints: ActiveSprintRef[]` and future →
     `futureSprints: ActiveSprintRef[]`, each sorted: active **latest-first** (desc
     `startDate`, null last, ties desc `id`); future **earliest-first** (asc `startDate`,
     null last, ties asc `id` — the *next* sprint comes first).
  3. Selection: if `sprintId` is provided, select the matching sprint from
     active ∪ future — if it is in neither, return an `UPSTREAM` error
     `"Sprint <sprintId> is not an active or future sprint on board <boardId>"`. Otherwise
     default to the first active sprint (latest-started); if there are NO active sprints,
     default to the first future sprint (the next one).
- **Behavior (continued):**
  4. `GET /rest/agile/1.0/sprint/{selectedSprintId}/issue?maxResults={maxResults}`
  5. Map each issue to `IssueSummary` using blocked detection rules above.
  6. Bucket each issue (v1.2): `codereview` if the code-review detection above matches;
     otherwise its `statusCategory` (`todo` / `inprogress` / `done`). The `inprogress`
     bucket therefore EXCLUDES code-review issues.
  7. Compute `totals`: count issues per bucket (`todo`/`inprogress`/`codereview`/`done`),
     count `blocked` issues (those with `blocked === true` regardless of bucket), sum
     `storyPoints` for `storyPointsTotal` (null values count as 0), sum `storyPoints` for
     done-bucket issues for `storyPointsDone`.
  8. **Aging enrichment (v1.58, ADR-070 — only when `withAging: true`; v1.61, ADR-073 —
     `inprogress` bucket ONLY):** for every issue in the `inprogress` bucket (NOT `codereview` —
     code review counts as done per the ADR-014 DoD, so it is not "aging"), fetch its changelog
     via the dedicated paginated
     endpoint `GET /rest/api/3/issue/{key}/changelog?startAt&maxResults` (NOT `expand=changelog`
     on the bulk sprint-issue call — the stable per-issue resource; bulk/search-family endpoints
     have churned before, v1.44.1). **Bounded 2-page fetch**: page 1 (`startAt=0, maxResults=100`);
     if `!isLast && total > 100`, also fetch the tail page at `startAt = total − 100`.
     `inProgressSince` = the `created` timestamp of the LATEST history entry containing a
     `status` item whose `toString` equals the issue's CURRENT status name (i.e. "entered its
     current column at"; naturally resets on bounce-backs; no historical status→category
     inference). No matching transition found, or the changelog fetch fails for that key
     (per-key try/catch) → `inProgressSince: null` — never a guess. Fetches run in parallel
     (`Promise.all`), worst case 2 Jira calls per in-progress issue. `withAging: false`
     (the default) performs ZERO changelog calls — `get_velocity`, `get_sprint_report`, and
     `get_multi_sprint_report` never inherit this cost.
- **Output:**
```ts
export interface ActiveSprintRef {
  id: number; name: string;
  startDate: string | null; endDate: string | null; goal: string | null;
}

{
  sprint: { id: number; name: string; state: string;   // "active" | "future"
            startDate: string | null; endDate: string | null; goal: string | null };
  activeSprints: ActiveSprintRef[];   // ALL active sprints, latest-first (v1.1)
  futureSprints: ActiveSprintRef[];   // ALL future sprints, earliest-first — next-up first (v1.4)
  issuesByStatus: { todo: IssueSummary[]; inprogress: IssueSummary[];
                    codereview: IssueSummary[];           // v1.2
                    done: IssueSummary[] };
  totals: { total: number; todo: number; inprogress: number;
            codereview: number;                            // v1.2
            done: number;
            blocked: number; storyPointsTotal: number; storyPointsDone: number;
            storyPointsCodeReview: number;                 // v1.5 — sum of code-review bucket points
          };
}
```
  `storyPointsDone` stays strictly the done bucket (the Done column count). `storyPointsCodeReview`
  is the code-review bucket's points — the Dashboard's DoD progress (ADR-014) treats
  `storyPointsDone + storyPointsCodeReview` as completed, while the board still shows Code
  Review as its own column.
  `startDate`, `endDate`, `goal` are `null` when absent in Jira's response.
  The selected sprint always appears in `activeSprints` OR `futureSprints`. A future sprint
  typically has few/no issues — all four buckets may be empty; the board renders normally.
  `sprint.state` lets the UI label a future selection.

### 4.4 `get_ticket`
- **Input:** `{ ticketKey: string }` — validate with zod `.regex(/^[A-Z][A-Z0-9]{1,9}-\d+$/, "ticketKey must match PROJECT-NUMBER format")`.
- **Behavior:** `GET /rest/api/3/issue/{ticketKey}`. A 404 from Jira returns an
  `UPSTREAM` error with message `"Ticket <ticketKey> not found"`.
- **Output:**
```ts
{
  key: string; url: string; summary: string;
  description: string;                  // plain text extracted from ADF (§4.7)
  status: string; statusCategory: "todo" | "inprogress" | "done";
  assignee: string | null; reporter: string | null;
  storyPoints: number | null; issueType: string;
  labels: string[];
  created: string;   // ISO 8601, from Jira fields.created (e.g. "2025-06-01T09:00:00.000+0000")
  updated: string;   // ISO 8601, from Jira fields.updated — pass through as-is, do not reformat
}
```

### 4.5 `update_ticket`
- **Input:** `{ ticketKey: string, summary?: string, description?: string, storyPoints?: number }`
  (v1.19: `storyPoints` added) — zod `.refine` that **at least one** of
  `summary`/`description`/`storyPoints` is present, with message
  `"At least one of summary, description, or storyPoints must be provided"`.
- **Behavior:** `PUT /rest/api/3/issue/{ticketKey}` with body:
  ```json
  { "fields": { ...only fields provided... } }
  ```
  When `description` is provided, convert to ADF via `textToAdf()` before placing in
  `fields.description`. When `summary` is provided, place directly in `fields.summary`.
  When `storyPoints` is provided (v1.19), write it to the configured `JIRA_STORY_POINTS_FIELD`
  (the same field the create path uses). Jira returns `204 No Content` on success. A 404 returns
  `UPSTREAM` error `"Ticket <ticketKey> not found"`.
- **Output:** `{ key: string; url: string; updatedFields: string[] }`
  `updatedFields` lists the fields included in the PUT body (`"summary"`, `"description"`,
  and/or `"storyPoints"`). Never empty (the zod refine prevents it).

### 4.6 `get_daily_huddle`
- **Input:** `{ boardId?: number, sprintId?: number }` — `boardId` defaults to
  `parseInt(JIRA_DEV_BOARD_ID)`; `sprintId` uses the same active-sprint selection rule
  as §4.3 (latest active sprint when omitted; `UPSTREAM` error when not active).
- **Behavior:** reuses the active-sprint fetch and selection (same logic as §4.3,
  maxResults: 50), then classifies issues into buckets (precedence top to bottom, v1.2):
  - `done` — statusCategory `"done"` (done always wins; see category precedence note above).
  - `blocked` — `blocked === true` AND statusCategory is NOT `"done"` (a blocked
    code-review issue lands here, not in `codeReview`).
  - `codeReview` — code-review detection matches (see above) AND not blocked. (v1.2)
  - `inProgress` — statusCategory `"inprogress"` AND `blocked === false` AND not in
    code review.
  - `upNext` — statusCategory `"todo"` AND `blocked === false`, first 5 in the order
    returned by the Jira sprint issue API (board order).
  An issue can appear in at most one bucket. Issues that are `"todo"` and not blocked but
  beyond position 5 are omitted from output (they appear in `get_active_sprint` data).
  `summaryText` is a deterministic digest built as (v1.2 format):
  `"Sprint '<name>' (<startDate> – <endDate>): <total> issues — <inProgress count> in progress, <codeReview count> in code review, <blocked count> blocked (<blocked keys comma-separated>), <done count> done, <upNext count> up next."`.
  If there are no blocked issues, omit the parenthetical (the `0 blocked,` text remains).
  Counts are BUCKET counts (so `in progress` excludes code review). Dates formatted as
  `YYYY-MM-DD` (take the date portion of ISO string). **No LLM call.**
- **Output:**
```ts
{
  sprintName: string; sprintId: number; boardId: number;     // sprintId added in v1.1
  generatedAt: string;  // ISO timestamp (new Date().toISOString())
  inProgress: HuddleItem[]; codeReview: HuddleItem[];        // codeReview added in v1.2
  blocked: HuddleItem[];
  done: HuddleItem[]; upNext: HuddleItem[];
  summaryText: string;
}
```

### 4.7 ADF helpers (`src/lib/adf.ts`)
- `textToAdf(text: string)` — deterministic converter supporting: blank-line-separated
  paragraphs, `## ` headings (level 2/3), `- ` bullet lists. No external deps.
- `adfToText(adf: unknown): string` — walks any ADF doc collecting text nodes;
  paragraphs/headings/list items separated by newlines. Tolerates null/absent doc → `""`.

### 4.8 MCP prompts (`src/lib/prompts.ts`, registered in stdio entry only)
- `draft_tickets` (arg `featureDescription`) — instructs Claude to draft a PO story +
  Dev task each with Given/When/Then acceptance criteria, then call `create_po_ticket`
  and `create_dev_ticket` (passing the new PO key).
- `enhance_ticket` (arg `ticketKey`) — instructs Claude to `get_ticket`, rewrite the
  description with context/scope/ACs, then `update_ticket`.
- `daily_huddle` (optional arg `boardId`) — instructs Claude to call `get_daily_huddle`
  and present a crisp standup briefing.
Registered via `server.registerPrompt(...)`; templates exported as pure functions so
they are unit-testable.

### 4.9 AI drafting endpoints (v1.1 — mcp-jira HTTP bridge ONLY, NOT MCP tools)

**These are bridge-only REST endpoints.** They are NOT registered in the tool registry and
do NOT appear on the stdio MCP server or in `GET /api/tools` — Copilot/Claude already
drafts via the MCP prompts (§4.8); routing an LLM's tool call back into another LLM would
be circular. See ADR-006 (amends ADR-002: the React UI gets real AI drafting, key stays
server-side, deterministic fallback preserved).

**Provider port (`src/lib/ai/provider.ts`):**
```ts
export interface AiCompletion { text: string }          // raw JSON text from the model
export interface AiProvider {
  readonly name: "anthropic" | "github";
  readonly model: string;
  /** messages: system handled separately; throws UpstreamError on API failure */
  complete(system: string, messages: Array<{ role: "user" | "assistant"; content: string }>,
           options: { maxTokens: number }): Promise<AiCompletion>;
}
```
- `getAiProvider(): AiProvider | null` — returns `null` when `AI_PROVIDER` is unset/empty.
  Throws `ConfigError` at first use when `AI_PROVIDER=anthropic` but `ANTHROPIC_API_KEY`
  is missing, or `AI_PROVIDER=github` but neither `GITHUB_MODELS_TOKEN` nor `GITHUB_TOKEN`
  is set. Lazy — no env reads at import time (same rule as §3).
- **Anthropic adapter** — MUST use the official `@anthropic-ai/sdk` (installed: 0.104.1)
  with structured outputs. Verified pattern against the installed SDK:
  ```ts
  import Anthropic from "@anthropic-ai/sdk";
  import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
  import * as z from "zod/v4";   // ← AI schemas use the zod/v4 subpath (zod 3.25.76);
                                 //    the rest of the codebase stays on v3 ("zod")
  const client = new Anthropic({ apiKey });
  const res = await client.messages.parse({
    model,                        // default "claude-opus-4-8"
    max_tokens: 4096,
    thinking: { type: "adaptive" },
    system,
    messages,                     // [{ role: "user" | "assistant", content: string }]
    output_config: { format: zodOutputFormat(Schema) },   // single argument
  });
  res.parsed_output               // typed result | null
  ```
  Error mapping: `Anthropic.AuthenticationError` → `UpstreamError` "Anthropic
  authentication failed — check ANTHROPIC_API_KEY"; `Anthropic.RateLimitError` →
  "Anthropic rate limit reached — retry shortly"; other `Anthropic.APIError` → message
  with status. Never send `temperature`/`top_p`/`top_k` (400 on this model family).
  Implementation note: since `messages.parse` already returns typed output, the Anthropic
  adapter MAY bypass the generic `complete()` JSON path and expose the parsed object
  directly — keep the `AiProvider` interface satisfied either way.
- **GitHub Models adapter** — raw `fetch` (no SDK exists):
  `POST {GITHUB_MODELS_BASE_URL}/chat/completions` with headers
  `Authorization: Bearer <GITHUB_MODELS_TOKEN ?? GITHUB_TOKEN>`,
  `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`,
  `Content-Type: application/json`; body
  `{ model, messages: [{ role: "system", content: system }, ...messages], max_tokens,
  response_format: { type: "json_object" } }`. Response text =
  `choices[0].message.content`. Parse with the zod schema; on parse failure retry ONCE
  with an appended user message `"Your previous reply was not valid JSON matching the
  required schema. Reply with ONLY the JSON object."`; second failure → `UpstreamError`
  "AI returned an unparseable response". 401/403 → `UpstreamError` that **surfaces GitHub's
  actual response detail** (e.g. "GitHub Models rejected the token (401: … Bad credentials …).
  Use a valid, unexpired GitHub token with Models access…") — v1.44.2, so a plain invalid/expired
  token isn't mis-reported as a scope problem. 404 → include hint "check GITHUB_MODELS_BASE_URL".

**Endpoints (mcp-jira `src/http.ts`):**

`POST /api/ai/draft-tickets`
- **Input (zod):** `{ messages: Array<{ role: "user" | "assistant"; content: string (1–4000) }>
  (min 1, last entry must have role "user" — zod refine), storyPoints?: number (≥ 0) }`
- **Behavior:** build the system prompt from the SAME ticket conventions as
  `lib/prompts.ts`/`ticketTemplates` (user-story phrasing, Given/When/Then ACs, dev
  implementation checklist, "## " headings + "- " bullets so ADF conversion works),
  instructing the model to: analyse the conversation, enhance terse input into a detailed
  ticket pair, and return JSON `{ assistantMessage, po: { summary, description,
  storyPoints }, dev: { summary, description } }`. `assistantMessage` is a short
  conversational reply (what it understood / what it improved / any assumptions).
  Multi-turn: the full `messages` history is sent each call so follow-ups refine drafts.
- **Output:** `{ assistantMessage: string; po: { summary: string; description: string;
  storyPoints: number | null }; dev: { summary: string; description: string };
  provider: "anthropic" | "github"; model: string }`
- The endpoint does NOT create anything in Jira — the client reviews drafts then calls
  the existing `create_po_ticket`/`create_dev_ticket` tools.

`POST /api/ai/enhance-ticket`
- **Input (zod):** `{ ticketKey: string (same regex as §4.4), notes?: string (≤2000),
  current: { summary: string; description: string } }`
- **Behavior:** system prompt instructs the model to rewrite the ticket with clear
  context/scope + Given/When/Then ACs, incorporating `notes`, preserving real facts from
  `current`. Returns JSON `{ assistantMessage, summary, description }`.
- **Output:** `{ assistantMessage: string; summary: string; description: string;
  provider: "anthropic" | "github"; model: string }`
- The endpoint does NOT call Jira — the client flow is `get_ticket` → this endpoint →
  `update_ticket` (keeps the endpoint pure-AI and testable; reuses existing tool I/O).

`POST /api/ai/sprint-summary` (v1.4 — Phase 3 reports; ADR-012)
- **Input (zod):** the report payload the client already holds —
  `{ sprintName: string, state: string, startDate?: string, endDate?: string,
  goal?: string | null, committedPoints: number, completedPoints: number,
  completedCount: number, totalCount: number, carryoverCount: number,
  blockedCount: number, byAssignee: Array<{ name: string; donePoints: number;
  totalPoints: number; doneCount: number; totalCount: number }> }` (all derived from
  `get_sprint_report`).
- **Behavior:** system prompt asks the model for a concise, professional **sprint-review
  executive summary** (3–6 sentences + a short "highlights / risks / next" structure):
  what was committed vs delivered, notable carryover/blockers, per-team observations, and
  a forward note. Plain prose (markdown ok). Returns JSON `{ summary }`.
- **Output:** `{ summary: string; provider: "anthropic" | "github"; model: string }`
- Pure-AI, no Jira call. Same provider port + error mapping as the other AI endpoints.

`POST /api/ai/plan-dev-tickets` (v1.11 — bulk Dev planning for the Linking page; ADR-022)
- **Input (zod):** `{ poStories: Array<{ key: string, summary: string, description?: string }> (1..20),
  instructions?: string (≤2000) }` — the selected PO stories the user wants Dev tasks for.
- **Behavior:** ONE provider call. The system prompt asks the model to **plan and draft the
  developer Task needed to deliver each PO story**, returning one Dev draft per PO (same ADF
  description conventions — `## ` headings + `- ` bullets). `instructions` is optional global
  guidance. Bridge-only REST, NEVER an MCP tool (circular for Copilot). Lives in
  `lib/ai/draftService.ts` (`planDevTickets` + `PlanDevTicketsOutputSchema`, zod/v4).
- **Output:** `{ assistantMessage: string; items: Array<{ poKey: string; devSummary: string;
  devDescription: string }>; provider: "anthropic" | "github"; model: string }`. The UI matches
  `items` to the selected POs by `poKey`; any PO the model omits falls back to a deterministic
  template client-side. The UI reviews/edits the plan before bulk-creating via `create_dev_ticket`.

`POST /api/ai/draft-po-story` (v1.72 — roll N existing Dev tasks up into ONE PO story; ADR-083)
- **Input (zod):** `{ devTickets: Array<{ key: string, summary: string, description?: string,
  storyPoints?: number | null }> (1..20), instructions?: string (≤2000) }` — the selected Dev
  tickets the user wants a covering PO story for.
- **Behavior:** ONE provider call — the **inverse** of `plan-dev-tickets`. The system prompt asks
  the model to write **exactly one** PO story that covers ALL the given Dev tasks, deriving the
  acceptance criteria from the tasks' real content and never inventing work not represented in
  them (same ADF description conventions — `## ` headings + `- ` bullets). Description template:
  `## User Story` → `## Acceptance Criteria` (Given/When/Then) → `## Scope` / `## Out of Scope` →
  `## Delivered by` (one `- KEY — title` bullet per Dev task). `summary` is business value in
  ≤255 chars, never a list of Jira keys. When the tasks are unrelated the model says so in
  `assistantMessage` and still writes the best single umbrella story. `instructions` carries the
  reviewer's "comment & regenerate" text (§6, same pattern as §4.9 `plan-dev-tickets`).
  Bridge-only REST, NEVER an MCP tool (circular for Copilot). Lives in `lib/ai/draftService.ts`
  (`draftPoStory` + `DraftPoStoryOutputSchema`, zod/v4).
- **Output:** `{ assistantMessage: string; summary: string; description: string;
  provider: "anthropic" | "github"; model: string }`
- **No `storyPoints` in the output — deliberate.** The new PO story's points are the arithmetic
  **sum** of the selected Dev tickets' points, computed client-side and seeded into an editable
  field. Asking the model for a number it cannot compute more accurately invites a wrong value
  the user must catch (contrast §4.9 `draft-tickets`, where there is no source figure to sum).
- The endpoint does NOT create or link anything — the client reviews/edits the draft, then calls
  `create_po_ticket` (§4.1) followed by `link_dev_to_po` (§4.31) per Dev ticket.
- AI off/unavailable → `503 AI_UNAVAILABLE`; the client falls back to a deterministic rollup
  template (`react-app` `lib/poRollup.ts`) so the workflow never blocks.

`POST /api/ai/ask` (v1.18 — in-app AI Q&A assistant; ADR-029)
- **Input (zod):** `{ question: string (1..2000), boardId?: number, sprintId?: number,
  history?: Array<{ role: "user"|"assistant"; content: string (1..2000) }> (max 8) }` — a
  free-form question plus the Huddle's current context for the model to resolve ids.
  **v1.40 (ADR-050):** `history` carries the prior Ask-mode turns; the service folds them into the
  system prompt ("Conversation so far") so follow-up questions resolve references. Optional —
  omitted = the previous stateless behavior.
- **Behavior:** an **agentic tool-calling loop** (the first multi-step/tool use of the `AiProvider`
  port — prior endpoints do single calls). The system prompt states the assistant's role + the
  current context (boardId, active sprintId, **today's date**). The model is offered a **read-only
  allowlist** of mcp-jira tools (`get_active_sprint`, `get_daily_huddle`, `get_impediments`,
  `get_pull_requests`, `get_post_scrum`, `get_meeting_goal`, `get_leaves`, `get_sprint_report`,
  `get_velocity`, `get_team_members`,
  `get_ticket`, `list_sprints`, `get_linked_issues`; **v1.40 (ADR-050) adds
  `get_issue_pull_requests`, `get_all_leaves`, `get_offset_ledger`; v1.41 (ADR-051) adds
  `get_meeting_notes`**) as function specs (each tool's zod schema →
  JSON Schema). On each turn the model may request tool calls; the loop runs the matching
  `ToolDef.handler` **in-process** and feeds results back, **capped at ~5 turns**, until the model
  returns a final answer. **No write tools are ever exposed** — the assistant cannot mutate Jira.
  Bridge-only REST, NEVER an MCP tool (circular for Copilot). Lives in `lib/ai/askService.ts`; adds
  `chatWithTools` to the `AiProvider` port + both adapters.
- **Write-actions (v1.19, ADR-030):** the loop ALSO offers a curated **WRITE_TOOLS** set
  (`update_ticket, transition_issue, move_issue_to_sprint, create_sprint, set_sprint_goal,
  assign_issue`; **v1.40 (ADR-050) adds `set_leaves`** — "file my vacation Thu–Fri" becomes a
  confirmable proposal). Read calls run in-process as above, but a **write call is NEVER executed** — the
  loop stops and returns the requested call as `proposedAction: { tool, args }`. The UI confirms it
  in a modal and only then executes the write (via the existing tool). The AI never mutates Jira.
- **Output:** `{ answer: string; toolsUsed: string[]; provider: "anthropic" | "github"; model: string;
  proposedAction?: { tool: string; args: Record<string, unknown> }; cards?: AskCard[] }`. When
  `proposedAction` is present, `answer` is a short lead-in (may be empty) and the UI shows the
  confirmation modal. **v1.71 (ADR-082):** `cards` (≤3) mirrors the read tools the loop actually ran
  for **card-able** tools — `AskCard = { kind: "ticket" | "sprint" | "huddle"; data: <that tool's
  output> }` (`get_ticket`→`ticket`, `get_active_sprint`→`sprint`, `get_daily_huddle`→`huddle`) — so
  the UI can render the same rich result cards the deterministic commands use. Deterministic capture
  from the in-process tool results; **no extra model call**.

`POST /api/ai/ask/stream` (v1.71 — streaming variant of `/api/ai/ask`; ADR-082)
- **Input (zod):** identical to `/api/ai/ask` (`askInputSchema` is shared).
- **Behavior:** runs the same agentic loop but emits progress over **Server-Sent Events**
  (`Content-Type: text/event-stream`). Each event is an SSE frame `event: <type>\ndata: <json>\n\n`:
  | `event` | `data` shape | meaning |
  |---|---|---|
  | `step` | `{ tools: string[] }` | the loop is about to run this batch of read tools (drives the live "Looking at…" indicator) |
  | `delta` | `{ text: string }` | a chunk of the final answer (token-ish; concatenate in order) |
  | `cards` | `{ cards: AskCard[] }` | card-able tool results captured so far (≤3) |
  | `proposed` | `{ answer: string; proposedAction: { tool, args }; toolsUsed, provider, model }` | a write the model wants — the stream then ends; the UI confirms in a modal (write is NOT executed) |
  | `done` | `{ answer, toolsUsed, provider, model, cards? }` | terminal success; `answer` equals the concatenated deltas |
  | `error` | `{ code, message }` | terminal failure (same codes as the JSON endpoint; used when the failure happens **after** SSE headers are flushed) |
  Pre-flush failures (validation / provider config / `AI_UNAVAILABLE`) use the normal JSON envelope +
  HTTP status, exactly like `/api/ai/ask`, so the client can fall back. **Anthropic** streams true
  token deltas; **GitHub Models** uses a buffered fallback (still emits `step`s, but the answer arrives
  as a single `delta`). Bridge-only REST, NEVER an MCP tool. The non-streaming `/api/ai/ask` remains
  for fallback and tests. Adds `chatWithToolsStream` to the `AiProvider` port + both adapters.

**Errors (all AI endpoints):**
| Case | Status | `code` |
|---|---|---|
| `AI_PROVIDER` unset/empty | 503 | `AI_UNAVAILABLE`, message `"AI drafting is disabled — set AI_PROVIDER=anthropic or github and the matching key (see docs/SETUP.md)"` |
| provider configured but key missing | 500 | `CONFIG` (names the missing variable) |
| provider API failure | 502 | `UPSTREAM` (friendly messages above) |
| zod validation | 400 | `VALIDATION` |

**`GET /api/health` (mcp-jira)** gains `ai: { enabled: boolean; provider: "anthropic" |
"github" | null; model: string | null }` — `enabled: false, provider: null, model: null`
when `AI_PROVIDER` is unset. The React app uses this to pick AI vs deterministic mode.

**`GET /api/health` (mcp-jira) also gains `boards` (v1.6, ADR-017; multi-project v1.25, ADR-037)** —
the configured board context so the React app can offer a PO/Dev + project switch without knowing env
values:
```ts
boards: {
  dev: ProjectRef[];   // from JIRA_DEV_PROJECTS, else [JIRA_DEV_BOARD_ID + JIRA_DEV_PROJECT_KEY]
  po:  ProjectRef[];   // from JIRA_PO_PROJECTS,  else [JIRA_PO_BOARD_ID  + JIRA_PO_PROJECT_KEY]
}
// ProjectRef = { id: number; projectKey: string }; element 0 is the default project for that side.
```
Pure config (no Jira call). `JIRA_PO_PROJECTS`/`JIRA_DEV_PROJECTS` are `KEY:boardId,KEY2:boardId2`
lists; when empty, each side is the single-project 1-element array (back-compatible). All board-scoped
tools (`get_active_sprint`, `get_daily_huddle`, `list_sprints`, `get_sprint_report`, `get_velocity`,
`create_sprint`) already accept `boardId` — the app passes the **active** project's id (`boards[key][activeIdx].id`);
no tool signature changes. Older bridges (object `boards`) → the app falls back to a 1-project list.

**`GET /api/health` (mcp-jira) also gains `policy` (v1.26, ADR-038)** — the offset policy:
`policy: { requiredPoints: number; offsetThreshold: number }` from `JIRA_REQUIRED_POINTS` (N) +
`JIRA_OFFSET_THRESHOLD` (N2). Pure config; the Leaves page reads it to compute earned offsets (§4.26).

**Quality gates:** all §4.9 tests run keyless/offline — mock the Anthropic SDK module and
global fetch; cover: AI_UNAVAILABLE 503, missing-key CONFIG, happy path per provider,
GitHub JSON-retry path, provider error mapping, validation failures.

## 4.10–4.13 Sprint management + reports tools (v1.4 — real MCP tools; ADR-011/012)

These ARE MCP tools (registered in the tool registry, stdio server, `GET /api/tools`, and
the HTTP bridge) — Jira reads/writes Claude can legitimately perform. Shared type:

```ts
export interface SprintRef {
  id: number; name: string; state: "active" | "future" | "closed";
  startDate: string | null; endDate: string | null;
  completeDate: string | null;            // closed sprints only, else null
  goal: string | null; boardId: number;
}
```

### 4.10 `create_sprint` (WRITE)
- **Input:** `{ name: string (1–255), goal?: string, startDate?: string, endDate?: string, boardId?: number }`
  — `boardId` defaults to `parseInt(JIRA_DEV_BOARD_ID)`. Dates are ISO 8601; zod `.refine`
  that if both are present, `startDate < endDate`.
- **Behavior:** `POST /rest/agile/1.0/sprint` with
  `{ name, originBoardId: boardId, goal?, startDate?, endDate? }`. Jira creates a **future**
  sprint. Jira wants full ISO timestamps — if the client sends date-only (`YYYY-MM-DD`),
  the server normalizes to `...T00:00:00.000Z` before sending.
- **Output:** `SprintRef` (the created sprint; `state` will be `"future"`).
- **Description (for Claude):** "Create a new future sprint on the board with a name, goal,
  and optional start/end dates." Stdio + HTTP both expose it (a deliberate write tool).

### 4.10b `set_sprint_goal` (WRITE — v1.13, ADR-024)
- **Input:** `{ sprintId: number, goal: string }` (`goal` may be empty string to clear).
- **Behavior:** `POST /rest/agile/1.0/sprint/{sprintId}` with `{ goal }` — Jira's Agile API
  treats POST as a **partial update**, so only the goal changes (name/dates/state untouched).
  404 → `UPSTREAM` ("Sprint {id} not found"). New jiraClient `updateSprintGoal(sprintId, goal)`.
- **Output:** `{ sprintId: number, goal: string | null }`.
- **Description (for Claude):** "Set (or clear) the goal of an existing sprint." Registered
  MCP tool (stdio + `/api/tools` + bridge). Used by the Planning sprint-goal editor and lets
  the Scrum Master keep the goal current; the Dashboard shows the goal + progress.

### 4.11 `list_sprints`
- **Input:** `{ boardId?: number, state?: "active" | "future" | "closed" | "all" (default "all"), maxResults?: number (default 50) }`
- **Behavior:** `GET /rest/agile/1.0/board/{boardId}/sprint?state=<states>` (for `"all"`
  request `active,future,closed`). Map to `SprintRef[]`. Sort: closed latest-first by
  `completeDate`/`startDate`, then active latest-first, then future earliest-first — OR,
  simpler and specified: return three arrays.
- **Output:** `{ boardId: number; active: SprintRef[]; future: SprintRef[]; closed: SprintRef[] }`
  (each sorted as in §4.3 conventions; closed sorted latest-completed first). When a single
  `state` is requested, the other arrays are empty.

### 4.12 `get_sprint_report`
- **Input:** `{ sprintId: number, maxResults?: number (default 100) }`
- **Behavior:** `GET /rest/agile/1.0/sprint/{sprintId}` (meta) + `GET
  /rest/agile/1.0/sprint/{sprintId}/issue?maxResults=...`. **Definition of Done (v1.5,
  ADR-014):** an issue is **completed** if `statusCategory === "done"` **OR** it matches the
  code-review detection (§4.3 / `JIRA_CODE_REVIEW_STATUSES`) — i.e. done OR in code review.
  **notCompleted** = everything else (carryover). Compute points via
  `JIRA_STORY_POINTS_FIELD` (null → 0). `byAssignee.donePoints`/`doneCount` likewise count
  done-or-code-review as done.
- **Output:**
```ts
{
  sprint: SprintRef;
  committedPoints: number;     // sum of ALL issues' points
  completedPoints: number;     // sum of completed (done OR code-review) issues' points
  completionRate: number;      // completedPoints / committedPoints, 0 when committed=0
  totalCount: number; completedCount: number; carryoverCount: number;
  blockedCount: number;
  completed: IssueSummary[];   // done OR code-review issues
  notCompleted: IssueSummary[];// carryover (todo + inprogress that is NOT code-review; blocked flagged)
  byAssignee: Array<{ name: string;   // display name, "Unassigned" for null
                      donePoints: number; totalPoints: number;
                      doneCount: number; totalCount: number }>;  // sorted by totalPoints desc
}
```

### 4.13 `get_velocity`
- **Input:** `{ boardId?: number, sprintCount?: number (default `JIRA_VELOCITY_SPRINTS` → 6), beforeSprintId?: number, includeActive?: boolean (default false) }`
- **Behavior:** list closed sprints (latest-completed first). **`includeActive` (v1.10,
  ADR-021):** when `true`, the candidate pool ALSO includes **active** sprints (state
  `closed` + `active`, never `future`), sorted latest-first by `completeDate` (fallback
  `endDate`). This fixes velocity on boards that **rarely formally close sprints** (sprints
  sit in `active` indefinitely) — closed-only would otherwise return stale/old sprints and
  miss recent delivered work. The UI passes `includeActive: true` so the chart reflects the
  latest sprints "even if active." `beforeSprintId` still excludes the selected sprint and
  any sprint not strictly before it, so the current in-progress sprint is not double-counted.
  When `false`, behavior is unchanged (closed-only). **Selected-sprint context
  (v1.5, ADR-015):** when `beforeSprintId` is provided, consider only the sprints
  that come **before** that sprint — i.e. exclude `beforeSprintId` itself and any
  sprint whose `completeDate` (fallback `startDate`) is not earlier than the selected
  sprint's `startDate` (fallback `completeDate`). This makes the Reports velocity "the N
  sprints prior to the one I'm looking at." When `beforeSprintId` is omitted, use the
  latest sprints (prior behavior). Take the first `sprintCount`, run the
  `get_sprint_report` point math per sprint (completed uses the same DoD = done OR code
  review, §4.12), reverse to chronological order. `averageCompleted` = mean of
  `completedPoints` (0 when none). **Forecast** = that average (≤2 decimals), labeled a
  heuristic — NOT a promise. (The UI further adjusts this for leaves — §6, ADR-016 — but
  this tool returns the raw, unadjusted velocity.)
- **Output:**
```ts
{
  boardId: number; sprintCount: number;
  sprints: Array<{ id: number; name: string;
                   committedPoints: number; completedPoints: number;
                   completeDate: string | null }>;  // chronological (oldest→newest)
  averageCompleted: number;    // mean completedPoints
  forecastNext: number;        // heuristic capacity suggestion (= averageCompleted)
}
```
  When no matching closed sprints → `sprints: []`, `averageCompleted: 0`, `forecastNext: 0`
  (the UI shows an empty, encouraging state, not an error).

### 4.14 `get_leaves` / `set_leaves` (v1.5 — per-sprint leaves/offset tracker; ADR-016)

Real MCP tools backed by a **JSON file on the mcp-jira host** (`JIRA_LEAVES_FILE`, default
`<mcp-jira pkg>/.invokeboard-leaves.json` — git-ignored). This is the project's first stateful
store (a deliberate, user-chosen exception to the stateless-bridge norm).

**v1.26 (ADR-038): leaves are now TYPED.** `LeaveType = "VL" | "EL" | "Holiday" | "Offset"`. File shape:
```jsonc
{ "<sprintId>": { "<assigneeName>": { "2026-06-03": "VL", "2026-06-04": "Offset" }, ... }, ... }
```
`readLeaves` (`src/lib/leavesStore.ts`) **normalizes on read** — a legacy `string[]` of dates becomes
`{ [date]: "VL" }` — so the pre-v1.26 `.invokeboard-leaves.json` keeps working with no migration. Path
read from config at call time. `readLeaves`/`writeLeaves` tolerate a missing/corrupt file (treat `{}`).

- **`get_leaves`** — Input `{ sprintId: number }`. Output
  `{ sprintId, leaves: Record<string, Record<string /*YYYY-MM-DD*/, LeaveType>> }` (assignee → typed
  map; `{}` when none).
- **`set_leaves`** — Input `{ sprintId, assignee (1–120), entries: Array<{ date: YYYY-MM-DD, type: LeaveType }> }`
  (full replace per assignee; empty `entries` clears). **Back-compat:** also accepts legacy
  `dates: string[]` (→ all `"VL"`) so the transitional frontend keeps working; `entries` wins if both
  are sent; at least one is required. Output the updated `{ sprintId, leaves }` (typed) for that sprint.
- **`get_all_leaves`** (v1.29, ADR-041) — Input `{}` (strict). Output
  `{ leaves: Record<string /*sprintId*/, Record<string /*assignee*/, Record<string /*YYYY-MM-DD*/, LeaveType>>> }`
  — the WHOLE store in one read (legacy untyped dates normalized to `"VL"`). Powers the forward,
  multi-sprint leave planner without a `get_leaves` call per sprint. Writes still go through `set_leaves`
  (per sprint), so the date a leave lands on is attributed to the sprint whose range contains it.
- All registered MCP tools. Tests point `JIRA_LEAVES_FILE` at a temp path; cover typed round-trip,
  replace/clear, the legacy-dates shim, type validation, and the whole-store read.

### 4.15 `get_assignable_users` / `assign_issue` (v1.7 — sprint-planning assignment; ADR-018)

Real MCP tools for assigning tickets to developers during planning. Jira Cloud assigns by
**accountId** (not name/email), so we list assignable users first.

```ts
export interface AssignableUser { accountId: string; displayName: string; active: boolean }
```

- **`get_assignable_users`** — Input `{ projectKey?: string, boardId?: number, maxResults?: number (default 50) }`.
  `projectKey` resolves: explicit `projectKey`; else if `boardId` equals the PO/Dev board id,
  the matching `JIRA_PO_PROJECT_KEY`/`JIRA_DEV_PROJECT_KEY`; else default `JIRA_DEV_PROJECT_KEY`.
  **Behavior:** `GET /rest/api/3/user/assignable/search?project={projectKey}&maxResults=...`.
  Map to `AssignableUser[]`, keep only `active === true`, sort by `displayName`.
  **Output:** `{ projectKey: string; users: AssignableUser[] }`.
- **`assign_issue` (WRITE)** — Input `{ ticketKey: string (same regex as §4.4), accountId: string | null }`
  (`null` unassigns). **Behavior:** `PUT /rest/api/3/issue/{ticketKey}/assignee` with
  `{ "accountId": <accountId|null> }` (Jira returns 204). A 404 → `UPSTREAM`
  `"Ticket <ticketKey> not found"`. **Output:** `{ ticketKey: string; accountId: string | null; assigned: boolean }`
  (`assigned` = `accountId !== null`).
- Both are registered MCP tools (stdio + `/api/tools` + bridge). Tests mock the Jira client;
  cover projectKey resolution, active-only filter + sort, assign + unassign (null), 404.
- **(v1.8 note, ADR-019):** `get_assignable_users` returns *everyone with the Assignable
  User permission* on the project (often org-wide) — NOT a team. The UI no longer uses it as
  the roster; it backs the optional add-by-name **search** only. The leaves plotter and the
  assignment dropdown use the curated **team roster** (§4.16). `assign_issue` is unchanged.

### 4.16 Team roster — `get_team_members` / `set_team_members` / `get_recent_assignees` (v1.8 — ADR-019)

Jira has no portable "team" primitive (assignable-search is permission-wide; project roles
and groups are instance-specific and need elevated perms). So we maintain a **curated team
roster per board**, **seeded from who's actually been assigned tickets in recent sprints**
("usual members"), editable (add/remove), persisted to a **bridge-side JSON file**
(`JIRA_TEAM_FILE`, default `<mcp-jira pkg>/.invokeboard-team.json`, git-ignored — same store pattern
as leaves, §4.14). File shape: `{ "<boardId>": [ { "accountId": "...", "displayName": "..." }, … ] }`.
Helpers in `src/lib/teamStore.ts` (`readTeams()`/`writeTeams()`, missing/corrupt → `{}`).

```ts
export interface TeamMember { accountId: string; displayName: string }
```

- **`get_recent_assignees`** — Input `{ boardId?: number, withinDays?: number (default 90), maxResults?: number (default 200) }`.
  **Behavior (v1.9 — ADR-020):** scan the **whole board** (NOT a fixed number of sprints) for
  recently-assigned issues via `GET /rest/agile/1.0/board/{boardId}/issue` with
  `jql=assignee IS NOT EMPTY AND updated >= -{withinDays}d ORDER BY updated DESC`,
  `fields=assignee`, paging up to `maxResults` issues. Collect **distinct assignees** by
  `accountId` (skip null), counting how many of the scanned tickets each had. This covers the
  **active sprint + backlog + recently-closed work** — the prior v1.8 behavior sampled only the
  last 3 *closed* sprints and so missed anyone whose recent work was in the active sprint.
  **Output:** `{ boardId: number; assignees: Array<{ accountId: string; displayName: string; ticketCount: number }> }`
  sorted by `ticketCount` desc then `displayName`. This is the **suggestion source** for
  building/refreshing the team. Requires `IssueSummary.assigneeAccountId` (§4 type change).
  New jiraClient helper `getBoardAssigneesRaw(boardId, jql, maxResults)` (pages the board issue
  endpoint, returns `{ assignee, assigneeAccountId }[]`).
- **`get_team_members`** — Input `{ boardId?: number }` (default Dev board). **Output:**
  `{ boardId: number; members: TeamMember[] }` — the persisted roster for that board (`[]`
  when none saved yet). Sorted by `displayName`.
- **`set_team_members` (persist)** — Input `{ boardId?: number, members: Array<{ accountId: string (1+), displayName: string (1+) }> }`.
  **Behavior:** replace the board's roster with `members` (de-duped by `accountId`); empty
  array clears it. Read-modify-write the file. **Output:** `{ boardId: number; members: TeamMember[] }`.
  Add/remove in the UI = send the full updated list.
- All three are registered MCP tools (stdio + `/api/tools` + bridge). Tests point
  `JIRA_TEAM_FILE` at a temp path / mock the Jira client; keyless/offline; cover recent-assignee
  derivation (distinct + counts + sort, null-assignee skip), team round-trip set→get, replace/clear.

### 4.17 `get_linked_issues` (v1.11 — existing PO↔Dev links; ADR-022, amended v1.72/ADR-083)

Used by the Linking page to show which Dev tickets a PO story already links to, so bulk
creation doesn't duplicate. **A PO story may link to MANY Dev tickets** — the output has always
been an array per key, and ADR-046 ships 1–2 Dev tasks per PO by point breakdown. (Pre-v1.72
this section said "one or none"; that was only ever a UI selection heuristic — a PO with an
existing link is deselected by default but still selectable — never a data or backend
constraint. v1.72/ADR-083 makes many-Dev→1-PO an explicit, user-driven write path.)

- **Input:** `{ keys: string[] (1+), projectKey?: string }`. `projectKey` filters the
  returned links to a project (default = `JIRA_DEV_PROJECT_KEY`, i.e. only the Dev tickets
  linked to each PO). Pass `projectKey: ""` to return links to ANY project. **To read a Dev
  ticket's PO links (v1.72, Linking "Link existing" mode) the caller MUST pass the PO project
  key explicitly** — the default filter is the Dev project and would return `[]` for every key.
- **Behavior:** for each key, fetch the issue's `issuelinks`
  (`GET /rest/api/3/issue/{key}?fields=issuelinks`), take the linked issue on
  each link (`inwardIssue ?? outwardIssue`), and keep those whose key is in `projectKey`
  (prefix `${projectKey}-`). Fetches run in parallel. A missing/unreadable key contributes an
  empty array (non-fatal — never throws for one bad key).
- **Output:** `{ links: Record<string, LinkedIssueRef[]> }` keyed by the input key (every input
  key present; `[]` when no matching links), where **(v1.72, ADR-083)**:
  ```ts
  export interface LinkedIssueRef {
    key: string; summary: string; status: string; url: string;
    linkId: string;                        // v1.72 — the Jira issue-link id; the DELETE target for §4.32
    linkTypeName: string;                  // v1.72 — e.g. "Depends on"
    direction: "inward" | "outward";       // v1.72 — which side the OTHER issue sits on
  }
  ```
  All three new fields come from the payload **already fetched** — no extra Jira call.
  `direction` is `"inward"` when Jira populated `inwardIssue` (⇒ THIS issue is the outward side)
  and `"outward"` otherwise. It is **not** redundant with the key prefix: Jira returns only the
  *other* side of each link, so reading a PO story yields `outwardIssue: DEV-x` (PO inward, per
  §4.2) while reading a Dev ticket yields `inwardIssue: PO-y`. The Linking "Link existing" mode
  reads from the **Dev** side, so without `direction` it cannot tell a canonical v1.42+ link
  from a pre-v1.42 reversed one. `linkTypeName` is what the UI renders beside an Unlink control
  so the user knows which of several links they are removing.
  When Jira omits an id, `linkId` is `""` — the UI treats empty as "not unlinkable" and disables
  the control rather than crashing (same fallback discipline as `summary: ""`).
- New jiraClient helper `getLinkedIssues(key)` → all linked issues of one key (the tool filters).
- Registered MCP tool (stdio + `/api/tools` + bridge). Tests mock the Jira client; keyless.

### 4.18 `get_issue_descriptions` (v1.14 — PO description context for Dev drafting; ADR-025)

Used by the Linking page so the AI plan (and the deterministic fallback) drafts each Dev task
from the **PO story's own description**, not just its one-line summary.

- **Input:** `{ keys: string[] (1..50) }` — the PO story keys to fetch descriptions for.
- **Behavior:** for each key, fetch the issue and flatten its description to plain text
  (reuses `getIssue` → `adfToText(fields.description)`). Fetches run in parallel. A missing/
  unreadable key contributes `""` (non-fatal — never throws for one bad key), so a bulk caller
  stays resilient. Read-only; no Jira writes.
- **Output:** `{ descriptions: Record<string, string> }` keyed by the input key (every input
  key present; `""` when the issue has no description or could not be read).
- Reuses jiraClient `getIssue` (already `adfToText`-flattens the description); no new client surface.
- Registered MCP tool (stdio + `/api/tools` + bridge). Tests mock the Jira client; keyless.
- The Linking page caps each description it sends to the AI (`plan-dev-tickets`) at ~4000 chars
  to bound prompt size; `plan-dev-tickets` already accepts `poStories[].description?` (v1.11).
- **`adfToText` fidelity (v1.14.1):** the flattener preserves block structure — bullet/ordered
  list items each on their own line with a `- `/`N. ` marker (nested lists indented), `hardBreak`
  → newline, and inline `mention`/`emoji`/`inlineCard` text included (was: list items concatenated
  into a run-on, hardBreaks dropped — which garbled or emptied real PO descriptions). Many PO
  stories have a genuinely empty `description` (Jira returns `null`); those return `""` and the
  Linking plan flags the row as "PO has no description — drafted from title".

### 4.19 `get_transitions` / `transition_issue` (v1.15 — change a ticket's status; ADR-026)

Used by the Planning ticket list to move a story through its workflow (e.g. To Do → In Progress).
Jira status changes go through **transitions** (not a direct field write), and the available
transitions depend on the issue's current status + workflow, so they are fetched per issue.

- **`get_transitions`** — **Input:** `{ ticketKey: string }`. **Behavior:**
  `GET /rest/api/3/issue/{key}/transitions` → the transitions available from the issue's current
  status. **Output:** `{ ticketKey, transitions: Array<{ id: string; name: string; to: { name: string; category: "todo"|"inprogress"|"done" } }> }`. 404 → UPSTREAM. Read-only.
- **`transition_issue`** (WRITE) — **Input:** `{ ticketKey: string, transitionId: string }`.
  **Behavior:** `POST /rest/api/3/issue/{key}/transitions` with `{ transition: { id } }`; on success
  re-reads the issue and returns its new status. **Output:** `{ ticketKey, status: string, statusCategory: "todo"|"inprogress"|"done" }`. 404 → UPSTREAM; an invalid transition id → VALIDATION/UPSTREAM.
- New jiraClient helpers `getTransitions(ticketKey)` + `transitionIssue(ticketKey, transitionId)`.
- Registered MCP tools (stdio + `/api/tools` + bridge). Tests mock the Jira client; keyless.

### 4.20 `move_issue_to_sprint` (v1.15 — move a ticket to another sprint; ADR-026)

Used by the Planning ticket list to move a ticket from its current sprint to a chosen active/future
sprint on the same board.

- **Input:** `{ ticketKey: string, sprintId: number }`.
- **Behavior:** reuses `addIssuesToSprint(sprintId, [ticketKey])`
  (`POST /rest/agile/1.0/sprint/{id}/issue { issues: [key] }`) — adding an issue to a sprint moves
  it out of any prior sprint. 404 → UPSTREAM. Real write.
- **Output:** `{ ticketKey, sprintId }`.
- Registered MCP tool (stdio + `/api/tools` + bridge). Tests mock the Jira client; keyless.

### 4.21 `get_impediments` / `set_impediments` (v1.16 — Huddle blockers store; ADR-027)

A manual, per-sprint list of impediments/blockers for daily Huddle visibility. Persisted to a
bridge-side JSON store (mirrors the leaves/team stores) — NOT a Jira object.

- **`get_impediments`** — **Input:** `{ sprintId: number }`. **Output:**
  `{ sprintId, impediments: Impediment[] }` (`[]` when none).
- **`set_impediments`** (full-replace) — **Input:** `{ sprintId: number, impediments: Array<{ id?: string; text: string; ticketKey?: string; createdAt?: string; resolved?: boolean }> }` (max 200).
  The tool fills `id` (uuid) and `createdAt` (now) when omitted. **Output:** `{ sprintId, impediments: Impediment[] }`.
- `Impediment = { id: string; text: string; ticketKey?: string; createdAt: string; resolved?: boolean }`.
- Store path from `JIRA_IMPEDIMENTS_FILE` (default `<mcp-jira>/.invokeboard-impediments.json`, git-ignored).
- Registered MCP tools. Tests use a temp file; keyless/offline.

### 4.22 `get_pull_requests` / `set_pull_requests` (v1.16 — Huddle code-review store; ADR-027)

A manual, per-sprint list of pending PR links for daily Huddle code-review visibility. Same
bridge-side JSON store pattern.

- **`get_pull_requests`** — **Input:** `{ sprintId: number }`. **Output:**
  `{ sprintId, pullRequests: PullRequest[] }` (`[]` when none).
- **`set_pull_requests`** (full-replace) — **Input:** `{ sprintId: number, pullRequests: Array<{ id?: string; url: string; title?: string; ticketKey?: string; status?: string; addedAt?: string }> }` (max 200).
  The tool fills `id` (uuid) and `addedAt` (now) when omitted. **Output:** `{ sprintId, pullRequests: PullRequest[] }`.
- `PullRequest = { id: string; url: string; title?: string; ticketKey?: string; status?: string; addedAt: string }`.
- Store path from `JIRA_PRS_FILE` (default `<mcp-jira>/.invokeboard-prs.json`, git-ignored).
- Registered MCP tools. Tests use a temp file; keyless/offline.
- **Auto-PRs (v1.20, frontend-only — no tool change):** the Huddle code-review card ALSO shows
  open GitHub PRs whose detected `jiraKeys` intersect the **current sprint's** ticket keys —
  fetched via the existing `list_prs` (mcp-github) and filtered client-side against the loaded
  sprint board. The manual `get/set_pull_requests` store remains as a supplement; when github is
  unavailable the card degrades to manual-only. ADR-031.

### 4.23 `get_post_scrum` / `set_post_scrum` (v1.20 — Huddle post-scrum tracking store; ADR-031)

A manual, per-sprint, per-person log of post-scrum notes ("parking-lot" follow-ups captured after
the daily standup, so they are tracked). Same bridge-side JSON store pattern as §4.21/§4.22 — NOT a
Jira object.

- **`get_post_scrum`** — **Input:** `{ sprintId: number }`. **Output:**
  `{ sprintId, notes: PostScrumNote[] }` (`[]` when none).
- **`set_post_scrum`** (full-replace) — **Input:** `{ sprintId: number, notes: Array<{ id?: string; person: string; note: string; createdAt?: string; resolved?: boolean }> }` (max 200).
  The tool fills `id` (uuid) and `createdAt` (now) when omitted. **Output:** `{ sprintId, notes: PostScrumNote[] }`.
- `PostScrumNote = { id: string; person: string; note: string; createdAt: string; resolved?: boolean }`.
- Store path from `JIRA_POST_SCRUM_FILE` (default `<mcp-jira>/.invokeboard-post-scrum.json`, git-ignored).
- Registered MCP tools (and exposed to the AI Q&A read-allowlist, §4.9). Tests use a temp file; keyless/offline.

### 4.24 `get_meeting_goal` / `set_meeting_goal` (v1.20 — Huddle meeting-goal store; ADR-031)

A single editable "goal for today's meeting" per sprint (the standup's focus), distinct from the
Jira **sprint** goal (§4.10b). Same bridge-side JSON store pattern.

- **`get_meeting_goal`** — **Input:** `{ sprintId: number }`. **Output:**
  `{ sprintId, goal: string, updatedAt: string | null }` (`goal: ""`, `updatedAt: null` when unset).
- **`set_meeting_goal`** — **Input:** `{ sprintId: number, goal: string }` (`goal` may be empty to clear).
  The tool stamps `updatedAt` (now). **Output:** `{ sprintId, goal: string, updatedAt: string | null }`.
- Store shape: `{ [sprintId]: { goal: string; updatedAt: string } }`.
- Store path from `JIRA_MEETING_GOAL_FILE` (default `<mcp-jira>/.invokeboard-meeting-goal.json`, git-ignored).
- Registered MCP tools (and exposed to the AI Q&A read-allowlist, §4.9). Tests use a temp file; keyless/offline.

### 4.25 `get_issue_pull_requests` (v1.22, ADR-034 — multi-repo PRs from Jira Development Information)

The team links PRs to Jira **automatically** by putting the uppercase issue key (e.g. `VRDB-123`) in
the branch name / commit message / PR title — the *GitHub for Jira* app then attaches the PR to that
issue's **Development** panel. This tool reads those linked PRs **per issue, across all repos** —
unlike `list_prs` (§5.1), which enumerates a single `GITHUB_REPO`. It also carries reviewer/approval
data, so the Huddle's code-review card uses it for both the PR list and the approval badge.

- **Input:** `{ keys: string[] (1–50 issue keys) }`.
- **Behavior:** for each key, resolve the numeric issue id (`GET /rest/api/3/issue/{key}?fields=*none`)
  then read `GET /rest/dev-status/1.0/issue/detail?issueId={id}&applicationType={JIRA_DEV_STATUS_APP_TYPE}&dataType=pullrequest`
  and reduce its `detail[].pullRequests[]` with a pure parser. Per-key failures (404, no dev data) →
  `[]` (resilient, like `get_linked_issues`); fetched in parallel. **Read-only.**
  > ⚠️ `/rest/dev-status/…` is an **undocumented** Jira endpoint (the one powering the Development
  > panel). Parsed defensively; the exact shape is confirmed against a live Jira before release.
- **Per-PR mapping → `LinkedPr`:**
  ```ts
  type ReviewDecision = "approved" | "changes_requested" | "review_required";
  interface LinkedPr {
    url: string; title: string; repo: string;        // repo "owner/name" or "" when absent
    status: "open" | "merged" | "declined" | "unknown";
    decision: ReviewDecision;                          // from reviewers' approvalStatus
    approvals: number;                                 // reviewers with approvalStatus APPROVED
    reviewers: string[];                               // approving reviewer display names
    lastUpdate?: string;
  }
  ```
  `decision` = `changes_requested` if any reviewer status is `CHANGES_REQUESTED`/`NEEDS_WORK`, else
  `approved` if any is `APPROVED`, else `review_required`.
- **Output:** `{ pullRequests: Record<string /*issue key*/, LinkedPr[]> }`.
- **Config:** `JIRA_DEV_STATUS_APP_TYPE` (default `"GitHub"`; `"GitHubEnterprise"` for GHE).
- Registered MCP tool (stdio + `/api/tools` + bridge). jira tools **31 → 32**.

### 4.26 `get_offset_ledger` / `set_offset_for_sprint` / `set_offset_adjustment` / `add_offset_adjustment` / `delete_offset_adjustment` (v1.26, ADR-038; v1.54, ADR-065 — offset ledger)

Per-developer offset-point tracking, backed by a bridge-side JSON store (`JIRA_OFFSET_FILE`, default
`<mcp-jira>/.invokeboard-offset.json`, git-ignored). Store shape:
`{ [assignee]: { bySprint: { [sprintId]: { earned, spent } }, manualAdjust, adjustments?: OffsetAdjustment[] } }`,
where **`OffsetAdjustment = { id, amount: number (non-zero, ±), note?: string, createdAt: ISO }`** (v1.54).
**All offset amounts are DECIMAL-capable (v1.55, ADR-066)** — `earned`, `spent`, `manualAdjust`, and each
`adjustments[].amount` accept fractional values (e.g. credit 0.5), since teams credit half-points. The UI
formats every offset figure with `formatPoints` (≤ 2 dp, trailing zeros trimmed) so sums never show float
noise. **Ways to adjust the balance**: a per-sprint snapshot (**banked on user confirm** since v1.50 — see
below); a single **manual** delta the UI surfaces as each developer's **opening balance** (prior/carry-in);
and (v1.54, ADR-065) a **log of ad-hoc manual adjustments** (`adjustments[]`), each a signed entry with an
optional note, managed from the Offset History dialog — distinct from the one-time opening.
**`balance = Σ earned − Σ spent + manualAdjust + Σ adjustments.amount`** (pure `summarizeOffset`).

- **`get_offset_ledger`** — Input `{}`. Output `{ entries: Record<assignee, { earned, spent, manualAdjust,
  balance, bySprint, adjustments }> }`. `bySprint: { [sprintId]: { earned, spent } }` (v1.50) lets the UI
  show whether a sprint's offsets are already banked + plot per-sprint EARNED history; `adjustments:
  OffsetAdjustment[]` (v1.54) is the manual-adjustment log (newest-first).
- **`set_offset_for_sprint`** — Input `{ sprintId, entries: Array<{ assignee, earned ≥ 0, spent ≥ 0 }> }`
  (earned/spent are decimal-capable numbers). **Idempotent** upsert of that sprint's `{ earned, spent }` per
  assignee (re-recording never double-counts). **v1.50 (ADR-061):** the Leaves page calls this only when the
  user **confirms** the "Bank earned offsets" dialog (was auto-on-view). Output the updated `entries` summary.
- **`set_offset_adjustment`** — Input `{ assignee, manualAdjust: number }` — set the single manual delta
  (the UI's **opening balance**, decimal-capable). Output the updated `entries` summary.
- **`add_offset_adjustment`** (v1.54, ADR-065) — Input `{ assignee, amount: number (non-zero, decimal ok),
  note?: string ≤ 200 }` — APPEND a manual adjustment (server assigns `id` + `createdAt`). Output the updated
  `entries` summary. `400 VALIDATION` when `amount` is 0.
- **`delete_offset_adjustment`** (v1.54, ADR-065) — Input `{ assignee, id }` — remove that adjustment by id
  (no-op if absent). Output the updated `entries` summary.
- **Offset policy** (`GET /api/health` `.policy = { requiredPoints, offsetThreshold }`, from
  `JIRA_REQUIRED_POINTS` (N) + `JIRA_OFFSET_THRESHOLD` (N2)). The UI computes earned =
  `(donePoints + leaveDays) ≥ (N + N2) ? 1 : 0` (**max 1/sprint**).
- Registered MCP tools. jira tools **40 → 42** (v1.54 adds `add_offset_adjustment` +
  `delete_offset_adjustment`). Tests use a temp store; keyless/offline.

### 4.27 `get_meeting_notes` / `set_meeting_notes` (v1.41, ADR-051 — Huddle rich meeting notes)

Free-form **rich-text meeting notes per sprint** (deployment notes, links, checklists) shown on the
Huddle sidebar with a WYSIWYG editor. Same bridge-side JSON store pattern as §4.23/§4.24. The value
is an **HTML string** (produced by the app's TipTap editor); the store is content-agnostic — the
React app sanitizes with DOMPurify **both on save and on render** (the server does not parse HTML).

- **`get_meeting_notes`** — **Input:** `{ sprintId: number (int > 0) }`. **Output:**
  `{ sprintId, notes: { html: string, updatedAt: string } | null }` (`null` when never set/cleared).
- **`set_meeting_notes`** — **Input:** `{ sprintId: number (int > 0), html: string (≤ 100000) }`.
  An **empty/whitespace-only `html` clears the entry** (subsequent `get` → `notes: null`). The tool
  stamps `updatedAt` (now). **Output:** same shape as `get_meeting_notes`.
- Store shape: `{ [sprintId: string]: { html: string; updatedAt: string } }`.
- Store path from `JIRA_MEETING_NOTES_FILE` (default `<mcp-jira>/.invokeboard-meeting-notes.json`,
  git-ignored).
- Registered MCP tools; `get_meeting_notes` joins the AI Q&A read-allowlist (§4.9). jira tools
  **36 → 38**. Tests use a temp file; keyless/offline.

### 4.28 `get_retro` / `set_retro` (v1.42, ADR-052 — persisted retrospective)

The sprint retrospective, written once on the Reports page and **pre-filled into the Full-report
export** (no more retyping at export time). Same bridge-side JSON store pattern.

- **`get_retro`** — **Input:** `{ sprintId: number (int > 0) }`. **Output:**
  `{ sprintId, retro: { reasonForDelays, whatWorkedWell, whatDidNotWork, plannedImprovements,
  kudos, updatedAt } | null }`.
- **`set_retro`** — **Input:** `{ sprintId, reasonForDelays?, whatWorkedWell?, whatDidNotWork?,
  plannedImprovements?, kudos? }` (each string ≤ 4000, defaults `""`; values are trimmed).
  **All-empty fields clear the entry** (subsequent `get` → `retro: null`). Stamps `updatedAt`.
  **Output:** same shape as `get_retro`.
- Store shape: `{ [sprintId: string]: RetroEntry }`; path from `JIRA_RETRO_FILE` (default
  `<mcp-jira>/.invokeboard-retro.json`, git-ignored).
- Registered MCP tools; `get_retro` joins the AI Q&A read-allowlist (§4.9, 18 read tools).
  jira tools **38 → 40**. Tests use a temp file; keyless/offline.

### 4.29 `get_multi_sprint_report` (v1.59, ADR-071 — multi-sprint report + velocity KPIs)

One aggregated report across a WINDOW of sprints — the data source for the Reports page's
"Trends & KPIs" mode (team + per-developer velocity & trend). Follows `get_velocity`'s cheap
pattern: pool sprints once, then ONE `getSprintIssues(id, maxResults)` call per sprint in parallel,
reusing `reportMath.ts` (`makeDodPredicate`/`computeSprintPoints`/`computeByAssignee`) verbatim —
`byAssignee` is free CPU on the same fetched issues. Never fetches changelogs (§4.3's aging is
`get_active_sprint`-only).

- **Input:** `{ boardId?: number, sprintCount?: number (1..26, default 10), beforeSprintId?: number,
  sprintIds?: number[] (1..26 entries), includeActive?: boolean (default false),
  maxResults?: number (per-sprint issue cap, default 200) }`.
  **`sprintIds` is mutually exclusive with `sprintCount`/`beforeSprintId`** → `400 VALIDATION`
  (ZodObject base schema + `.refine` in the handler — the set_leaves pattern). Date-range selection
  is a CLIENT concern: the UI filters `list_sprints` (which already returns start/end/complete dates)
  and sends concrete `sprintIds`.
- **Sprint selection:** with `sprintIds` → `Promise.all(getSprintMeta)` for each id, sorted
  chronologically by `startDate` (asc, nulls last). Without → the `get_velocity` pool: closed
  sprints (+ active when `includeActive`), sorted latest-first by `completeDate ?? endDate`
  (shared `sortClosedSprintsLatestFirst` in `sprintSelect.ts` — extracted from the previously
  duplicated getVelocity/listSprints sort), optional strict-before `beforeSprintId` anchor
  (one `getSprintMeta` call), then `slice(0, sprintCount)`.
- **Per sprint:** `computeSprintPoints` + `computeByAssignee` (same DoD predicate as
  `get_sprint_report`: done OR code-review) + counts (`totalCount`, `completedCount`,
  `carryoverCount = total − completed`, `blockedCount`).
- **Output:**
```ts
{
  boardId: number;
  sprintCount: number;                    // sprints actually included
  sprints: Array<{                        // chronological oldest → newest
    sprint: SprintRef;                    // id/name/state/startDate/endDate/completeDate/goal/boardId
    committedPoints: number; completedPoints: number; completionRate: number;
    totalCount: number; completedCount: number; carryoverCount: number; blockedCount: number;
    byAssignee: AssigneeStats[];          // §4.12 shape, per sprint
  }>;
  totals: { committedPoints: number; completedPoints: number };
  averageCompleted: number;               // totals.completedPoints / sprintCount (0 when empty)
  averageCompletionRate: number;          // mean of per-sprint completionRate (0 when empty)
  byAssignee: Array<{                     // aggregated across the window, donePoints desc
    name: string; sprintsActive: number;  // sprints where the person had ≥1 issue
    donePoints: number; totalPoints: number;
    avgDonePoints: number;                // donePoints / sprintCount — FULL window (velocity convention)
  }>;
}
```
- Empty pool/window → the empty-but-valid shape (all zeros, empty arrays) — NOT an error
  (`get_velocity` convention).
- Registered MCP tool; joins the AI Q&A read-allowlist (§4.9, 18 → **19** read tools).
  jira tools **42 → 43** (smoke expected-tools list +1; NOT in the empty-input-validation smoke
  loop — all fields optional, `{}` is valid, same class as `get_velocity`). Keyless/offline tests.

### 4.30 `get_draft_plan` / `set_draft_plan` (v1.68, ADR-079 — PO draft capacity plan)

A PO-side DRAFT plan splitting a PO sprint's tickets across Dev-board team members, used by the
Planning page's "Draft Capacity Plan" card to sanity-check ticket load against per-developer
capacity. Same bridge-side store pattern as §4.21 (json | sqlite via the storage port, ADR-077) —
NOT a Jira object. **Draft only: these tools NEVER write to Jira** — not the assignments, not the
per-share points. Real assignment remains `assign_issue` (§4.15) and real ticket/points/status
edits remain `update_ticket`/`transition_issue`/`move_issue_to_sprint` from the **Assign Tickets**
surface (Dev-board Planning/Linking).

**v1.70 (ADR-081): a ticket may be split across MULTIPLE developers**, each carrying a DRAFT slice
of the points ("breakdown points" — a big story is usually shared work). So an issue key now maps
to an ARRAY of shares, not one member. The `points` on a share is a draft figure only (defaults to
the ticket's real Jira points when drafted whole; over/under-allocation vs the real points is
allowed and never enforced — capacity is advisory, ADR-079).

```ts
export interface DraftShare { accountId: string; displayName: string; points: number }
```

- **`get_draft_plan`** — **Input:** `{ sprintId: number }` (the PO sprint). **Output:**
  `{ sprintId: number; devSprintId: number | null; assignments: Record<string /*issueKey*/, DraftShare[]> }`
  (no draft saved → `{ sprintId, devSprintId: null, assignments: {} }`).
- **`set_draft_plan`** (full-replace per sprint) — **Input:**
  `{ sprintId: number; devSprintId?: number | null; assignments: Record<string, Array<{ accountId: string (1+); displayName: string (1+); points: number (≥ 0) }>> }`.
  Constraints (→ else `400 VALIDATION`): ≤ 300 issue keys; every key matches the §4.4 ticketKey
  regex; each key's share array has 1–50 entries and is **de-duped by `accountId`** (a developer
  appears at most once per ticket — last write wins); an **empty share array for a key is invalid**
  (omit the key to leave a ticket undrafted). Replaces the sprint's whole draft; `devSprintId`
  omitted → stored `null`. Empty `assignments` with `devSprintId` null/omitted **deletes** the
  sprint's entry. **Output:** the updated `{ sprintId, devSprintId, assignments }`.
- Store name `draft-plan` — env `JIRA_DRAFT_PLAN_FILE` (§3), default
  `<mcp-jira>/.invokeboard-draft-plan.json`, git-ignored. Registered in `storage/registry.ts`
  (`SHARED_STORE_NAMES` + override map) so the json `*_FILE` override and the sqlite auto-import
  both apply (ADR-077). Store shape:
  `{ "<sprintId>": { "devSprintId": number | null, "assignments": { "<issueKey>": DraftShare[] } } }`.
  **Legacy read migration (v1.68→v1.70):** `readDraftPlans()` normalizes any pre-v1.70 single-object
  value (`{ accountId, displayName }`) to a one-element array `[{ accountId, displayName, points: 0 }]`
  — no crash, no data loss beyond the (previously nonexistent) point split. Helpers in
  `src/lib/draftPlanStore.ts` (`readDraftPlans()`/`writeDraftPlans()`, missing/corrupt → `{}`).
- Both registered MCP tools (unchanged count: jira tools **45**); `get_draft_plan` remains on the
  AI Q&A read-allowlist (§4.9, **20** read tools). Tests point `JIRA_DRAFT_PLAN_FILE` at a temp path;
  keyless/offline; cover multi-share round-trip, per-ticket accountId de-dupe, points validation,
  empty-array-key → VALIDATION, the legacy single-object → array migration, full-replace,
  clear-deletes-entry, bad issue key → VALIDATION, missing/corrupt-file tolerance.

### 4.31 `link_dev_to_po` (v1.72, ADR-083 — link an EXISTING Dev ticket to an EXISTING PO story)

**WRITE.** Before v1.72 a PO↔Dev link could only be born inside `create_dev_ticket` (§4.2), so a
Dev ticket that already existed could never be attached to its PO story. This tool is that
missing write path, and it is what the Linking page's **"Link existing"** and **"New PO from Dev
tasks"** modes (§6) both call.

**One pair per call — the client loops**, exactly as §6 already specifies for `create_dev_ticket`
("No new bulk MCP tool"). Per-item ✓/✗, the live status log, and "Retry failed" therefore work
unchanged. Deliberately **not** a generic `link_issues({ inwardKey, outwardKey })`: the direction
invariant below is the most error-prone thing in this subsystem (it shipped backwards once and
was swapped in v1.42), and a generic tool re-exports that trap to every caller, including Copilot
over stdio which has no UI to get it right.

- **Input:** `{ poKey: string, devKey: string }` — both must match the §4.4 ticketKey regex
  `/^[A-Z][A-Z0-9]{1,9}-\d+$/`, and `poKey !== devKey` (a self-link is `400 VALIDATION`).
- **Behavior:**
  1. **Dedupe pre-check (non-fatal).** Read `getLinkedIssues(poKey)` and look for a link whose
     other key is `devKey` **and** whose `linkTypeName` is the configured `JIRA_LINK_TYPE`. A hit
     returns `{ created: false, alreadyLinked: true, linkId }` **without POSTing**. The match
     deliberately **ignores direction**: a pre-v1.42 reversed link is still a link, and stacking
     the canonical one on top would leave two rows asserting opposite dependencies — that case
     returns `reversed: true` so the UI can label it. If this read throws, set `precheckWarning`
     and **continue to step 2** — a broken read must never block a legitimate write.
  2. `POST /rest/api/3/issueLink` with
     `{ "type": { "name": "<JIRA_LINK_TYPE>" }, "inwardIssue": { "key": "<poKey>" }, "outwardIssue": { "key": "<devKey>" } }`
     — **PO is the inward side, Dev the outward side**, identical to §4.2 and for the same
     live-verified reason (the inward issue displays the type's OUTWARD description, so this
     reads "PO story depends on Dev task"). Unlike §4.2, a link failure here **throws** (`502
     UPSTREAM`) rather than degrading to a warning: in §4.2 the link is a side-effect of a
     successful create, whereas here the link **is** the operation.
- **Output:** `{ poKey: string; devKey: string; linkTypeName: string; created: boolean;
  alreadyLinked: boolean; linkId: string | null; reversed?: boolean; precheckWarning?: string }`
- **`linkId` is non-null ONLY on the `alreadyLinked` path.** Jira's `POST /rest/api/3/issueLink`
  answers **201 with an empty body** — the new link's id is not returned. Rather than spend N
  extra GETs reading it back, the caller refetches `get_linked_issues` **once** after its bulk
  loop (it must refetch anyway to refresh every row's badge consistently).
- **Idempotency caveat, deliberate and documented:** Jira's REST API has historically *permitted*
  duplicate links between the same pair with the same type even though the web UI blocks them,
  and the 201-empty-body response cannot reveal it. **Do not rely on Jira deduping** — the step-1
  pre-check is the guarantee.
- **Known asymmetry:** `JIRA_LINK_TYPE` is per-user overridable (§9), so dedupe — which filters on
  key **+ the current user's configured type** — cannot see a link created under a different type.
  The UI compensates by badging "already linked" for links of **any** type (showing
  `linkTypeName`); only the skip-the-POST decision is type-scoped. This is intended, not a bug.
- New jiraClient surface: none — reuses `createIssueLink` (§4.2) and `getLinkedIssues` (§4.17).
- Registered MCP tool (stdio + `/api/tools` + bridge) **and added to `JIRA_WRITE_TOOLS`**
  (§9.8.2) — it mutates Jira, so a shared-credential read-only user must get `403 READ_ONLY_USER`.
  Not added to the AI Q&A write-allowlist (§4.9): the assistant has no linking workflow and each
  proposal surface needs its own confirmation copy. Tests mock the Jira client; keyless.

### 4.32 `unlink_dev_from_po` (v1.72, ADR-083 — remove a PO↔Dev link)

**WRITE.** The counterpart to §4.31 — a mis-link had to be fixed in Jira directly before v1.72.

- **Input:** `{ linkId: string (1+), poKey?: string, devKey?: string }`. The two keys are an
  optional **guard**; the Linking UI always sends them.
- **Behavior:**
  1. **Guard (only when both keys are supplied).** Read `getLinkedIssues(poKey)`:
     no link with that `linkId` → `{ deleted: false, alreadyGone: true }` with **no DELETE
     issued**; a link with that `linkId` whose other key is **not** `devKey` → throw an
     `UpstreamError(…, 409)` carrying the message `Link <id> does not connect <poKey> and
     <devKey> — refresh and try again`. A stale UI must never delete an unrelated link.
     **On the wire this surfaces as `502 UPSTREAM`** — the bridge maps every `UpstreamError`
     to 502 regardless of its `status` field (§2), so the 409 is an internal marker, not the
     HTTP status. The message is what the UI shows.
  2. `DELETE /rest/api/3/issueLink/{linkId}` → 204. A **404 is treated as success**
     (`{ deleted: false, alreadyGone: true }`), matching §4.17's "missing key → `[]`" resilience
     convention; Jira returns 404 both when the link is already gone and when the caller cannot
     see it, and the two are indistinguishable. A 403 (caller lacks Jira's *Link Issues*
     permission — reachable even for a user who passes our own write gate) surfaces Jira's
     message verbatim as `502 UPSTREAM`.
- **Output:** `{ linkId: string; deleted: boolean; alreadyGone: boolean; poKey?: string; devKey?: string }`
- `linkId` is a **string** in Jira's payload — never parse it as a number.
- New jiraClient helper `deleteIssueLink(linkId): Promise<boolean>` (false on 404), beside
  `createIssueLink`.
- Registered MCP tool (stdio + `/api/tools` + bridge) **and added to `JIRA_WRITE_TOOLS`**
  (§9.8.2). Not on the AI Q&A allowlists. Tests mock the Jira client; keyless.

## 5. mcp-github tools (Phase 2) — exact IO

```ts
export interface PrSummary {
  number: number; title: string; author: string;
  branch: string; baseBranch: string;
  state: "open" | "closed" | "merged"; draft: boolean;
  url: string;                          // html_url
  jiraKeys: string[];                   // detected (§5.5)
}
```

**`state` derivation:** For a GitHub PR object, `state` is `"merged"` if `merged_at != null`
(regardless of GitHub's `state` field value), `"open"` if GitHub `state === "open"`,
`"closed"` if GitHub `state === "closed"` and `merged_at == null`.

### 5.1 `list_prs`
- **Input:** `{ repo?: string ("owner/name", default GITHUB_REPO), state?: "open" | "closed" | "all" (default "open") }`
  When `repo` is omitted and `GITHUB_REPO` is not set, return a `VALIDATION` error:
  `"repo is required when GITHUB_REPO env variable is not set"`.
- **Behavior:** `GET /repos/{owner}/{repo}/pulls?state={state}&per_page=50`.
  Apply `state` derivation above to each PR. When input `state` is `"open"`, pass
  `state=open` to GitHub (merged PRs will not appear). When `"closed"`, pass `state=closed`
  (both closed and merged PRs are returned; apply derivation). When `"all"`, pass
  `state=all`.
- **Output:** `{ repo: string; prs: PrSummary[] }`

### 5.2 `get_pr`
- **Input:** `{ repo?: string, number: number }`
  Same `repo` fallback and missing-repo error as §5.1.
- **Behavior:** `GET /repos/{owner}/{repo}/pulls/{number}`.
  A 404 from GitHub returns `UPSTREAM` error `"PR #<number> not found in <repo>"`.
- **Output:** `PrSummary & { body: string | null; mergeable: boolean | null; headSha: string }`

### 5.3 `link_pr_to_ticket`
- **Input:** `{ repo?: string, number: number, ticketKey?: string }`
  Same `repo` fallback and missing-repo error as §5.1.
  When `ticketKey` is omitted, auto-detect from the PR (§5.5). Zero detected keys →
  `VALIDATION` error: `"No Jira ticket key found in PR #<n>. Pass ticketKey explicitly."`.
- **Behavior:** for each ticket key:
  1. Jira remote link: `POST /rest/api/3/issue/{key}/remotelink` with
     `{ globalId: prUrl, object: { url: prUrl, title: "GitHub PR #<n>: <title>" } }`
     (`globalId` makes it idempotent — Jira upserts on globalId match).
  2. GitHub PR comment: First `GET /repos/{owner}/{repo}/issues/{number}/comments`.
     If no existing comment body contains the Jira browse URL for this key, post:
     `POST /repos/{owner}/{repo}/issues/{number}/comments`
     with body `"🔗 Linked to Jira: <browse url>"`.
     If a comment already contains the browse URL, set `commentPosted: false` (idempotent).
  Per-key failures are captured into `error` field, not thrown; other keys continue.
- **Output:**
  ```ts
  {
    prUrl: string;
    results: Array<{
      ticketKey: string;
      remoteLinkCreated: boolean;
      commentPosted: boolean;
      error?: string;
    }>;
  }
  ```

### 5.4 `sync_pr_links`
- **Input:** `{ repo?: string }` — same repo fallback and missing-repo error as §5.1.
- **Behavior:** list open PRs (`state: "open"`), auto-detect Jira keys for each,
  run §5.3 linking logic for each PR that has at least one detected key.
  PRs with zero detected keys go into `skipped` with `reason: "no Jira keys detected"`.
- **Output:**
  ```ts
  {
    repo: string;
    linked: Array<{ number: number; ticketKeys: string[] }>;
    skipped: Array<{ number: number; reason: string }>;
  }
  ```

### 5.6 `get_pr_reviews` (v1.21, ADR-033 — approval status of Jira-linked PRs)
- **Input:** `{ repo?: string, numbers: number[] (1–50, positive ints) }`
  Same `repo` fallback and missing-repo error as §5.1.
- **Behavior:** for each number, `GET /repos/{owner}/{repo}/pulls/{number}/reviews?per_page=100`
  and reduce to a decision (pure `summarizeReviews`): each reviewer's **latest meaningful** vote
  wins — `APPROVED` / `CHANGES_REQUESTED` / `DISMISSED` override earlier votes; `COMMENTED` and
  `PENDING` are ignored; `DISMISSED` clears that reviewer's vote. `decision` = `"changes_requested"`
  if any active CHANGES_REQUESTED, else `"approved"` if any active APPROVED, else
  `"review_required"`. Fetched in parallel; a PR that 404s is **omitted** from the result map (not
  fatal) — mirrors `get_linked_issues` resilience. Read-only (no writes).
- **Output:** `{ repo: string; reviews: Record<number, PrReviewStatus> }` where
  ```ts
  type ReviewDecision = "approved" | "changes_requested" | "review_required";
  interface PrReviewStatus {
    decision: ReviewDecision;
    approvals: number;          // distinct reviewers whose latest vote is APPROVED
    changesRequested: number;   // distinct reviewers whose latest vote is CHANGES_REQUESTED
    reviewers: string[];        // logins of approving reviewers
  }
  ```
- **Consumer:** the Huddle code-review card calls this with the numbers of the auto-listed,
  current-sprint-linked open PRs (§4.22) and shows an approval badge per PR. The aggregate is a
  dependency-free approximation of GitHub's review decision (no CODEOWNERS/required-reviewer logic).

### 5.5 Jira key detection (`src/lib/jiraKeys.ts`)
Regex `/\b([A-Z][A-Z0-9]{1,9}-\d+)\b/g` over PR **title + head branch name + body**
(concatenated with spaces; body may be null — treat null as empty string).
If `JIRA_PO_PROJECT_KEY` and/or `JIRA_DEV_PROJECT_KEY` are configured (non-empty),
keep only keys whose project prefix matches one of those values. If neither is configured,
keep all detected keys.
Dedupe, preserve first-seen order. Pure function, unit-tested. No side effects.

## 6. react-app

- `src/lib/mcpClient.ts` — typed client:
  ```ts
  export interface McpError { code: string; message: string; issues?: unknown[] }
  export function callTool<T>(
    server: "jira" | "github",
    name: string,
    input: unknown
  ): Promise<T>
  ```
  POSTs to the bridge at `VITE_MCP_JIRA_URL` or `VITE_MCP_GITHUB_URL` (defaulting to
  `http://localhost:4001` / `http://localhost:4002`), unwraps the `{ ok, data }` envelope,
  throws `McpError` on `ok: false`. On network failure (fetch throws), throw
  `McpError { code: "BRIDGE_DOWN", message: "Cannot reach <server> bridge — run: npm run dev" }`.
- `src/lib/aiClient.ts` (v1.1, +v1.4) — typed client for §4.9:
  ```ts
  export interface AiStatus { enabled: boolean; provider: string | null; model: string | null }
  export function getAiStatus(): Promise<AiStatus>           // GET jira /api/health → .ai (absent → disabled)
  export function aiDraftTickets(body: DraftRequest): Promise<DraftResponse>
  export function aiEnhanceTicket(body: EnhanceRequest): Promise<EnhanceResponse>
  export function aiSprintSummary(body: SprintSummaryRequest): Promise<SprintSummaryResponse>  // v1.4
  ```
  Same envelope/unwrap/error semantics as `mcpClient` (incl. `BRIDGE_DOWN`); an
  `ok: false` with code `AI_UNAVAILABLE` throws `McpError` with that code so callers can
  branch to the deterministic fallback / hide the AI summary.
- Hooks: `useMCP` (generic `{ data: T | null; error: McpError | null; loading: boolean; run: () => void }`),
  plus typed wrappers in `src/hooks/useJira.ts` (`useActiveSprint(boardId?, sprintId?)`,
  `useDailyHuddle(boardId?, sprintId?)`, `createTicketPair`, `enhanceTicket`, and v1.4:
  `createSprint`, `useSprintList(state?)`, `useSprintReport(sprintId)`,
  `useVelocity(beforeSprintId?)` (v1.5 — passes the selected sprint), v1.5:
  `useLeaves(sprintId)`, and v1.8: `useTeamMembers(boardId?)`, `useRecentAssignees(boardId?)`,
  `saveTeamMembers(boardId, members)`) and `src/hooks/useGithub.ts` (`usePrs`, `linkPr`).
- **Board context (v1.6, ADR-017):** `src/lib/boards.ts` — `getBoards(): Promise<{ dev, po }>`
  reads `GET /api/health` (jira) `.boards`; a `useBoards()` hook (or a tiny context) exposes
  them. A **Board toggle** (a small segmented control / `<select>` "Board: Dev / PO") appears
  on the **Dashboard** and the **Reports** page, defaulting to **Dev**. The selected board's
  numeric `id` is passed as the `boardId` to every board-scoped call on that page
  (`get_active_sprint`, `get_daily_huddle`, `list_sprints`, `get_sprint_report`,
  `get_velocity`, `create_sprint`). Changing the board resets sprint selection + filters and
  refetches. If `boards` is absent from health (older bridge), hide the toggle and behave as
  Dev-only. A board with **no active/future sprints** (e.g. a Kanban PO board) shows a
  friendly empty state ("No sprints on the PO board"), not a hard error — map the
  `UPSTREAM`/"No active or future sprint" case to that empty state.
- **Tab nav (v1.7, ADR-018; v1.11):** **Dashboard · Planning · Linking · Reports**. The old
  "Ticket Generator" tab is REMOVED — its functionality moved into **Planning**. **Linking
  (v1.11, ADR-022)** is a new tab for bulk PO→Dev ticket creation (below).
- **Shared board + sprint context (v1.13, ADR-024).** `App` owns `selectedBoardKey` and a
  shared `sprintId: number | null` and threads them to **Dashboard / Planning / Reports** as
  optional controlled props `{ boardKey, sprintId, onBoardChange, onSprintChange }`. Each page
  is **controlled when the props are present, uncontrolled otherwise** (so a page rendered
  standalone — e.g. in tests — keeps its own state). The shared sprint is an **explicit pick**:
  a page shows `sharedSprintId ?? itsOwnPerCeremonyDefault` (Dashboard→active, Planning→next
  future, Reports→latest closed), so defaults still differ per ceremony, but once the user
  picks a sprint it **follows them across tabs**. Changing the board resets the shared sprint to
  `null` (each page re-defaults for the new board). **Linking** keeps its own dual-board (PO
  source + Dev target) selectors — it is not part of the shared single-sprint context.
- Pages (react-router not required — a simple state-based tab nav is fine):
  - **Planning (v1.7, ADR-018) — the sprint-preparation / grooming workspace.** A
    board-and-sprint-scoped page that consolidates the prep actions:
    - **Board + sprint context:** a Board toggle (Dev/PO, from `useBoards`, default Dev) and
      a sprint picker (from `list_sprints` active+future on the selected board). **Default
      target = the next future sprint** (first of `futureSprints`); if none, the active
      sprint. Changing board re-defaults the target.
    - **New Sprint (moved from Dashboard):** the `CreateSprintDialog` lives here (creates a
      future sprint on the selected board → selects it as the planning target). It is
      REMOVED from the Dashboard.
    - **Sprint goal editor (v1.13, ADR-024):** the planning-context header shows the selected
      sprint's **goal** with an inline edit (textarea + Save) that calls `set_sprint_goal({
      sprintId, goal })` and refreshes; empty clears it. This is where the Scrum Master keeps the
      goal current (the Dashboard banner then reflects it).
    - **Ticket generation (moved from the Ticket Generator tab):** the full TicketGen
      experience (AI chat + fallback templates + "Use AI drafting" + editable PO/Dev draft
      previews + create) is embedded here, reusing the existing component. The **target
      sprints pre-seed from the planning context** — the current board's planned sprint is
      pre-selected for that board's ticket (PO planned sprint → PO Story, Dev planned sprint
      → Dev Task), still overridable via the two sprint selects (v1.6). All prior TicketGen
      behavior is preserved. **Comment & regenerate (v1.12, ADR-023):** the AI draft preview
      gets a **comment box + "Regenerate"** button (AI mode only) that appends the comment to the
      conversation and re-calls `POST /api/ai/draft-tickets`, refreshing the PO+Dev pair — the
      same shared `RefineDraftControl` used on the Linking page.
    - **(v1.11, ADR-022) — "Create Dev ticket for an existing PO story" MOVED OFF Planning** to
      the new **Linking** page (below), which generalises it to **bulk** creation. The
      single-PO `LinkDevTicketCard` is removed.
    - **Team roster (v1.8, ADR-019) — the source of truth for who appears.** Both the leaves
      plotter and the assignment dropdown roster from the **curated per-board team**
      (`useTeamMembers(boardId)`), NOT the org-wide assignable list. A **"Manage team"**
      control (button → dialog, or an inline editor) shows the current roster with **remove**
      buttons and TWO add affordances: (a) **"Add from recent activity"** — calls
      `get_recent_assignees` (the "usual members" — distinct assignees recently assigned across
      the **whole board**, incl. the active sprint, with ticket counts) for one-click / per-person
      add; and (b) **"Search all people" (v1.9, ADR-020)** — a search box over the **full**
      assignable list (`useAssignableUsers(boardId)` → `get_assignable_users`), filtered
      client-side by name, so ANY person can be added even if they have no recent tickets (the
      recent list is no longer a ceiling). Already-on-team people are marked in both lists.
      Changes persist via `set_team_members(boardId, members)`. **First-run (empty roster):** a clear
      "Set up your team — add the usual members from recent activity" prompt that one-click
      seeds from `get_recent_assignees`. The roster is keyed by board (Dev vs PO teams differ).
    - **Leaves / capacity plotting (moved from Reports, v1.5/ADR-016):** the editable leaves
      calendar for the planned sprint, **rostered from the curated team** (`useTeamMembers`) —
      plot leaves for any team member regardless of current sprint assignment (key for a
      near-empty future sprint). Persists via `set_leaves`/`get_leaves`. Shows the
      capacity-adjusted "possible committed velocity" (`capacity.ts` + the board's
      `get_velocity` average). The **Reports** page ALSO has an **editable** leaves calendar
      (v1.8.1 — user request) for its selected sprint, rostered from that sprint's assignees;
      both pages persist to the same `set_leaves`/`get_leaves` store keyed by sprintId.
    - **Assign tickets to developers (NEW, v1.7; v1.8 roster fix):** a list of the planned
      sprint's tickets (from `get_active_sprint(boardId, sprintId)` across all buckets). Each
      row: ticket (key→Jira link, summary, points, current assignee initials) + an **assignee
      `<select>`** populated from the **curated team** (`useTeamMembers`) + "Unassigned".
      Pre-select the current assignee by `assigneeAccountId`. **v1.9 (ADR-020) — no off-team
      restriction:** if the current assignee is not in the team, include them as a **normal,
      selectable** option (their plain display name) so the assignment is preserved AND can be
      re-selected — the prior disabled "(not on team)" lock is removed (user request). The
      dropdown is still **Unassigned + curated team** (+ the current off-team assignee when
      present); it does NOT list the org-wide roster (use "Manage team → Search all people" to
      add someone first). Changing it calls `assign_issue(ticketKey, accountId|null)`
      (optimistic; refetch on success; inline per-row error, non-blocking). A future sprint with
      no tickets → "Add tickets above, then assign them". An **empty team** → a note pointing to
      "Manage team".
    - New `src/hooks`/`src/lib`: `teamClient.ts` (`getTeamMembers`/`setTeamMembers`/
      `getRecentAssignees`), `useTeamMembers(boardId)`, `useRecentAssignees(boardId)`; a
      `TeamManager` component. `useAssignableUsers` powers the v1.9 **"Search all people"**
      add box in TeamManager. Reuse `useLeaves`, `capacity.ts`, `useActiveSprint`. a11y + states.
  - **Linking (page, v1.11 — ADR-022; 3 modes since v1.72 — ADR-083)** — the PO↔Dev link surface.
    `pages/Linking.tsx` is a **shell**: it owns the boards/sprint-list/team/AI-status hooks, the
    `poSprintId`/`devSprintId`/`mode` state, the shared sprint-context card, a 3-way mode toggle
    (`role="group"`, `aria-pressed` buttons — same pattern as the Reports mode toggle), the
    bridge-offline alert, and a 3-way render switch. **No flow logic lives in the shell**; each
    mode is its own component under `src/components/linking/`.

    **Mode-dependent sprint-select semantics** (the two selects are shared across modes):

    | mode | PO select | Dev select |
    |---|---|---|
    | `create-dev` (default) | source — active+future+closed | **target** — active+future, "Backlog / no sprint" |
    | `link-existing` | source — active+future+closed | **source** — active+future |
    | `new-po` | **target for the new story** — active+future, "Backlog / no sprint" | **source** — active+future |

    Their accessible names stay **`"PO board sprint"` / `"Dev board sprint"` in every mode** (only
    the visible sub-caption changes, source vs target) so a11y queries are stable. New **source**
    pickers offer active+future only — `get_active_sprint` rejects a closed sprint id
    (`sprintSelect.ts`), a pre-existing limitation of the mode-1 PO picker that is not replicated.

    **Mode 1 — "Create Dev tasks" (v1.11, the original flow, unchanged):**
    1. **Pick a PO board sprint** (`list_sprints` on `boards.po.id`) and the **target Dev
       sprint** (`list_sprints` on `boards.dev.id`).
    2. **Multi-select PO tickets** — the PO sprint's tickets (`get_active_sprint(po.id,
       sprintId)`, all buckets) as a **checkbox list**. Each row shows its existing **linked Dev
       ticket(s)** (`get_linked_issues(keys, projectKey=dev)`): a row that
       already has a Dev link is badged (e.g. "→ DEV-123") and **deselected by default** (to
       avoid duplicates), but can still be selected. "Select all without a Dev link" helper.
    3. **Generate the plan with AI** — on Generate, first fetch the selected PO stories' **own
       descriptions** (`get_issue_descriptions(keys)`, v1.14/ADR-025), then `POST
       /api/ai/plan-dev-tickets` with `poStories: [{ key, summary, description? }]` (each
       description capped at ~4000 chars) → one proposed Dev draft (`devSummary` +
       `devDescription`) per PO **derived from the PO's real description**, not just its title.
       The **plan is an editable list** (per-PO summary/description). When AI is off, each item is
       seeded from the deterministic template and, when a PO description was fetched, prepends a
       "## Source PO story" context block so the description still informs the Dev task; a banner
       explains.
    4. **Comment & regenerate per draft (v1.12, ADR-023)** — each plan item has a **comment box
       + "Regenerate"** button (shown only when AI is enabled). It re-calls
       `POST /api/ai/plan-dev-tickets` for **that single PO**, passing the reviewer comment + the
       current draft as `instructions`, and replaces that item's `devSummary`/`devDescription`.
       No new endpoint.
    5. **Create all** — iterate the plan, calling `create_dev_ticket({ summary, description,
       linkedPoTicketKey: <PO key>, sprintId: <dev sprint> })` per item. Show a **live status
       log**: per item ⏳→✓ `DEV-xxx` (link → `<PO>`) or ✗ with the error; a final "N created,
       M failed" summary. Created links open in Jira. Non-fatal `linkWarning`/`sprintWarning`
       are surfaced per row. (No new bulk MCP tool — the client loops `create_dev_ticket`.)
    New `src/lib`: `linkClient.ts` (`getLinkedIssues`, `getIssueDescriptions` [v1.14],
    `planDevTickets`), reuse `createLinkedDevTicket` (v1.10), `useActiveSprint`, `useSprintList`,
    `useBoards`, `buildDraftPair`. a11y: labeled checkboxes, `role="status"`/`aria-live` log,
    keyboard-OK.

    **Mode 2 — "Link existing" (v1.72, ADR-083)** — attach EXISTING Dev tickets to an EXISTING
    PO story (**many Dev → 1 PO**), and remove wrong links:
    1. **Target PO story** — a native `<select>` over the PO sprint's tickets (`PO-7 — summary`),
       with a read-only card beneath showing its points and current Dev links.
    2. **Dev candidates** — the Dev sprint's tickets (`get_active_sprint(dev.id, devSprintId)`,
       all buckets) in a shared `DevTicketPicker`: checkbox list, select-all header checkbox,
       an **"unlinked only"** toggle and an **assignee filter** (native selects, ADR-009 — there
       is no free-text search anywhere in the app). Each row is badged with its current PO links
       from `get_linked_issues(devKeys, projectKey=<PO project>)` — note the **explicit PO
       project key** (§4.17); the default filter is the Dev project and would return nothing.
    3. **Link N to PO-7** — the client loops `link_dev_to_po({ poKey, devKey })` **sequentially**
       through the shared bulk-run machine, with the same live status log and "Retry failed" as
       mode 1. A row that comes back `alreadyLinked: true` renders as a muted ✓ **"already
       linked"**, NOT an error. One `get_linked_issues` refetch after the run refreshes every
       badge and link id.
    4. **Unlink** — each PO badge carries an inline **two-click confirm** control (`aria-label`
       `"Unlink DEV-1 from PO-7"` → `"Confirm unlink DEV-1 from PO-7"`, auto-resetting), calling
       `unlink_dev_from_po({ linkId, poKey, devKey })` — always sending the guard keys (§4.32) —
       then refetching. A falsy `linkId` disables the control rather than risking a bad DELETE.

    **Mode 3 — "New PO from Dev tasks" (v1.72, ADR-083)** — the inverse of mode 1: create ONE new
    PO story that covers N existing Dev tickets:
    1. **Dev candidates** — the same `DevTicketPicker` (no unlink control), capped at **20**
       selected for the AI path (§4.9 `draft-po-story`); the draft button disables past the cap
       with an inline hint rather than letting the request 400.
    2. **Draft the PO story** — fetch the selected Dev tickets' descriptions
       (`get_issue_descriptions`, §4.18) then `POST /api/ai/draft-po-story`. AI off / 503 / any
       AI error → the deterministic `lib/poRollup.ts` rollup, with the same explanatory banner
       convention as mode 1.
    3. **Review/edit** — title, description, and a **points** field seeded with the arithmetic
       **sum** of the selected Dev tickets' points (all editable), plus `RefineDraftControl`
       ("comment & regenerate", re-calling `draft-po-story` with `instructions`) when AI is on.
    4. **Create & link** — `create_po_ticket({ summary, description, storyPoints?, sprintId: <PO
       sprint> })` (its `sprintWarning` surfaced non-fatally, §4.1), then the client loops
       `link_dev_to_po({ poKey: <new key>, devKey })` per selected Dev ticket through the same
       bulk-run machine. **The created PO key is held in state so "Retry failed" re-links ONLY —
       it must never re-run `create_po_ticket` and duplicate the story.** If the create itself
       fails, abort before any link: no orphan PO, no orphan links.

    **Read-only users** (shared-credential, §9.8.2): modes 2 and 3 disable their submit controls
    behind a one-line banner, so the user sees one explanation instead of N × `403 READ_ONLY_USER`
    rows in the status log.

    **Shared extractions (v1.72)** — `hooks/useBulkRun.ts` (the sequential write loop + per-row
    status + `retryFailed`, lifted verbatim from mode 1), `components/BulkStatusLog.tsx`
    (`<ul role="status" aria-live="polite">` + Retry/Start over), `components/SprintSelect.tsx`
    (the native `<optgroup>` picker with a `groups` prop), `lib/issues.ts` (`flattenIssues`),
    `lib/poRollup.ts` (deterministic rollup + `capDesc`), and
    `components/linking/DevTicketPicker.tsx` (shared by modes 2 and 3). Reuses the existing
    `RefineDraftControl`, `getIssueDescriptions`, and `createPoTicket`.
  - **Dashboard sprint-goal banner (v1.13, ADR-024):** above the board, show the active
    sprint's **goal** with a compact progress read — `% of points done (DoD = done OR code
    review)` and **days left** (from the sprint end date) — so the goal is the visible north
    star. When no goal is set, a muted "No goal set — add one in Planning" hint. Reads from the
    already-loaded `get_active_sprint` data (sprint.goal + totals + dates); no extra fetch.
  - **Dashboard** — owns `selectedBoardId` (v1.6, default = `boards.dev.id`),
    `selectedSprintId: number | null` state (v1.1), and `assigneeFilter: string | null`
    state (v1.2). `SprintBoard` + a sidebar that stacks **`ChatPanel` on top, then
    `HuddleDigest`** (v1.3.1). The Board toggle sits in the header; switching boards shows
    that board's sprint board / huddle / sprint selector (all scoped to the selected board).
    **(v1.7: the "New Sprint" button is REMOVED from the Dashboard — it now lives on the
    Planning page.)**
    **Sprint selector (v1.1, +v1.4 future sprints):** the SprintBoard header shows a
    labeled `<select>` ("Sprint") with the active sprints (latest first) and, in a separate
    optgroup/section labeled **"Future"**, the `futureSprints` (next-up first); selected =
    `sprint.id`. Changing it sets `selectedSprintId` and BOTH the board and the huddle
    refetch with that `sprintId`. The selector is shown when there is more than one
    selectable sprint (active + future combined > 1). When a **future** sprint is selected
    (`sprint.state === "future"`), show a small "Future sprint" badge and a friendly empty
    note when it has no issues yet (planning view). Selecting a future sprint resets the
    assignee filter like any sprint change.
    **Create Sprint (v1.4, ADR-011):** a "New Sprint" button near the selector opens a
    dialog (shadcn Dialog/AlertDialog) with fields: name (required), goal (textarea),
    start date, end date (`<input type="date">`; client validates start < end). On submit
    it calls the `create_sprint` tool → on success closes, refetches the board, and selects
    the new sprint (it appears under "Future"). Surfaces `UPSTREAM`/`VALIDATION` errors
    inline. The dialog copy makes clear this creates a REAL sprint on the Jira board. (AI
    goal-draft is an optional stretch, not required.)
  - **SprintBoard columns (v1.2):** FOUR columns in this order — **To Do**
    (`issuesByStatus.todo`), **In Progress** (`issuesByStatus.inprogress`),
    **Code Review** (`issuesByStatus.codereview`), **Done** (`issuesByStatus.done`).
    Each column header shows its count. Blocked issues keep their red badge in whatever
    column they fall in. Sprint header still shows name/dates/goal and story-point totals
    (done/total). Responsive: the 4 columns collapse to fewer/one ≤ 768px (horizontal
    scroll or stack — implementer's choice, must stay usable at 360px).
  - **Assignee filter (v1.2):** the Dashboard derives the distinct assignee list from the
    loaded sprint issues (across all four buckets; `null` assignee → an "Unassigned"
    option). A filter control in the SprintBoard header (chips or a `<select>` labeled
    "Assignee") offers **All** (default), each distinct assignee (display name), and
    **Unassigned** when any unassigned issue exists. Selecting one filters the rendered
    issue cards in ALL four columns to that assignee **client-side** (no refetch; the tool
    output is unchanged). Column counts update to reflect the filtered view, with the
    sprint header showing "Showing X of Y issues" when a filter is active. The HuddleDigest
    is NOT filtered (it's a whole-sprint standup digest). "All" clears the filter. The
    filter resets to "All" when the sprint selection changes. Purely presentational — the
    assignee data already lives in `IssueSummary.assignee`; no contract/tool change.
  - **TicketGen component (v1.1 — AI chat with deterministic fallback).** **(v1.7: this is
    no longer a standalone tab — the component is reused INSIDE the Planning page, ADR-018.
    All behavior below is preserved; it now mounts within Planning with its target sprints
    pre-seeded from the planning context.)** On mount, `getAiStatus()`.
    - **AI mode** (`ai.enabled`): chat-style page — message thread (user + assistant
      bubbles), input for the feature description and follow-ups, optional story-points
      field. Each send POSTs the FULL conversation to `aiDraftTickets`; renders
      `assistantMessage` as the assistant bubble and the returned PO/Dev drafts as the
      EXISTING editable preview cards (summary input + description textarea). Follow-up
      messages refine: previous drafts are replaced by the new response. "Create in Jira"
      calls `create_po_ticket` then `create_dev_ticket` (with `linkedPoTicketKey`) →
      success panel with keys + URLs. A small badge shows provider/model. AI call
      failures (502/500) render in-thread with a "use local templates instead" action.
    - **Fallback mode** (`ai.enabled === false`, or health says AI off, or
      `AI_UNAVAILABLE`): the existing v1.0 deterministic form flow
      (`ticketTemplates.ts`), with a dismissible banner: "AI drafting is off — using
      local templates. Set AI_PROVIDER in .env to enable (docs/SETUP.md)."
    - **Switch back to AI (v1.2 — fixes the one-way trap):** whenever TicketGen is in
      fallback mode but AI is actually available, the page shows a **"Use AI drafting"**
      button (in the banner and/or page header). It clears any local `forceFallback`
      state, re-checks `getAiStatus()`, and — if AI is enabled — returns to AI chat mode
      (seeding the thread with the current feature-description text if present). If the
      re-check still reports AI off, it shows the disabled banner explaining `AI_PROVIDER`
      is unset (no console error). The fallback must therefore distinguish "AI genuinely
      disabled" (no toggle, just the enable-instructions banner) from "user/error switched
      to local" (show the "Use AI drafting" button).
    - **Target sprints — separate PO and Dev (v1.4 base; v1.6 split, ADR-017):** TicketGen
      offers **two** optional "Add to sprint" `<select>`s — a **PO sprint** (populated from
      `list_sprints` active+future on `boards.po.id`) for the PO Story, and a **Dev sprint**
      (from `list_sprints` on `boards.dev.id`) for the Dev Task; each defaults to
      "Backlog / no sprint". On "Create in Jira" the PO `sprintId` is passed to
      `create_po_ticket` and the Dev `sprintId` to `create_dev_ticket` (the pair stays
      linked via `linkedPoTicketKey`) — so the linked PO+Dev tickets land in their
      respective boards' sprints at once. The success panel notes each target sprint and
      surfaces any `sprintWarning` per ticket (non-fatal). Works in AI and fallback modes.
      If health has no `boards`, fall back to the single Dev "Add to sprint" select (v1.4).
  - **Reports (v1.4 — Phase 3; ADR-012. v1.4.1 — UI-expert layout + story-points focus)** —
    a real reporting page (replaces the stub):
    - **Layout (v1.5, ADR-016 — supersedes the v1.4.1 single-column):** NOT a simple
      vertical column AND not the old cramped flex-row — a **full-width responsive grid**
      that maximizes available width (remove the narrow `max-w` constraint; the report
      spans the page). A UI-expert designs a multi-column dashboard arrangement that reads
      well: e.g. at wide widths the completion summary + velocity sit in a top row, the
      leaves calendar + by-assignee in the next, with the issue lists and AI summary
      full-width below — collapsing to one column ≤ md. Strong hierarchy, generous
      whitespace, soft-UI; usable at 360px; clean print. Update `docs/REPORTS-LAYOUT.md`
      with the new full-width rationale.
    - **STORY-POINTS FOCUS (v1.4.1):** the report is about **story points, not issue
      counts.** Show committed points, completed points, `completionRate` (points-based)
      as a progress bar, and **carryover points** (= committed − completed). Do NOT show
      "issues done/total" as a metric, and the **By assignee** table shows **only points**
      (name, done points, total points) — drop the done-issues / total-issues columns.
      Blocked may remain as a small risk flag (count is acceptable there — it's an
      impediment signal, not a velocity metric) or be omitted. The issue **lists**
      (Completed / Carryover) still list individual issues with their points. (Note: with
      the v1.5 DoD, `completedPoints` already counts code-review as done — §4.12/ADR-014.)
    - **Decimal formatting (v1.4.1):** ALL point values (committed, completed, carryover,
      per-assignee, velocity averages/forecast, per-sprint bars) render with **at most 2
      decimals, trailing zeros trimmed** (e.g. `13.5`, `29.75`, `30`, not `13.50` /
      `29.7500000`). Use a shared `formatPoints(n)` helper (pure, tested). This replaces
      the velocity `.toFixed(1)`.
    - **Board toggle — separate PO & Dev reports (v1.6, ADR-017):** a "Board: Dev / PO"
      toggle at the top of Reports (from `boards`, default Dev). The sprint picker and ALL
      report tools (`list_sprints`, `get_sprint_report`, `get_velocity`, leaves) use the
      selected board's `id`, so PO and Dev reports are fully separate. Switching boards
      resets the selected sprint. A board with no sprints shows the empty state.
    - **Per-sprint report** (`get_sprint_report`): header (name, dates, goal, state badge);
      the points-focused completion summary above; a **By assignee** points table; a
      **Completed** list and a **Carryover / not completed** list (each issue: key→Jira
      link, summary, assignee, points; blocked flagged). Loading/error/empty states.
    - **Velocity + forecast** (`get_velocity`, v1.5 selected-sprint context): a CSS bar
      chart (no charting dep) of the sprints **before the selected sprint** —
      `useVelocity` passes the selected sprintId as `beforeSprintId` AND **`includeActive: true`
      (v1.10, ADR-021)** so the chart reflects the latest sprints even if they are still
      `active` (this board rarely closes sprints; closed-only returned stale sprints). The
      chart is "the N sprints prior to the one you're viewing" and refetches on sprint change. Committed
      vs completed points per sprint (via `formatPoints`) + `averageCompleted` +
      `forecastNext`, labeled "suggested capacity (avg of last N before this sprint), not a
      commitment". Empty state when none.
    - **Leaves / team calendar (v1.5, ADR-016; v1.8.1 — EDITABLE on Reports again):** the
      Planning page is the primary plotter (team-rostered), but **Reports also has an
      editable leaves calendar** for its selected sprint (user request — reverses the v1.7
      read-only) rostered from that sprint's assignees (`report.byAssignee`); plus the
      by-assignee **Leaves** column + capacity figures. Both pages persist to the same
      `set_leaves`/`get_leaves` store keyed by sprintId (`LeavesCalendarCard` without
      `readOnly`). When no leaves are recorded, the Leaves column shows 0 and capacity = the
      raw average.
    - **Capacity-adjusted "possible committed velocity" (v1.5, ADR-016):** a PURE helper
      `src/lib/capacity.ts` computes, from the selected sprint's working days, its assignees,
      and the entered leaves: `totalPersonDays = assignees × sprintWorkingDays`,
      `availablePersonDays = totalPersonDays − Σ leaveDays`,
      `capacityFactor = available / total` (1 when total 0), and
      `possibleCommitted = averageCompleted × capacityFactor` (via `formatPoints`).
      Display it NEXT TO the raw forecast, clearly labeled a heuristic ("possible committed
      velocity for this sprint, adjusting the average for entered leaves — not a
      commitment"), with the inputs shown (e.g. "N people · W working days · L leave days →
      X% capacity"). Unit-tested.
    - **By-assignee leaves column (v1.5):** the By-assignee table gains a **Leaves** column
      (days off this sprint, from `get_leaves`) alongside the points columns.
    - **AI executive summary** (optional): when AI is enabled (`getAiStatus`), a "Draft
      summary" button calls `aiSprintSummary` with the report payload and renders the
      returned narrative (markdown). Hidden/disabled with a hint when AI is off; AI errors
      render inline without breaking the data report.
    - **Export:** an export bar — **Copy** (report as Markdown to clipboard), **Download
      .md** (Blob download), and **Print / Save as PDF** (a print-optimized layout via
      `window.print()` + a scoped `@media print` stylesheet — dependency-free; the AI
      summary, when present, is included). The Markdown builder is a PURE function
      (`src/lib/reportMarkdown.ts`), unit-tested.
- **ChatPanel** — deterministic command router (`src/lib/chatRouter.ts`, pure +
  unit-tested). Commands: `help`, `huddle`, `sprint`, `ticket <KEY>`,
  `enhance <KEY> <notes>`, `create <description>`, `prs`, `link pr <n> [KEY]`.
  Unknown input → help text explaining the POC scope and pointing to Copilot for free-form
  NL (spec §8 decision). Responses render as message cards (ticket cards, sprint summary,
  huddle digest...). **v1.1 AI routing:** when AI is enabled, `create <description>`
  obtains its PO/Dev drafts from `aiDraftTickets` (single user message) before calling the
  create tools, and `enhance <KEY> <notes>` flows `get_ticket` → `aiEnhanceTicket` →
  `update_ticket`; the assistant card shows `assistantMessage`. When AI is disabled or
  returns `AI_UNAVAILABLE`, both commands fall back to the v1.0 deterministic behavior
  (templates / notes-merge) and say so in the reply card. `sprint` and `huddle` commands
  respect the Dashboard's selected sprint. The `sprint` command result reflects the active
  assignee filter when one is set; `huddle` is never filtered.
- All data components handle **loading / error / empty** states; bridge-down errors show
  the start command.
- **UI stack (v1.2 — supersedes the v1.0 "no framework" rule; ADR-009):** the app uses
  **Tailwind CSS + shadcn/ui** (Radix primitives). shadcn components live under
  `src/components/ui/`, generated via the shadcn CLI; only components actually used are
  added. The `@/` path alias resolves to `src/` (wired in `vite.config.ts` +
  `tsconfig.json`). The prior token set maps onto shadcn's CSS theme variables so the
  palette stays coherent (indigo accent, status colors). Behavior, props, event handlers,
  state, and every contract above are PRESERVED through the migration — it is a
  presentation-layer change. Professional dashboard look, modern/minimal, responsive
  ≥ 360px, WCAG AA contrast, visible focus rings, hover + loading affordances. Existing
  RTL tests stay green; tests are updated only where the DOM legitimately changed (prefer
  role/label queries; never weaken a behavioral assertion).

### 6.1 Design system + Scrum affordances (v1.3 — ADR-010)

A two-specialist (UI/UX + Scrum Master) live review. All items below are **react-app
presentation/derivation only** — they use data ALREADY in the tool outputs; NO MCP tool,
HTTP, or env contract changes. lucide-react (already a dependency) provides icons. Tests
stay keyless/offline; update RTL tests only where the DOM legitimately changed, never
weakening a behavioral assertion. EXACT contract-critical copy (bridge-down commands, AI
banner text, "Showing X of Y issues", "Use AI drafting", help/command text) is preserved.

**Design tokens (src/globals.css + tailwind.config):** a refined token set on shadcn CSS
variables — primary indigo `hsl(243 75% 59%)`; slate neutral ramp; accent violet
`hsl(258 90% 66%)` (AI / code review); semantic `success hsl(142 71% 45%)`,
`warning hsl(38 92% 50%)`, `error hsl(0 72% 51%)`, `info hsl(217 91% 60%)`, EACH with a
`-bg` (~12% tint) and `-foreground`/`-border` token (replace the ad-hoc green-50/amber-50
literals). Add a `.dark` variable block (no toggle UI required this round). Status colors
(todo slate / inprogress blue / codereview violet / done emerald / blocked red) become a
named token group used by the column headers and badges. Standardize radius (`rounded-lg`
cards, `rounded-md` controls), `shadow-sm` max, a 4px spacing scale, a typographic scale
(page/sprint title `text-2xl font-semibold`; column header `text-xs font-medium uppercase
tracking-wide text-muted-foreground`; meta `text-xs`; keys `font-mono`), and 150ms
color/transform transitions guarded by `prefers-reduced-motion`. **Typeface (v1.3.1):
Poppins**, self-hosted via `@fontsource/poppins` (weights 400/500/600/700 imported in
`main.tsx`), set as Tailwind `fontFamily.sans` and applied to `body` via `font-sans` —
offline-safe, no external font request.

**SprintBoard — sprint header (3 zones):** identity (sprint name dominant + date range,
calendar icon) · progress · controls (sprint + assignee selects, label-above, `h-9`,
focus ring; sprint option label shortened e.g. `Arsenic · Jun 4–17` with full name in a
`title`/tooltip). Column headers become filled tinted bands with a lucide icon + a colored
count badge per status.

**Sprint progress + pace (derive from `totals` + `sprint` dates):**
- Progress bar (v1.5 DoD, ADR-014): completed points = `storyPointsDone +
  storyPointsCodeReview` (code review counts as done for progress/pace; the board still
  shows Code Review as its own column). Bar = completed / `storyPointsTotal`.
  When `storyPointsTotal === 0`, show "No estimates" rather than a 0% bar. The pace chip
  uses the same DoD-completed points.
- Sprint timeline (from `sprint.startDate`/`endDate`, client clock): `Day X of N · M days
  left` + a thin elapsed bar. Handle null dates gracefully (hide the timeline).
- **Pace indicator (heuristic, clearly labeled — NOT a forecast):** compare % sprint time
  elapsed vs % story points done → `On track` (within ~10%), `Behind`, or `Ahead`, as a
  small semantic chip. If no estimates or no dates, omit. Pure function, unit-tested.

**Blocker affordance:** when `totals.blocked > 0`, a `warning`/`error` Alert above the
board: "⚠ N blocked — KEY1, KEY2…" (lists up to ~5 keys, linking to Jira) + a one-click
"Show blocked" toggle that filters all columns to blocked issues (composes with the
assignee filter). Hidden when 0 blocked.

**"My issues" quick filter — REMOVED (v1.4.1, ADR-013).** Per user feedback the remembered
"My Issues" toggle (and its `localStorage` key) is removed from the Dashboard sprint filter.
The plain **Assignee `<select>`** (All / each name / Unassigned) stays as the filter. The
initials-avatar chips next to assignee names may remain (they are independent of the
removed toggle).

**Huddle digest — "By status / By person" toggle:** a control on `HuddleDigest` switching
the grouping of the SAME `get_daily_huddle` data between the current status sections and a
per-assignee view (each person's inProgress + codeReview + blocked items) for a
walk-by-person standup. **Default view = By person (v1.3.1)** — the standup walk is the
primary use; "By status" remains one click away. `summaryText` and the copy-to-clipboard
output are unchanged in "By status"; in "By person" the clipboard text groups by person.
Pure client regroup.

**Reports page:** keep the Phase 3 stub but add clearly-labeled, **disabled** "Velocity"
and "Burndown" placeholders explaining they need historical sprint data (Phase 3) — do
NOT fabricate numbers.

**Out of scope (Phase 3 — needs historical/persisted data, do not fake):** velocity
average, burndown chart, retro board, sprint report generator.

## 7. Quality gates (every package)

- `npm run typecheck`, `npm run build`, `npm run test` all pass **with no `.env` and no
  network** (vitest; mock axios via `vi.mock`).
- zod-validate every tool input. No `any` (use `unknown` + narrowing). Never log secrets.
- Tests live in `test/` (servers) or `src/**/*.test.tsx` (react-app).

---

## 8. Task Helper — per-user accounts + AI ticket→prompt (v1.44, ADR-054)

An **additive, team-internal** section on the mcp-jira bridge (`:4001`): a teammate signs up, connects
**their own** Jira/GitHub (pasted tokens, encrypted at rest), fetches **their** sprint tickets, and the AI
produces a **refined ticket** + a **ready-to-paste coding-agent prompt**. The existing single-tenant board
is untouched. New modules are imported **only by the bridge/router**, never by the MCP tool registry or the
stdio entry — the tool set stays at 40.

### 8.1 Enablement + env (§3 additions)

| Var | Required | Purpose |
|---|---|---|
| `TOKEN_ENC_KEY` | for Task Helper | base64 **32 bytes** — AES-256-GCM key encrypting connection tokens at rest |
| `SESSION_SECRET` | for Task Helper | HMAC key signing the session cookie |
| `TASK_HELPER_FILE` | optional | user-store path (default `<mcp-jira>/.invokeboard-users.json`, git-ignored) |

The feature is **enabled only when BOTH secrets are set** (`isTaskHelperConfigured()`); otherwise every
Task Helper route returns **503 `TASK_HELPER_UNAVAILABLE`**. AI steps reuse the existing `AI_PROVIDER` + key
(no per-user AI key). CORS for these routes uses `credentials: true` + a specific origin (never `*`).

### 8.2 Store (host-local JSON, encrypted)

`{ users: { [id]: { id, email, passwordHash, createdAt } }, connections: { [userId]: { jira?, github? } } }`.
A connection = `{ enc: { ciphertext, iv, tag }, meta: {…masked…}, updatedAt }`. **Raw tokens never leave the
store decrypted** except in-memory, per request, to build a client. Passwords hashed with **scrypt** (salted,
timing-safe verify). No native deps (Node `crypto` + JSON store, mirroring §4 store pattern).

### 8.3 Auth endpoints

- `POST /api/auth/signup` `{ email, password(≥8) }` → sets httpOnly session cookie; `{ ok, data:{ email } }`.
  `409 EMAIL_TAKEN` if the email exists.
- `POST /api/auth/login` `{ email, password }` → sets cookie; `{ email }`. `401 BAD_CREDENTIALS` on mismatch.
- `POST /api/auth/logout` → clears cookie. `GET /api/auth/me` → `{ email }` or `401 UNAUTHENTICATED`.
- `PUT /api/auth/password` `{ currentPassword, newPassword(≥8) }` (v1.67, ADR-078; requires auth,
  any role) → verifies `currentPassword` against the stored hash, then updates it;
  `{ ok, data: { changed: true } }`. `401 INVALID_PASSWORD` on mismatch; `400 VALIDATION` if
  `newPassword` is under 8 chars. Self-service — distinct from the admin's password RESET
  (`PUT /api/admin/users/:id { password }`, §9.8.4), which doesn't require the current password.

### 8.4 Connections (all require auth; tokens NEVER returned)

- `GET /api/me/connections` → `{ jira: { connected, baseUrl, email, hint } | null, github: { connected, login, hint } | null }`.
- `PUT /api/me/connections/jira` `{ baseUrl, email, token }` — validates via `GET /rest/api/3/myself`, then
  encrypts + stores. `400 INVALID_CONNECTION` if validation fails. Returns the masked status.
- `PUT /api/me/connections/github` `{ token }` — validates via `GET /user`. Same shape.
- `DELETE /api/me/connections/:provider` (`jira|github`) → removes it.

### 8.5 Task Helper (require auth + a Jira connection)

- `GET /api/me/tasks/issues[?sprintId=<id>]` → `{ issues: [{ key, summary, status, url }] }` — the user's
  assigned issues. **v1.46 (ADR-055 Phase F):** with `sprintId` the JQL is
  `assignee = currentUser() AND sprint = <id>` (the sprint selected on the board); without it, it falls
  back to `sprint in openSprints()`. `400 VALIDATION` if `sprintId` isn't a positive integer;
  `409 NO_JIRA_CONNECTION` if unset.
- `POST /api/me/tasks/help` `{ ticketKey, extraContext? }` → `{ refinedText, prompt }`. Fetches the ticket via
  the user's connection, then runs the AI pipeline (refine → technical plan → prompt-engineer). `503
  AI_UNAVAILABLE` when AI is off.

### 8.6 Personal sprint journal (v1.48, ADR-057/058) — require auth

A notes **feed** + a to-do checklist for the signed-in user, scoped to one sprint. **Personal**:
stored under the user's REAL id (`.invokeboard-user-stores/<userId>/journal.json`), never the credential
source's (§9.8) — a shared-credential viewer keeps their own journal.

- `GET /api/me/journal?sprintId=<id>` → `{ notes: JournalNote[] (newest first), todos: JournalTodo[] (oldest first) }`.
  `400 VALIDATION` unless `sprintId` is a positive integer.
- `POST /api/me/journal/notes` `{ sprintId, text(1..5000) }` → `201` + the new note.
- `DELETE /api/me/journal/notes/:id` → `{ deleted: true }`; `404 NOT_FOUND` when unknown.
- `POST /api/me/journal/todos` `{ sprintId, text(1..500), ticketKey? }` → `201` + the new to-do.
- `PATCH /api/me/journal/todos/:id` `{ text?, done?, ticketKey?(null clears) }` → the updated to-do.
  Toggling `done` stamps/clears `doneAt`. `404 NOT_FOUND` when unknown.
- `DELETE /api/me/journal/todos/:id` → `{ deleted: true }`; `404 NOT_FOUND` when unknown.

```
JournalNote = { id, sprintId, text, createdAt }
JournalTodo = { id, sprintId, text, done, ticketKey?, createdAt, doneAt? }
```

**Migration:** v1.47 stored `notes` as `{ [sprintId]: { [YYYY-MM-DD]: text } }`. The store converts each
day's note into a feed entry on first read and **persists** the result, so entry ids are stable.

⚠ **CORS:** `PATCH` is the only verb used by the journal's to-do toggle. Every verb the app uses must be
listed in the bridge's `cors({ methods })` or the browser's preflight rejects the call even though the
route exists. Same-process tests never preflight, so `http.test.ts` asserts the preflight explicitly.

### 8.7 Quality

Keyless/offline tests: crypto/scrypt/session round-trips; `requireAuth` 401; store never exposes a raw
token; `userJira`/`userGithub` validate+fetch (mock axios); pipeline (mock provider) → `{refinedText,prompt}`;
frontend auth gate + connections + TaskHelper (mock fetch). Smoke: unauth `/api/me/*` → 401; no-secrets → 503.

---

## 9. Multi-tenancy — per-user Jira/GitHub/AI + super-admin (v1.45, ADR-055)

Extends §8 from an additive tab into a **multi-tenant app**: login is required to enter, and every feature
runs on the signed-in user's OWN Jira/GitHub/AI token. A super-admin configures the non-secret board/env
block and supervises users. Secrets stay AES-256-GCM at rest, decrypted only in-memory per request.

### 9.1 Request-scoped config (the backbone)

`getConfig()` is the single funnel every tool + `jiraClient` + the AI layer read. `lib/requestContext.ts`
holds an `AsyncLocalStorage<{ userId, config }>`; `getConfig()` returns the context config when present,
else the global `.env` (stdio/Copilot + keyless tests unchanged). Bridge middleware `perUserContext` on
`/api/tools` + `/api/ai` resolves session → the user's merged config → `runWithUser(...)`, so **all 40 tools
run on the user's own Jira with zero tool changes**. `jiraClient` caches its axios client **per credential
set**. Per-user JSON stores live under `.invokeboard-user-stores/<userId>/…json`.

### 9.2 Per-user config = merge

`resolveUserConfig(userId)` builds a full `Config`, later wins:
**.env base ← admin global defaults ← admin per-user overrides ← the user's Jira creds ← the user's AI**.
Admin config is the NON-secret subset (`adminConfigSchema`): base url/email, PO/Dev board ids + project keys
+ project lists, story-points field, link type, flagged field, code-review statuses, dev-status app type,
velocity sprints, required points, offset threshold. Tokens are the user's own encrypted connections —
never admin-settable, never returned.

### 9.3 Roles + ADMIN_EMAILS (§3 addition)

The user record gains `role: "admin" | "user"`. `ADMIN_EMAILS` (comma-separated) bootstraps the admin role
at signup and is AUTHORITATIVE (a listed email is always admin and can't be demoted via the API).
`GET /api/auth/me` + `GET /api/me/context` include `role`.

### 9.4 Per-user AI connection (fixes the shared-token failure)

`PUT /api/me/connections/ai` `{ provider: "anthropic"|"github", token, model? }` — `validateAi` does a tiny
live call at connect so a bad/expired token is caught then, clearly. Folds into the merged config so
`getAiProvider()` is per-user. `connectionStatus` includes `ai: { connected, provider, model, hint } | null`;
`DELETE /api/me/connections/ai` removes it.

### 9.5 Context + app-wide gate

`GET /api/me/context` → `{ connections, ready, boards, policy, aging, ai, role }`, `ready = !!jira && !!github`.
Frontend `AuthProvider` + `AppGate`: not signed in → login; signed in but not ready → onboarding (connect
accounts); ready → the app. `callTool` + the AI client send `credentials: "include"`.

**`boards` + `policy` + `aging` + `ai` are PER-USER and authoritative for the UI (v1.51/v1.53/v1.58,
ADR-062/064/070).** All are computed inside the caller's request context (`resolveUser(userId)` →
`runWithUser(… getProjects()/getOffsetPolicy()/getAgingPolicy()/getAiStatus())`), so they reflect the user's
own `.env`←admin-global←shared-source←per-user override chain. `policy` is `{ requiredPoints,
offsetThreshold }`; `aging` is `{ baseDays, daysPerPoint }` (v1.58 — the ticket-aging expectation policy,
from `JIRA_AGING_BASE_DAYS`/`JIRA_AGING_DAYS_PER_POINT`, also on `GET /api/health .aging` as the global
`.env` value for keyless smoke/health); `ai` is `{ enabled, provider, model }` (the user's OWN AI token,
else inherited/global). The React board
selector + offset views read `boards`/`policy`, and `getAiStatus()` reads `ai`, from **this** endpoint (via
`AuthContext`) — NOT from the global, unauthenticated `GET /api/health` (which still returns the `.env`
values and is used only for keyless smoke/health). Two consequences: to point a user at a different board an
admin/user override must set the board **id** (`JIRA_DEV_BOARD_ID` / `JIRA_PO_BOARD_ID`), not just the
project key; and a user on their own AI token — with no global `.env` AI — is correctly shown AI-enabled.

### 9.6 Admin console API (all require an admin session → else 401 / 403)

- `GET /api/admin/users` → `{ users: [{ id, email, role, bootstrapAdmin, createdAt, connections:{jira,github,ai}, config }], globalConfig }`.
- `GET /api/admin/config` → `{ globalConfig }`; `PUT /api/admin/config` (body = `adminConfigSchema`) → replaces the global defaults.
- `PUT /api/admin/users/:id/config` (body = `adminConfigSchema`) → replaces that user's overrides; `404 NOT_FOUND` if unknown.
- `PUT /api/admin/users/:id/role` `{ role }` → promote/demote; `409 BOOTSTRAP_ADMIN` when demoting an ADMIN_EMAILS account.
- Enablement: `/api/admin/*` returns **503 TASK_HELPER_UNAVAILABLE** unless both Task Helper secrets are set.
- **UI note (v1.52, ADR-063):** the admin console's per-user "Manage" panel saves access AND board/env
  overrides with a **single "Save changes"** — it fires `PUT /api/admin/users/:id` (access) and/or
  `PUT /api/admin/users/:id/config` (overrides), only for the section(s) that changed. No new endpoint;
  this removes the "saved access but forgot to save the board override" trap. It also disables the button
  until something changes and warns before discarding unsaved edits.

### 9.7 Quality

Keyless/offline: ALS context vs `.env` fallback; per-user store isolation; config merge
(global←override←creds); admin authz (401/403); role bootstrap + demote guard; per-user AI validation
(mock). Existing suites stay green via the `.env` fallback + an `AppGate` pass-through mock in `App.test`.

---

## 9.8 Shared credentials + user CRUD (v1.46, ADR-056)

A teammate can be onboarded with **no tokens at all**. An admin points their account at a *credential
source* user (typically the admin); the account then borrows that user's Jira/GitHub/AI connections and
sees the same board point-of-view.

### 9.8.1 Model

`StoredUser` gains `credentialSourceUserId?: string | null`, `allowWrites?: boolean`, `disabled?: boolean`.

- **Effective connection** = the user's OWN connection for a provider, else the source's
  (`getEffectiveConnection`). Exactly **one hop** — a source must own its credentials, so resolution
  never cycles. A user's own connection always wins over the borrowed one.
- **Stores**: a borrower's per-user JSON stores resolve to the **source's** directory
  (`RequestContext.storeUserId`), so they share the team's leaves/retro/meeting-notes/offset.
- **Config merge** becomes: `.env` ← admin global ← **source's overrides** ← the user's own overrides ←
  effective Jira creds ← effective AI creds.
- **Readiness**: `/api/me/context.ready` uses effective connections, so a borrower passes the app gate
  with no tokens of their own.

### 9.8.2 Write safety

A Jira mutation made on a borrowed token is recorded in Jira under the **token owner's** name. So a
borrower is **read-only against Jira** unless an admin sets `allowWrites`. `RequestContext.canWriteJira`
carries this; `POST /api/tools/:name` rejects the eight **Jira-mutating** tools with **403
`READ_ONLY_USER`**:

`create_po_ticket`, `create_dev_ticket`, `update_ticket`, `create_sprint`, `set_sprint_goal`,
`assign_issue`, `transition_issue`, `move_issue_to_sprint` (`JIRA_WRITE_TOOLS` in `lib/delegation.ts`;
a new Jira-mutating tool MUST be added there).

The other `set_*` tools write **local team JSON** (leaves, retro, notes, impediments, offset) — not Jira —
and stay available. Users on their **own** token are unaffected.

### 9.8.3 Connection status + context additions

`connectionStatus` entries gain `inherited: boolean` and `via: string` (the source's email). A borrower
never sees the owner's masked token `hint` (it is `""`). `/api/me/context` gains `readOnly: boolean` and
`sharedFrom: string | null`.

### 9.8.4 Admin user CRUD (all require an admin session)

- `POST /api/admin/users` `{ email, password(≥8), role?, credentialSourceUserId?, allowWrites? }` → `201` + user view.
  `409 EMAIL_TAKEN`; `400 INVALID_CREDENTIAL_SOURCE` when the source is missing, is the target, borrows
  credentials itself, or has no Jira connection to share.
- `PUT /api/admin/users/:id` `{ email?, password?, credentialSourceUserId?(null clears), allowWrites?, disabled? }`.
  `409 CANNOT_DISABLE_SELF`; `409 BOOTSTRAP_ADMIN` (ADMIN_EMAILS accounts can't be disabled);
  `409 IN_USE` when making a lender into a borrower; `409 EMAIL_TAKEN`.
- `DELETE /api/admin/users/:id` → removes the account, its encrypted connections and config overrides.
  `409 CANNOT_DELETE_SELF`; `409 BOOTSTRAP_ADMIN`; `409 IN_USE` when other users borrow its credentials.
- The admin user view adds `credentialSourceUserId`, `sharedFrom`, `allowWrites`, `disabled`, `readOnly`,
  `canBeSource`. `connections` reports the user's **own** connections (not the borrowed ones).

**Disabled accounts**: `POST /api/auth/login` → `403 ACCOUNT_DISABLED`; `requireAuth` rejects an existing
session with `403 ACCOUNT_DISABLED` (a deleted account's session → `401 UNAUTHENTICATED`).

### 9.8.5 Quality

Keyless/offline: effective-connection resolution (own vs borrowed, own-wins); store path points at the
source; config inheritance (source ← own); `canWriteJira` false→true on `allowWrites`; disabled → no
resolve/no login; admin CRUD happy paths + every guard; `403 READ_ONLY_USER` on a Jira-write tool and
**no** 403 on a local-store tool. Frontend: create-with-sharing, source list filtered to `canBeSource`,
read-only badge, grant-writes, disable, two-step delete, password reset.

---

### 9.8.6 Granular per-provider sharing (v1.67, ADR-078)

Closes the one gap §9.8's per-provider `getEffectiveConnection` resolution left open: today, if
`credentialSourceUserId` is set, EVERY provider the user hasn't connected themselves silently
borrows from the source. There was no way to say "only share GitHub."

- `StoredUser` gains `sharedProviders?: ConnectionProvider[]`. **Undefined/absent = share ALL
  providers the user doesn't own** (the exact §9.8 behavior — every existing shared account is
  unaffected, no migration). An explicit array restricts fallback-sharing to only the listed
  providers; a provider left off the list resolves to `null` (shows disconnected) even when the
  source genuinely has that connection. A user's OWN connection for a provider still always wins,
  regardless of `sharedProviders` — this only narrows the fallback, never the override.
- `getEffectiveConnection(userId, provider)`: after resolving `sourceId`, checks
  `user.sharedProviders` BEFORE falling back — `undefined` or an array that includes `provider`
  proceeds to borrow; otherwise returns `null`.
- **Admin CRUD**: `createUserSchema`/`updateUserSchema` (§9.8.4) gain
  `sharedProviders?: ("jira"|"github"|"ai")[]` (update: `.nullable()` — `null` clears the
  restriction back to share-all, same convention as `credentialSourceUserId: null`).
- **Admin view additions**: `userView()` keeps `connections` (own-only booleans, unchanged shape)
  and adds:
  - `effective: { jira, github, ai }`, each a `ProviderStatus` = `{ status: "own" } |
    { status: "inherited"; via: string } | { status: "none" }`, computed via
    `getEffectiveConnection` — lets the admin see at a glance whether a provider is the user's own,
    borrowed (and from whom), or genuinely absent, which the own-only `connections` flags can't
    distinguish (borrowed and absent both read `false` there).
  - `sharedProviders: ("jira"|"github"|"ai")[] | null` — the restriction as stored (`null` =
    share-all).
- **Admin UI**: wherever a credential source is picked (`AddUserCard`, `UserSetupForm`), three
  checkboxes — "Share Jira" / "Share GitHub" / "Share AI" — default to CHECKED (preserves the
  legacy all-shared default). `AddUserCard` omits `sharedProviders` from the create payload
  entirely when all three stay checked; `UserSetupForm` always sends it (`null` when all three are
  checked) as part of the existing combined "Save changes" access payload (§9.6's v1.52 pattern),
  alongside a new `email` field (see below). The per-user connection badges in the users list
  become the 3-state indicator described above instead of a plain on/off badge.
- **Admin UI — email edit**: `UserSetupForm` gains an `Email` input pre-filled from the user's
  current email, folded into the same access-dirty tracking and the same single "Save changes"
  action. No new endpoint — `PUT /api/admin/users/:id` has accepted `email` since §9.8.4 (v1.46);
  the admin console simply never exposed a field for it until now.

Keyless/offline: `getEffectiveConnection` restriction cases (share-all default; restricted list;
provider absent from the list → null even when the source has it; own connection still wins);
admin CRUD create/update with `sharedProviders` + the `effective`/`sharedProviders` view fields
(own / inherited-via / none). Frontend: the three checkboxes on create and on the combined save
(checked-by-default, omit-when-all-checked on create, always-send on update), the 3-state badge,
and the new email field.

---

## 9.9 Reusable config templates (v1.47, ADR-057) — admin only

A named bundle of `adminConfigSchema` values, saved once and applied to any user's overrides or to the
global defaults. Stored in the user store as `configTemplates`.

`ConfigTemplate = { id, name, config: AdminConfig, createdAt, updatedAt }`.

- `GET /api/admin/templates` → `{ templates }` (sorted by name).
- `POST /api/admin/templates` `{ name(1..80), config }` → `201`. `409 NAME_TAKEN`; `400 VALIDATION` on a bad config.
- `PUT /api/admin/templates/:id` `{ name?, config? }` → the updated template. `404 NOT_FOUND`; `409 NAME_TAKEN`.
- `DELETE /api/admin/templates/:id` → `{ deleted: true }`; `404 NOT_FOUND`.
- `POST /api/admin/users/:id/config/apply-template` `{ templateId, merge? }` → the updated user view.
- `POST /api/admin/config/apply-template` `{ templateId, merge? }` → `{ globalConfig }`.

`merge: true` layers the template **over** what's already set; the default **replaces** the target's config.
Applying is just a config write — the §9.2 merge order is unchanged.

### 9.9.1 Quality

Keyless/offline: template CRUD + `409 NAME_TAKEN` + `400 VALIDATION`; apply replace vs merge, to a user
and to the global defaults; `404` on an unknown template; `403` for non-admins. Frontend: empty state,
create, field-count, two-step delete, and scoped apply (a user's picker never touches the globals).

---

## 10. UI surfaces (v1.47, ADR-057)

**Connections** is its own tab (`pages/Connections.tsx`) — the Task Helper no longer embeds the
connections panel. **Task Helper** = sprint ticket picker → AI prompt, plus the §8.6 personal journal.
**Admin** = users + templates + global defaults. Board selector is hidden on Linking, Connections and Admin.

---

## Changelog (from DRAFT to FINAL)

Changes made by the Architect agent during finalization:

1. **Header** — changed from `DRAFT` to `FINAL — AUTHORITATIVE`; updated tiebreak rule
   (this document supersedes the spec on implementation details, not the other way around).

2. **§1.1 — stdio adapter error handling** — added normative rule: handler errors are
   caught and returned as `{ content: [...], isError: true }` MCP frames; errors must not
   be rethrown or written to stdout.

3. **§2 — `GET /api/health` version field** — specified it must be read from the package's
   own `package.json` at startup; must not be hardcoded.

4. **§2 — `GET /api/tools` response type** — changed `[{ name, description }]` (ambiguous
   tuple/object notation) to explicit `Array<{ name: string; description: string }>`.

5. **§3 — Required/Default contradiction** — separated "yes (no default)" from "optional"
   in the Required column; `JIRA_PO_PROJECT_KEY`/`JIRA_DEV_PROJECT_KEY` corrected to
   "optional" with defaults `"PO"`/`"DEV"` (they had "yes" but also showed defaults —
   contradictory). Added explanatory note on what "required" means at startup.

6. **§3 — `GITHUB_REPO` missing-variable behavior** — specified that if both the call-site
   `repo` parameter and `GITHUB_REPO` env var are absent, return a `VALIDATION` error
   (not a startup `CONFIG` error, since it is declared optional).

7. **§4.2 — `create_dev_ticket` output type** — replaced ambiguous inline-extension
   notation with explicit type comment; added `issueLink` payload shape so the implementer
   does not have to guess the Jira API body format.

8. **§4.3 — `get_active_sprint` — multiple active sprints** — added normative rule:
   use `values[0]`; specified `boardId` integer coercion from env var string.

9. **§4.3 — `get_active_sprint` totals** — clarified `storyPointsTotal` counts null story
   points as 0; clarified `blocked` counts all blocked issues regardless of status bucket.

10. **§4.3 — `startDate`/`endDate`/`goal` nullability** — added explicit note: `null` when
    absent in Jira response.

11. **§4.4 — `get_ticket` input validation** — added zod `.regex()` pattern for
    `ticketKey`; added 404 → `UPSTREAM` error specification.

12. **§4.4 — `created`/`updated` field format** — specified ISO 8601 pass-through from
    Jira fields; no reformatting.

13. **§4.5 — `update_ticket` PUT payload shape** — added explicit `{ fields: {...} }` body
    structure; added `updatedFields` content specification (`"summary"`, `"description"`);
    added 204/404 Jira response handling.

14. **§4.6 — `get_daily_huddle` bucket classification** — added explicit "done always wins"
    rule; added `summaryText` format template so all implementers produce identical output.

15. **§5.1/5.2/5.3/5.4 — `repo` missing-variable error** — propagated the
    call-time `VALIDATION` error rule to all four GitHub tools for consistency.

16. **§5.1 — `state` derivation** — added a normative `state` derivation rule (merged
    detection from `merged_at`) and specified how each input `state` value maps to the
    GitHub API `state` query parameter.

17. **§5.2 — `get_pr` not-found error** — added 404 → `UPSTREAM` error specification.

18. **§5.3 — `link_pr_to_ticket` output type** — changed tuple literal `[{ ... }]`
    notation to `Array<{ ... }>` to avoid TypeScript tuple misinterpretation.

19. **§5.4 — `sync_pr_links` output type** — same tuple→Array fix; added explicit
    `reason` value for the no-keys-detected skipped case.

20. **§5.5 — `jiraKeys.ts` null body handling** — specified that a null PR body is
    treated as empty string (prevents runtime TypeError on spread).

21. **§6 — `McpError` shape** — promoted `McpError` interface definition into the contract
    (was implicit); added `issues?: unknown[]` to match the HTTP error envelope.

22. **§6 — `useMCP` hook signature** — made explicit in the contract; previously
    implied but not typed.

23. **§6 — hook file paths** — corrected to `src/hooks/useJira.ts` / `src/hooks/useGithub.ts`
    (the spec §5 repo layout shows `hooks/` under `src/`; the draft had no path prefix).

---

## Changelog v1.1 (2026-06-11 — user-directed scope change after live testing)

24. **§4.3 — multiple active sprints** — the v1.0 `values[0]` rule selected the OLDEST
    active sprint on boards running several; replaced with: list ALL active sprints,
    sort latest-first by `startDate` (nulls last, ties by id desc), default-select the
    latest, allow explicit `sprintId`; added `ActiveSprintRef` and `activeSprints` to the
    output. ADR-007.

25. **§4.6 — `get_daily_huddle`** — gains `sprintId?` input (same selection rule) and
    `sprintId` in output.

26. **§4.9 (new) — AI drafting endpoints** — `POST /api/ai/draft-tickets` and
    `POST /api/ai/enhance-ticket` on the mcp-jira bridge only; dual provider behind
    `AiProvider` port (`anthropic` via official SDK + structured outputs, `github` via
    GitHub Models REST), switched by `AI_PROVIDER`; new `AI_UNAVAILABLE` 503 code;
    `/api/health` (jira) gains `ai` status. Amends ADR-002 — see ADR-006. Keys stay
    server-side; keyless/offline test gates unchanged.

27. **§3 — env table** — added `AI_PROVIDER`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`
    (default `claude-opus-4-8`), `GITHUB_MODELS_TOKEN` (falls back to `GITHUB_TOKEN`),
    `GITHUB_MODELS_MODEL` (default `openai/gpt-4o-mini`), `GITHUB_MODELS_BASE_URL`.

28. **§6 — react-app v1.1** — sprint selector dropdown on the Dashboard (board + huddle
    follow the selection); TicketGen becomes an AI chat with the v1.0 deterministic form
    as explicit fallback; ChatPanel `create`/`enhance` route through the AI endpoints when
    enabled; new `aiClient.ts`; hooks gain `sprintId` parameters.

29. **Dependency note** — `@anthropic-ai/sdk@^0.104.1` added to mcp-jira; zod resolved at
    3.25.76 (AI schemas import from the `zod/v4` subpath; all other code stays on `"zod"`
    v3 API).

---

## Changelog v1.2 (2026-06-11 — user-directed, after further live testing)

30. **§4.3 / §4.6 — Code Review bucket** — boards have a distinct "Code Review" status
    that was being lumped into In Progress. Added env-configurable code-review detection
    (`JIRA_CODE_REVIEW_STATUSES`, default `code review,in review,peer review,review`),
    guarded to `statusCategory === "inprogress"` so done/todo statuses never move. Added
    `issuesByStatus.codereview` + `totals.codereview` to `get_active_sprint`,
    `codeReview` bucket to `get_daily_huddle` (precedence done > blocked > codeReview >
    inProgress > upNext), and the new `summaryText` "<n> in code review" segment.
    `IssueSummary` is unchanged (bucketing only). ADR-008.

31. **§6 — SprintBoard four columns** — To Do / In Progress / Code Review / Done, each
    with a count; blocked badge preserved per column.

32. **§6 — Assignee filter** — Dashboard derives the distinct-assignee list (incl.
    "Unassigned") from loaded sprint issues; a header control filters all four columns
    **client-side** to one assignee ("All" default, "Showing X of Y" when active, resets
    on sprint change); HuddleDigest is never filtered. Presentational — no tool change.
    ADR-008.

33. **§6 — TicketGen "Use AI drafting" toggle** — fixes the v1.1 one-way trap where
    switching to local templates had no path back. Fallback now distinguishes "AI
    genuinely disabled" (instructions banner only) from "switched to local" (shows a
    "Use AI drafting" button that re-checks `getAiStatus()` and returns to AI mode).

34. **§6 — UI stack change: Tailwind CSS + shadcn/ui** — supersedes the v1.0 "no
    framework, hand-rolled CSS" rule. Presentation-layer migration: components move to
    `src/components/ui/` (shadcn/Radix), `@/`→`src/` alias added to `vite.config.ts` +
    `tsconfig.json`, prior tokens mapped to shadcn theme variables. All behavior, props,
    state, contracts, and keyless/offline test gates preserved; tests updated only where
    the DOM legitimately changed. Two-phase delivery (component migration, then a
    modernization audit/pass). ADR-009. **`react-app` `package.json`/`tsconfig`/
    `vite.config.ts` are unfrozen for this change** (the only round that touches them).

---

## Changelog v1.3 (2026-06-12 — user-directed two-specialist UI + Scrum review)

35. **§6.1 (new) — Design system + Scrum affordances** — refined semantic token set
    (success/warning/error/info + `-bg`/`-border`, slate neutrals, `.dark` block, status
    token group), typographic scale, radius/shadow/spacing standards, lucide iconography,
    motion (reduced-motion safe). Scrum affordances derived from EXISTING tool data:
    sprint progress bar, days-remaining timeline, pace heuristic chip, blocker banner +
    "Show blocked" filter, "My issues" remembered quick filter + initials avatars, huddle
    "By status / By person" toggle, Reports velocity/burndown placeholders (disabled,
    labeled Phase 3). ADR-010. **react-app presentation/derivation ONLY — no MCP tool,
    HTTP, or env contract change**; velocity/burndown/retro remain Phase 3 (not faked).

---

## Changelog v1.3.1 (2026-06-12 — user-directed small UI tweaks)

36. **Typeface → Poppins** — self-hosted via `@fontsource/poppins` (400/500/600/700),
    Tailwind `fontFamily.sans` + `body @apply font-sans`. Offline-safe; presentation only.
37. **Huddle default view = By person** — the standup-walk grouping is now the initial
    `HuddleDigest` view ("By status" one click away). Status-section RTL tests now select
    "By status" explicitly (it is no longer the default); behavioral assertions unchanged.
38. **Dashboard sidebar order** — `ChatPanel` (sprint commands) renders ABOVE
    `HuddleDigest`.

---

## Changelog v1.4 (2026-06-12 — user-directed: sprint management + Phase 3 reports)

39. **§4.3 — future sprints** — `get_active_sprint` fetches `state=active,future`, returns
    `futureSprints[]` (earliest-first) alongside `activeSprints[]`, and `sprintId` may now
    select an active OR future sprint (default still latest active; falls back to next
    future when no active). ADR-011.
40. **§4.1/§4.2 — optional `sprintId` on ticket creation** — new tickets can be dropped into
    a chosen sprint via the shared add-to-sprint helper (`POST .../sprint/{id}/issue`),
    non-fatal (`sprintWarning`). ADR-011.
41. **§4.10 `create_sprint` (new WRITE tool)** — `POST /rest/agile/1.0/sprint` with
    name/goal/dates → future sprint. A real MCP tool (Copilot can create sprints) + bridge.
42. **§4.11 `list_sprints` (new)** — active/future/closed `SprintRef[]` for the sprint
    pickers, target-sprint dropdown, and reports/velocity.
43. **§4.12 `get_sprint_report` (new)** + **§4.13 `get_velocity` (new)** — Phase 3 report
    data: committed/completed points, completed vs carryover, by-assignee, blockers; and
    real velocity over the last `JIRA_VELOCITY_SPRINTS` (default 6) closed sprints + a
    heuristic next-sprint forecast (no longer the ADR-010 placeholder). ADR-012.
44. **§4.9 — `POST /api/ai/sprint-summary`** — optional AI executive summary of a sprint
    report (bridge-only, dual-provider, 503 `AI_UNAVAILABLE` when off).
45. **§3 — env** — added `JIRA_VELOCITY_SPRINTS` (default 6).
46. **§6 — react-app** — sprint selector adds a Future optgroup + "Future sprint" badge +
    "New Sprint" create dialog; TicketGen gets an optional "Add to sprint" target;
    **Reports page is now real** (per-sprint report + velocity/forecast bars + AI summary +
    Copy/Markdown/Print-PDF export; `reportMarkdown.ts` pure + tested). ADR-011/012.

47. **HOTFIX (live-testing) — Jira sprint pagination** — the board sprint endpoint
    paginates at 50; `getActiveSprints`/`getActiveAndFutureSprints`/`getSprintsByState`
    fetched only the first page, so boards with >50 sprints truncated. On the real board
    (78 sprints) this hid the 2 **future** sprints entirely and undercounted active (4 vs
    30). Added `fetchAllSprintsRaw` (follows `startAt`/`isLast`, stops on a short page) and
    routed all three through it. Caught by live verification; smoke `/api/tools` count
    updated to 10 (the 4 new tools) + create_sprint/sprint-summary checks added.

---

## Changelog v1.4.1 (2026-06-12 — user feedback after live testing; ADR-013)

48. **§6 — Reports layout (UI-expert pass)** — replace the cramped flex-row layout with a
    vertical, sectioned single-column report (placement chosen by a UI-expert review,
    rationale in `docs/REPORTS-LAYOUT.md`).
49. **§6 — Reports are story-points focused** — drop issue-count metrics (no "issues
    done/total"; by-assignee table shows points only, not done/total issues). Carryover
    shown as **points** (committed − completed). Blocked stays only as an optional risk
    flag. The issue lists still enumerate individual issues.
50. **§6 — 2-decimal point formatting** — all point values render with ≤2 decimals,
    trailing zeros trimmed, via a shared pure `formatPoints()` (replaces `.toFixed(1)`).
51. **§6.1 — "My Issues" quick filter removed** from the Dashboard sprint filter (and its
    `localStorage` key); the plain Assignee `<select>` remains the filter. ADR-013.

---

## Changelog v1.5 (2026-06-12 — user-directed: DoD, velocity context, leaves/capacity)

52. **Definition of Done = done OR code review (ADR-014)** — `get_sprint_report` counts
    code-review issues as completed (completion summary + by-assignee + velocity math);
    `get_active_sprint.totals` gains `storyPointsCodeReview`, and the Dashboard progress
    bar + pace chip treat `storyPointsDone + storyPointsCodeReview` as completed (the board
    still shows Code Review as its own column). Applies to Reports AND Dashboard.
53. **§4.13 `get_velocity` — selected-sprint context (ADR-015)** — new `beforeSprintId`;
    Reports passes the selected sprint so velocity = the N closed sprints *before* it,
    refetching on sprint change.
54. **§4.14 `get_leaves`/`set_leaves` (new, ADR-016)** — per-sprint leaves/offset tracker
    persisted to a **bridge-side JSON file** (`JIRA_LEAVES_FILE`) — the project's first
    stateful store (deliberate, user-chosen). Registered MCP tools + bridge; keyless/offline
    tests via temp file.
55. **§6 — Reports full-width grid (ADR-016)** — supersedes the v1.4.1 single-column;
    a UI-expert full-width responsive dashboard grid (not simple vertical, not old flex-row).
56. **§6 — Leaves calendar + capacity (ADR-016)** — per-sprint working-day leaves calendar
    (editable, persisted), a **Leaves** column in the by-assignee table, and a
    capacity-adjusted **"possible committed velocity"** (`capacity.ts`: avg × availability),
    labeled a heuristic, shown beside the raw forecast.
57. **§3 — env** — added `JIRA_LEAVES_FILE` (default `<mcp-jira pkg>/.invokeboard-leaves.json`,
    git-ignored).

---

## Changelog v1.6 (2026-06-15 — user-directed: separate PO board + repo dev-all script)

58. **§2/§4.9 — `GET /api/health` (mcp-jira) gains `boards`** — `{ dev:{id,projectKey},
    po:{id,projectKey} }` from config (no Jira call), so the app can offer a PO/Dev switch
    without env access. ADR-017.
59. **§6 — Board toggle on Dashboard + Reports** — a Dev/PO switch (default Dev) scopes
    every board call (`get_active_sprint`/`get_daily_huddle`/`list_sprints`/
    `get_sprint_report`/`get_velocity`/`create_sprint`) to the chosen board's id. PO and Dev
    boards + reports are fully separate. Boards with no sprints show a friendly empty state.
    `boards.ts` + `useBoards()`. ADR-017.
60. **§6 — TicketGen: separate PO & Dev target sprints** — two "Add to sprint" selects (PO
    sprint → `create_po_ticket`, Dev sprint → `create_dev_ticket`), so a linked PO+Dev pair
    can be created into their respective boards' sprints in one action. ADR-017.
61. **Repo — `npm run dev:all`** (`scripts/dev-all.mjs`, dependency-free) starts the jira
    bridge + github bridge + Vite together with labeled output and clean shutdown; added
    `npm run smoke`. No tool/contract change.

---

## Changelog v1.7 (2026-06-15 — user-directed: Sprint Preparation / Planning page)

62. **§4.15 `get_assignable_users` / `assign_issue` (new tools, ADR-018)** — list a project's
    assignable developers (active, by accountId) and assign/unassign a ticket
    (`PUT issue/{key}/assignee`, a real write). Registered MCP tools + bridge.
63. **§6 — new Planning (Sprint Preparation/Grooming) page** that consolidates the prep
    workflow, default-targeting the **next future sprint** on the selected board. It
    **moves in**: the **New Sprint** button (off the Dashboard), **ticket generation** (the
    "Ticket Generator" tab is REMOVED; its component is reused inside Planning), and the
    **editable leaves/capacity plotter** (off Reports — Reports keeps a read-only Leaves
    column + capacity). It **adds**: a **developer-assignment** list (the planned sprint's
    tickets, each with an assignee `<select>` from `get_assignable_users` → `assign_issue`).
    Tab nav becomes **Dashboard · Planning · Reports**. The leaves plotter is rostered from
    `get_assignable_users` (the team), not just current assignees. ADR-018.

---

## Changelog v1.8 (2026-06-15 — user: curated team roster, not org-wide assignable list)

64. **Bug: assignment/leaves rostered the whole org.** `get_assignable_users`
    (`/user/assignable/search`) returns everyone with the Assignable User permission, not a
    team — so strangers appeared. **Fix (ADR-019):** a **curated per-board team roster**,
    seeded from recent-sprint assignees, editable (add/remove), persisted to a bridge-side
    JSON file (`JIRA_TEAM_FILE`).
65. **§4 — `IssueSummary.assigneeAccountId`** added (Jira accountId) so assignment can
    pre-select the current assignee and recent-assignee derivation has accountIds.
66. **§4.16 (new) — `get_recent_assignees`** (distinct assignees from the last N sprints,
    the "usual members"), **`get_team_members`** / **`set_team_members`** (persisted roster,
    add/remove = replace list). Registered MCP tools.
67. **§6 — Planning team management** — leaves plotter + assignment dropdown now roster from
    the curated team (`useTeamMembers`); a "Manage team" editor (add from recent sprints /
    optional name search / remove) with first-run seeding; `get_assignable_users` is kept
    only for the optional add-by-name search.
68. **§3 — env `JIRA_TEAM_FILE`** (default `<mcp-jira pkg>/.invokeboard-team.json`, git-ignored).
69. **v1.8.1 — Reports leaves editable again** (user request): the Reports leaves calendar is
    clickable again (reverses the v1.7/ADR-018 read-only), rostered from the report sprint's
    assignees, persisting to the same `get_leaves`/`set_leaves` store as Planning
    (`LeavesCalendarCard` rendered without `readOnly`).

---

## Changelog v1.9 (2026-06-16 — user: broaden recents, search-all, drop off-team lock; ADR-020)

70. **Bug: `get_recent_assignees` missed most of the team** — it sampled only the latest **3
    closed** sprints (closed-first, sliced to `sprintCount`), so the **active sprint** was never
    scanned and only ~3–4 people surfaced. **Fix (§4.16, ADR-020):** scan the **whole board**
    for recently-assigned issues — `GET board/{id}/issue?jql=assignee IS NOT EMPTY AND
    updated >= -{withinDays}d ORDER BY updated DESC&fields=assignee`, paged to `maxResults`.
    Input `sprintCount` → **`withinDays` (default 90)**, `maxResults` default 100 → **200**.
    New jiraClient helper `getBoardAssigneesRaw`.
71. **§6 — "Search all people" in Manage Team** — the recent list is no longer a ceiling. A
    search box over the **full** assignable list (`useAssignableUsers(boardId)` →
    `get_assignable_users`, client-side name filter) lets ANY person be added, recent or not.
    "Add from recent sprints" relabeled **"Add from recent activity"** (board-wide source).
72. **§6 — assignment off-team lock removed** (user request): a ticket's current assignee who is
    NOT on the curated team is now a **normal selectable** option (plain name) instead of a
    disabled "(not on team)" entry — assignment is preserved and re-selectable. Dropdown stays
    **Unassigned + curated team (+ current off-team assignee)**; still not the org-wide list.
73. **§2/§3 — configurable CORS + Docker deployment** (user request): bridge CORS allowlist now
    reads **`CORS_ORIGINS`** (comma-separated; `*` = any) at request time, default = the prior
    localhost origins (`parseCorsOrigins` in both `http.ts`). Added a containerized stack —
    `docker-compose.yml`, `docker/{jira,github,web}.Dockerfile`, `docker/nginx.conf` (SPA +
    same-origin reverse proxy `/jira`→:4001, `/github`→:4002), `.dockerignore`,
    `.env.docker.example` — plus `docs/DEPLOYMENT.md` and `docs/ARCHITECTURE.md` §7–§8. No tool
    IO changed.

---

## Changelog v1.10 (2026-06-17 — user: Dev-ticket-from-existing-PO + velocity fix; ADR-021)

74. **Bug: Reports velocity showed the wrong (stale) sprints.** `get_velocity` pooled only
    **closed** sprints, but this board rarely closes sprints (they sit `active` indefinitely),
    so the window returned old closed sprints and missed recent delivered work. **Fix (§4.13,
    ADR-021):** new `includeActive?: boolean` (default false). When true, the candidate pool =
    `closed` + `active` sprints (never `future`), sorted latest-first by `completeDate`
    (fallback `endDate`); `beforeSprintId` still excludes the selected/in-progress sprint. The
    Reports + capacity `useVelocity` calls pass `includeActive: true`. Default (closed-only)
    unchanged for other callers.
75. **§6 — Create a Dev ticket for an EXISTING PO story (new `LinkDevTicketCard`).** Distinct
    from TicketGen (new PO+Dev pair): pick a **PO board sprint** → pick one of its tickets →
    edit a Dev summary/description (pre-seeded from the PO story; optional **Generate with AI**)
    → pick a **Dev board sprint** → `create_dev_ticket({ summary, description, linkedPoTicketKey,
    sprintId })`. **No backend change** — `create_dev_ticket` already supports `linkedPoTicketKey`
    + `sprintId` (link/sprint non-fatal → `linkWarning`/`sprintWarning`).

---

## Changelog v1.11 (2026-06-17 — user: separate Linking page + bulk PO→Dev creation; ADR-022)

76. **§6 — new Linking page/tab (bulk PO→Dev).** The v1.10 single-PO `LinkDevTicketCard` is
    MOVED off Planning into a dedicated **Linking** tab and generalised to **bulk**: pick a PO
    sprint + a target Dev sprint → **multi-select** PO tickets (each showing its existing linked
    Dev ticket, "one or none" — *superseded, see v1.72/ADR-083: a PO story may link to many Dev
    tickets, and v1.72 adds an explicit write path for it*) → **AI plan** (one Dev draft per PO) → **Create all** with a live
    per-item **status log**. Tab nav becomes **Dashboard · Planning · Linking · Reports**.
77. **§4.17 (new) — `get_linked_issues`** `{ keys[], projectKey? }` → `{ links: { poKey:
    LinkedIssue[] } }` (existing Dev tickets linked to each PO; parallel; per-key non-fatal). New
    jiraClient `getLinkedIssues`. Registered MCP tool.
78. **§4.9 (new) — `POST /api/ai/plan-dev-tickets`** `{ poStories[], instructions? }` → `{ items:
    [{ poKey, devSummary, devDescription }], assistantMessage }` (one provider call, bridge-only,
    never an MCP tool). `draftService.planDevTickets` + `PlanDevTicketsOutputSchema`.
79. **No new bulk-create tool** — the client loops the existing `create_dev_ticket` so each PO
    gets its own ✓/✗ status. `create_dev_ticket` unchanged.

---

## Changelog v1.12 (2026-06-17 — user: per-draft comment & regenerate; ADR-023)

80. **§6 — per-draft "Comment & regenerate" (frontend-only; no new backend surface).** A shared
    `RefineDraftControl` (comment box + "Regenerate", AI mode only) attaches to each draft:
    - **Linking** — per plan item: re-calls `POST /api/ai/plan-dev-tickets` for that single PO,
      passing the reviewer comment + the current draft as `instructions`; replaces that item.
    - **TicketGen** — on the AI draft preview: appends the comment to the conversation and
      re-calls `POST /api/ai/draft-tickets`, refreshing the PO+Dev pair.
    No tool/endpoint/field changes — both existing AI endpoints already accept the needed inputs
    (`instructions` / `messages`).

---

## Changelog v1.13 (2026-06-17 — Scrum-Master review follow-up: shared sprint context + sprint goal; ADR-024)

81. **§6 — shared board + sprint across tabs.** `App` owns `selectedBoardKey` + a shared
    `sprintId` and threads them to Dashboard/Planning/Reports as optional controlled props
    (`boardKey`, `sprintId`, `onBoardChange`, `onSprintChange`); pages stay uncontrolled when the
    props are absent (tests unaffected). The shared sprint is an explicit pick: `sharedSprintId ??
    perCeremonyDefault` (Dashboard active / Planning next-future / Reports latest), so an explicit
    pick follows the user across tabs while defaults still differ. Board change resets the shared
    sprint. Linking keeps its own dual-board selectors.
82. **§4.10b (new) — `set_sprint_goal` (WRITE)** `{ sprintId, goal }` → `{ sprintId, goal }`
    (`POST /rest/agile/1.0/sprint/{id}` partial update; 404→UPSTREAM). New jiraClient
    `updateSprintGoal`. Registered MCP tool.
83. **§6 — sprint goal made first-class.** Dashboard shows a **goal banner** (goal + % points
    done + days left, from the loaded sprint data); Planning gets an inline **goal editor**
    (`set_sprint_goal`). Addresses the Scrum-Master review's "sprint goal isn't trackable" gap.

## Changelog v1.13.1 (2026-06-22 — Scrum-Master review P0 fixes: version pill + Linking retry)

84. **§6 — header version pill is build-derived, not hardcoded.** The pill no longer reads a
    literal `v1.7`. `react-app/package.json` `version` is the single source of truth, injected at
    build time via Vite `define` as the `__APP_VERSION__` global (declared in `src/global.d.ts`,
    replaced by vitest too). Bump `package.json` and the pill follows. react-app version set to
    `1.13.0` to match the contract line; lockfile regenerated.
85. **§6 — Linking "Retry failed (N)".** The bulk-create done phase now shows a **Retry failed**
    button whenever `errCount > 0`. It re-runs `create_dev_ticket` for the error rows **only**
    (matched by `poKey`), leaving successful rows untouched, then returns to the done phase with
    updated counts. Addresses the review's "a single failed row forces a full restart" gap.

## Changelog v1.14 (2026-06-24 — Linking: draft the Dev task from the PO's description; ADR-025)

86. **§4.18 (new) — `get_issue_descriptions`** `{ keys: string[] (1..50) }` → `{ descriptions:
    Record<string, string> }`. For each key, returns the issue description flattened to plain text
    (reuses `getIssue` → `adfToText`); parallel; a missing/unreadable key contributes `""`
    (non-fatal). Read-only, no new jiraClient surface. Registered MCP tool. jira tools 19→20.
87. **§6 — Linking "Generate plan" now drafts from the PO description.** Previously the AI plan
    saw only each PO's one-line `summary`. On Generate, the page now fetches the selected POs'
    descriptions (`get_issue_descriptions`) and passes them as `poStories[].description` (capped
    ~4000 chars) to `plan-dev-tickets` — which already accepted the field since v1.11 — so each
    Dev draft is derived from the PO's real acceptance criteria/scope. Per-draft **Regenerate**
    (v1.12) reuses the same fetched description. With AI off, the deterministic fallback prepends a
    "## Source PO story" block from the description. No change to `create_dev_ticket` or the
    `plan-dev-tickets` contract surface (frontend-only wiring + one read tool).

## Changelog v1.14.1 (2026-06-24 — bugfix: PO descriptions came back garbled/blank)

88. **§4.7/§4.18 — `adfToText` now preserves block structure.** Live testing showed Dev drafts
    ignored the PO description. Root cause (NOT the endpoint): `adfToText` was a text-only walk that
    concatenated bullet/ordered list items into a single run-on with no separators and dropped
    `hardBreak`s — so list-heavy PO descriptions (the common shape) flattened into garbage, and
    descriptions made entirely of inline nodes vanished. Rewrote it to emit `- `/`N. ` list markers
    (one item per line, nested lists indented), turn `hardBreak` into a newline, and pull text from
    inline `mention`/`emoji`/`inlineCard` nodes. Verified live against the user's Jira (e.g.
    VBPO-379 went from a garbled run-on to a clean numbered list). Existing `get_issue_descriptions`
    IO is unchanged.
89. **§6 — Linking flags description-less POs.** Separately, many PO stories simply have **no
    description** in Jira (`description: null` — e.g. 14 of 18 in the live PO sprint). The plan now
    badges each row "drafted from PO description" vs. "PO has no description — drafted from title",
    so an empty draft source is transparent instead of looking like a bug.

## Changelog v1.15 (2026-06-24 — Planning ticket actions: status change + move sprint + filter; ADR-026)

90. **§6 (bugfix) — PO sprint select showed Dev sprints.** Root cause was a frontend race, NOT the
    endpoint: while `useBoards()` loads, `useSprintList("all", boards?.po.id)` fires with no
    `boardId` → server default (Dev), and `useMCP.run()` had no out-of-order guard, so the stale Dev
    response could land after the correct PO fetch and clobber it. Added a monotonic request-id guard
    to `useMCP` (only the latest run's resolution is applied) — fixes it for every `useMCP` caller.
91. **§4.19 (new) — `get_transitions` / `transition_issue` (WRITE).** `get_transitions {ticketKey}`
    → available workflow transitions; `transition_issue {ticketKey, transitionId}` →
    `POST /rest/api/3/issue/{key}/transitions`, re-reads + returns the new status. New jiraClient
    `getTransitions` + `transitionIssue`. Registered MCP tools.
92. **§4.20 (new) — `move_issue_to_sprint` (WRITE).** `{ ticketKey, sprintId }` → reuses
    `addIssuesToSprint` (adding to a sprint moves it out of the prior one). Registered MCP tool.
    jira tools 20→23.
93. **§6 — Planning ticket list gains actions + filter.** `AssignmentList` adds an assignee filter
    with a "N of M · P pts" summary, a per-row **Status** dropdown (lazy-loads `get_transitions`,
    applies `transition_issue`), and a per-row **move-to-sprint** dropdown (`move_issue_to_sprint`).

## Changelog v1.16 (2026-06-24 — Huddle: rename + points-by-filter + impediments + PR store; ADR-027)

94. **§4.21/§4.22 (new) — `get/set_impediments` + `get/set_pull_requests`.** Two manual, per-sprint
    bridge-side JSON stores (mirroring leaves/team) for daily Huddle visibility: a blockers log and a
    pending-PR list. Full-replace `set_*` tools fill `id`/timestamps when omitted. New
    `impedimentsStore.ts` + `prsStore.ts`; `JIRA_IMPEDIMENTS_FILE`/`JIRA_PRS_FILE` config. jira tools
    23→27.
95. **§6 — "Dashboard" tab renamed to "Huddle".** The board tab/page is now **Huddle** (it is the
    daily-standup surface). The board's filter line now also shows the **filtered points total**
    ("Showing X of Y issues · P pts"). New sidebar cards: an **Impediments** log and a **Code review**
    pending-PR list, both keyed to the selected sprint.

## Changelog v1.17 (2026-06-24 — Planning: PO-first ticket generator in a drawer; ADR-028)

96. **§6 — ticket generator is PO-first, in a drawer.** On Planning, "Draft Tickets" is now a **New
    ticket** button that opens a **Sheet** (side drawer) containing `TicketGen`. `TicketGen` defaults
    to creating **only the PO story** (PO board) via `create_po_ticket`; an **"Also create a linked
    Dev task"** checkbox (default off) reveals the Dev pane + Dev sprint select and, when on, creates
    the linked Dev task too (`createTicketPair`, unchanged). The AI chat / fallback / Regenerate are
    preserved. Rationale: bulk PO→Dev already lives on the Linking page. New `createPoTicket` hook
    wrapper; new shadcn `sheet.tsx`. No MCP/tool surface change (frontend-only composition).

## Changelog v1.18 (2026-06-24 — in-app AI Q&A assistant: tool-calling over read tools; ADR-029)

97. **§4.9 (new) — `POST /api/ai/ask`** `{ question, boardId?, sprintId? }` → `{ answer, toolsUsed,
    provider, model }`. The first **agentic tool-calling** use of the `AiProvider` port: a capped
    loop offers the model a **read-only allowlist** of mcp-jira tools (as zod→JSON-Schema function
    specs), runs the chosen `ToolDef.handler`s **in-process**, and synthesizes an answer. New
    `chatWithTools` on the port + anthropic/github adapters; new `lib/ai/askService.ts`; new dep
    `zod-to-json-schema`. **No write tools exposed.** Bridge-only (never an MCP tool).
98. **§6 — Huddle `ChatPanel` gains an "ask" mode.** When AI is enabled, free-form input that isn't a
    known command routes to `/api/ai/ask` and renders the answer; deterministic commands
    (`huddle`/`sprint`/…) stay as-is for speed; AI-off keeps the help fallback. Amends ADR-002/006
    (the router stays deterministic; the AI path is additive, behind the `AI_PROVIDER` flag).

## Changelog v1.19 (2026-06-24 — floating assistant + chatbot write-actions w/ modal confirm; ADR-030)

99. **§6 — assistant is a global floating widget.** The `ChatPanel` moves out of the Huddle sidebar
    into a `AssistantWidget` — a **FAB at the lower-right** that pops the assistant on click, mounted
    once in `App.tsx` so it's available on every tab (lazy-mounts on first open; history persists).
100. **§4.5 — `update_ticket` gains `storyPoints`** (writes `JIRA_STORY_POINTS_FIELD`); refine now
    accepts summary/description/storyPoints. New jiraClient support on the update path.
101. **§4.9 — `/api/ai/ask` gains write-actions via `proposedAction`.** A curated WRITE_TOOLS set is
    offered to the model but **never executed by the loop** — a write request returns
    `proposedAction { tool, args }`; the UI confirms it in a **modal** (`ConfirmActionDialog`, an
    editable form for `create_sprint`) and only then executes the write via the existing tool. Reads
    still answer directly. Covers "update points of VRDB-2700 to 2pts", "move … to next sprint",
    "create a new sprint …". ADR-030.

## Changelog v1.20 (2026-06-25 — Huddle daily sections: auto-PRs + post-scrum + meeting goal; ADR-031)

102. **§4.22 — auto-PRs in the code-review card (frontend-only).** The Huddle code-review card now
    ALSO lists open GitHub PRs whose detected `jiraKeys` are in the **current sprint** (via the
    existing `list_prs`, filtered against the loaded sprint board). Manual PR store stays as a
    supplement; github-down degrades to manual-only. No tool change. ADR-031.
103. **§4.23 (new) — `get_post_scrum` / `set_post_scrum`.** A manual, per-sprint, per-person store of
    post-scrum "parking-lot" notes for tracking. `PostScrumNote { id, person, note, createdAt, resolved? }`;
    `postScrumStore.ts`; `JIRA_POST_SCRUM_FILE` config (git-ignored). Full-replace set (fills id/createdAt).
104. **§4.24 (new) — `get_meeting_goal` / `set_meeting_goal`.** A single editable "goal for today's
    meeting" per sprint (standup focus), distinct from the Jira sprint goal. Store shape
    `{ [sprintId]: { goal, updatedAt } }`; `meetingGoalStore.ts`; `JIRA_MEETING_GOAL_FILE` config (git-ignored).
105. **§4.9 — read-allowlist gains `get_post_scrum` + `get_meeting_goal`** so the assistant can answer
    "what's today's meeting goal?" / "any post-scrum notes for X?". jira tools **27 → 31**.
106. **§6 — Huddle sidebar hosts four compact daily cards** (impediments, code review w/ auto-PRs,
    post-scrum, meeting goal), redesigned tighter. New `PostScrumCard` + `MeetingGoalCard`, clients,
    and `usePostScrum` / `useMeetingGoal` hooks. ADR-031.
107. **§6 — Reports CSV export (frontend-only).** New pure `buildReportCsv(report, leavesCapacity?)`
    beside `buildReportMarkdown`; a **Download .csv** button in the Reports export bar emits the
    per-assignee breakdown (header + per-assignee rows + TOTAL; Leave Days column when capacity data
    is present) via the same Blob pattern (`text/csv`). No tool/route change.
108. **§6 — App-wide compact visual refresh (presentation-only).** Default shadcn card padding
    `p-6 → p-4`; page containers unified to `space-y-4`; Reports headings `text-2xl → text-xl`. No
    DOM/text/behavior change — the content + behavior test suite stays green. ADR-032.

## Changelog v1.21 (2026-06-25 — approver status of Jira-linked PRs on the Huddle; ADR-033)

109. **§5.6 (new) — `get_pr_reviews { numbers[], repo? }`.** Batch review/approval status for PRs:
    per-PR `GET /pulls/{n}/reviews` reduced by pure `summarizeReviews` to
    `{ decision: approved|changes_requested|review_required, approvals, changesRequested, reviewers[] }`.
    Latest-meaningful-vote-per-reviewer; COMMENTED/PENDING ignored; DISMISSED clears; 404 PR omitted.
    github tools **4 → 5**. New `githubClient.listReviews` + `PrReviewStatus`/`ReviewDecision` types.
110. **§4.22 / §6 — approval badge on auto-linked PRs.** The Huddle code-review card calls
    `get_pr_reviews` for its current-sprint auto-PR numbers (new `getPrReviews` client + `usePrReviews`
    hook) and shows a per-PR badge (✓ approved + count · ✗ changes requested · ⏳ review required).
    Read-only; github-down or unreviewed PRs simply show no badge. ADR-033.

## Changelog v1.22 (2026-06-26 — multi-repo PRs from Jira Development Information; ADR-034)

111. **§4.25 (new) — `get_issue_pull_requests { keys[] }`.** Reads each issue's linked PRs from Jira's
    **Development** panel (`/rest/dev-status/…`, populated automatically by the *GitHub for Jira* app
    from the issue key in branch/commit/PR-title) — **multi-repo**, with reviewer/approval data. Per-key
    id-resolve + dev-status detail, pure `parseDevStatusPullRequests` → `LinkedPr[]` (url/title/repo/
    status/decision/approvals/reviewers). Resilient per key; read-only. `JIRA_DEV_STATUS_APP_TYPE`
    config (default `GitHub`). jira tools **31 → 32**. (Undocumented endpoint — defensive parse.)
112. **§6 — Huddle code-review card now sourced from Jira (multi-repo).** Supersedes the single-repo
    GitHub auto-PR source (ADR-031) + `get_pr_reviews`-on-the-card (ADR-033): the card calls
    `get_issue_pull_requests` with the current sprint's ticket keys (new `getIssuePullRequests` client
    + `useIssuePullRequests` hook) and renders each linked PR with its approval badge across all repos.
    Manual PR store stays. `get_pr_reviews`/`list_prs` remain available tools (single-repo / Copilot).
    ADR-034.

## Changelog v1.23 (2026-06-26 — Huddle: Fly-in tracker + bigger chat + theme refresh; ADR-035)

113. **§6 — Fly-in tracker card.** New `FlyInCard` on the Huddle sidebar lists current-sprint tickets
    whose title is LIKE "FLY IN" (pure `matchFlyIn`, word-boundary `\bfly[\s_-]*in\b`; `selectFlyIns`).
    Derived from the already-loaded `get_active_sprint` issues — **no new tool/route**.
114. **§6 — assistant popup enlarged.** `AssistantWidget` panel `w-[360px] → w-[440px]`; `ChatPanel`
    height `h-[480px] → h-[min(640px,calc(100vh-9rem))]` (bigger, viewport-safe).
115. **§6 — theme refresh (presentation-only, ADR-035).** Token pass in `globals.css` toward the
    reference Kanban look: azure-blue primary (`243 75% 59% → 228 80% 60%` + ring + dark), cooler/
    lighter background, softer border, rounder cards (`--radius 0.5rem → 0.75rem`), softer shadows.
    App-wide via tokens; no DOM/text change — content/behavior tests stay green.

## Changelog v1.24 (2026-06-26 — Huddle Fly-in (horizontal+status) + chat scrim + sidebar shell; ADR-036)

116. **§6 — Fly-in tracker horizontal + status.** `FlyInCard` moved from the narrow sidebar to a
    **full-width strip above the board** (Dashboard, shown only when there are fly-ins), rendered as a
    wrap of ticket chips each with a **tinted status pill** (by `statusCategory`) + assignee.
117. **§6 — assistant popup: 750px + scrim.** `AssistantWidget` panel `w-[440px] → w-[750px]`, added
    `shadow-2xl` + a **dim backdrop scrim** (`bg-black/40`, click-to-dismiss, `aria-modal`).
118. **§6 — shell: sidebar nav + board selector top-right (ADR-036).** The top header moved to a
    **left sidebar** (brand + version + vertical `role="tab"` nav, same a11y as before). A single board
    selector now lives in the **top-right top-bar**, driving the shared board context; the per-page
    `BoardToggle` renders only in standalone/uncontrolled use (so page tests stay green). Hidden on
    Linking (dual-board). No tool/route/contract-IO change.

## Changelog v1.25 (2026-06-26 — multi-project switching; ADR-037)

119. **§2 — multiple PO/Dev projects.** New env `JIRA_PO_PROJECTS` / `JIRA_DEV_PROJECTS`
    (`KEY:boardId,KEY2:boardId2`); pure `parseProjects()` falls back to the single
    `JIRA_PO_PROJECT_KEY`+`JIRA_PO_BOARD_ID` (and Dev) as a 1-element list. `GET /api/health` `.boards`
    becomes `{ dev: ProjectRef[]; po: ProjectRef[] }` (element 0 = default). React `Boards` type +
    `boards.ts` validator + `useBoards` adapt; `App` shared context gains active PO/Dev project indices;
    the top-right shell adds a **project dropdown** beside the Dev/PO toggle. Pages pass the active
    project's `boardId` (no tool signature change). Older object-shaped `boards` → 1-project fallback. ADR-037.

## Changelog v1.26 (2026-06-26 — typed leaves + offset-points engine; ADR-038, backend slice)

120. **§4.14 — TYPED leaves.** `LeaveType = VL|EL|Holiday|Offset`; store shape
    `{ sprintId: { assignee: { date: type } } }`; `readLeaves` normalizes legacy `string[]` → all `VL`
    (no migration). `set_leaves` takes `entries:[{date,type}]` and **also** accepts legacy `dates:[]`
    (→ VL) for transition. `get_leaves` returns the typed map.
121. **§2 / §4.26 — offset engine.** `JIRA_REQUIRED_POINTS` (N=8) + `JIRA_OFFSET_THRESHOLD` (N2=2) →
    `GET /api/health .policy`. New offset-ledger store + tools `get_offset_ledger`,
    `set_offset_for_sprint` (auto snapshot, idempotent), `set_offset_adjustment` (manual delta).
    `balance = Σ earned − Σ spent + manualAdjust`; earned = `(done+leaveDays ≥ N+N2)?1:0` (max 1/sprint).
    jira tools **32 → 35**. (Frontend Leaves page + typed UI shipped in the v1.26 frontend slice:
    new **Leaves** tab — typed calendar painter (VL/EL/Holiday/Offset) + per-developer offset table
    with auto earned/spent + a manual adjustment column; `offset.ts` + `useOffsetLedger`.)

## Changelog v1.27 (2026-06-30 — has-PR badge on the board + reports; ADR-039)

122. **§6 — "has linked PR" badge (frontend-only; no tool change).** Reuses `get_issue_pull_requests`
    (§4.25). The **Dashboard** lifts `useIssuePullRequests(sprintKeys)` once and passes the resulting
    `Record<key, LinkedPr[]>` to **`SprintBoard`** (new optional `prsByKey` prop) → each `IssueCard`
    renders a compact, clickable **PR badge** (`GitPullRequest` + count) when its key has ≥1 linked PR;
    the badge links to the **newest** PR (latest `lastUpdate`) and its `title`/tooltip lists all PRs when
    >1. Tint reflects an aggregate review tone over the still-open PRs (changes-requested → red, approved →
    green, review-required → amber, all-merged/closed → muted). **Reports** badges its Completed and
    Carryover issue rows the same way (lifts `useIssuePullRequests` over the report's issue keys). New pure
    `src/lib/prBadge.ts` (`summarizePrBadge`) + shared `src/components/PrBadge.tsx`. The Huddle code-review
    card (§6, v1.22) keeps its own list; Dashboard passes its lifted map down to avoid a duplicate fetch.

## Changelog v1.28 (2026-06-30 — dual PO+Dev fly-in tracking + alignment; ADR-040)

123. **§6 — dual fly-in tracker (frontend-only; no tool change).** Reuses `get_active_sprint` (both
    boards) + `get_linked_issues`. The **Dashboard** now also fetches the **opposite** board's active
    sprint (`useActiveSprint(otherBoardId, null)`, default project) so `selectFlyIns` yields **both**
    `devFlyIns` and `poFlyIns`. New `useLinkedIssues(keys)` hook (over `get_linked_issues`, default
    `projectKey` = Dev) resolves each PO fly-in's linked Dev issues; a PO fly-in is **aligned** when a
    linked Dev issue is itself a fly-in (`matchFlyIn` on its summary) → `poAlignment: Record<poKey,
    LinkedIssue | null>`. **`FlyInCard`** props change from `{ flyIns }` to `{ devFlyIns, poFlyIns,
    poAlignment? }` and render **two labelled groups** (Dev / PO); each PO fly-in shows a green
    **"✓ aligned"** link to the Dev fly-in or an amber **"⚠ No Dev fly-in"**. Its only caller (Dashboard)
    is updated in the same change.

## Changelog v1.29 (2026-06-30 — forward, multi-sprint leave planner; ADR-041)

124. **§4.14 — `get_all_leaves {}`.** New read tool returning the WHOLE typed leaves store keyed by
    sprint id (legacy untyped dates → `"VL"`). jira tools **35 → 36**. Writes stay per-sprint
    (`set_leaves`).
125. **§6 — leave planner (Leaves page).** The Leaves page calendar is a `LeavesPlannerCard` matrix
    (person rows × **Mon–Fri** day columns — weekends never render, `sprintWorkingDays` excludes Sat/Sun)
    that shows the **selected sprint** and saves each plotted day to **that day's sprint**
    (auto-attribution). The sprint `<select>` is **grouped by state, Future → Active → Closed** so a
    **future** sprint is easy to pick and plot ahead; it also scopes the offset table. The matrix has a
    clean sticky name-column separator and neutral dividers only *between* sprints (no per-cell tint).
    *(Revised same-day per user feedback from the initial multi-sprint window — show only the selected
    sprint, switch via the picker. `selectCalendarSprints` is retained in `src/lib/leavePlanner.ts` next
    to the still-used `buildLeaveCalendar`.)* New `useAllLeaves` hook (`get_all_leaves` load + per-sprint
    `set_leaves` save) + `src/components/LeavesPlannerCard.tsx`. The per-developer **offset table stays
    scoped to the selected sprint** (it needs that sprint's done points).

## Changelog v1.30 (2026-06-30 — Linking keeps the PO title + carries PO points; ADR-042)

126. **§4.2 — `create_dev_ticket` gains `storyPoints?`.** Written to `JIRA_STORY_POINTS_FIELD` exactly
    like `create_po_ticket` (`createIssue` already supported the field). No other IO change.
127. **§6 — Linking retains the PO title + drafts editable points.** On the Linking page the drafted Dev
    task **keeps the PO story's title** — the AI (and the template fallback, and per-draft Regenerate) only
    **enhance the description**; every draft's `devSummary` is forced back to its PO summary (`draftFromPo`).
    Each draft also carries an **editable Points field, drafted from the PO's `storyPoints`** (plan item
    `storyPoints?`), which the user can override before create; the bulk create (and "Retry failed") send
    that value to `create_dev_ticket`. The plan card shows the Title "(kept from PO)" and a Points
    "(from PO)" input side by side.

## Changelog v1.31 (2026-06-30 — Huddle "who's on leave" card; ADR-043)

128. **§6 — on-leave card (Huddle, frontend-only; no tool change).** Reuses `get_all_leaves` /
    `useAllLeaves`. New pure `src/lib/leaveStatus.ts` `summarizeLeaveStatus(allLeaves, { today, horizonDays=7 })`
    → `{ today: [{assignee,type}], upcoming: [{assignee,date,type,daysAway}] }` (flattens every sprint's
    leaves, dedupes by (assignee,date), excludes past + far-out). New `src/components/LeaveStatusCard.tsx`
    on the Dashboard/Huddle sidebar shows **who's out today** + **upcoming leave (next 7 days)** with a
    leave-type chip. Board-agnostic (the leaves store is keyed by sprint only).

## Changelog v1.32 (2026-07-01 — quick UI: collapsible fly-in + Offset Tracker rename; frontend-only)

129. **§6 — Fly-in card collapsible (collapsed by default).** `FlyInCard` header is now a toggle button
    (`aria-expanded`, chevron); the counts (`(N) · Dev x · PO y`) stay visible while collapsed, and the
    Dev/PO groups render only when expanded. Default collapsed.
130. **§6 — "Leaves" → "Offset Tracker".** The sidebar tab **and** the page heading are renamed to
    **Offset Tracker** (tab/route id stays `leaves`; file names unchanged). Presentation-only.

## Changelog v1.33 (2026-07-01 — offset WALLET: main tracker + auto add/deduct; ADR-044, frontend-only)

131. **§6 — offset wallet (Offset Tracker page).** A main per-developer **balance** tracker where
    **spend is derived live** from `Offset`-type leaves (`get_all_leaves`/`useAllLeaves`) — plotting an
    Offset leave immediately lowers the balance — and **earned auto-banks per sprint on view** (an effect
    idempotently records the selected sprint's computed earned via `set_offset_for_sprint`, guarded by a
    signature so it never loops; the manual "Record this sprint" button is removed). New pure
    `src/lib/offsetWallet.ts` (`countOffsetLeaves`, `computeOffsetWallet` — `balance = earned − spent +
    manual`, using ONLY the ledger's `earned`+`manualAdjust`, spend always derived) + new
    `src/components/OffsetWalletCard.tsx` at the top of the page. The per-sprint offset table's Balance
    column now shows the wallet balance; the manual-adjust `<Input>` (`set_offset_adjustment`) is unchanged.
    No tool/IO change (`set_offset_for_sprint` now records earned-only; its stored `spent` is ignored).

## Changelog v1.34 (2026-07-01 — offset usage history modal; ADR-044 Phase 2, frontend-only)

132. **§6 — offset usage history.** Each `OffsetWalletCard` row gets a **History** button opening
    `src/components/OffsetHistoryDialog.tsx` — a per-developer modal showing the standing (earned / used /
    manual / balance) + every **Offset leave (a spend)** newest-first with its date + sprint. New pure
    `buildOffsetHistory(assignee, ledger, allLeaves, sprintNameById?)` in `offsetWallet.ts`. (Earned is the
    banked total — `get_offset_ledger` exposes no per-sprint earned breakdown — so the history is
    usage-centric; a per-sprint earn log would need the ledger to expose `bySprint`.) No tool/IO change.

## Changelog v1.35 (2026-07-01 — Reports full-report export form; ADR-045, frontend-only)

133. **§6 — full sprint-report CSV export.** A new **"Full report (CSV)"** button in the Reports
    `ExportBar` opens `src/components/SprintReviewExport.tsx` — a form for the qualitative fields (Team
    name, Scrum master, Commitment points [prefilled from committed], Reason for delays, What worked well,
    What didn't, Planned improvements, Kudos). On submit it downloads a **Field/Value CSV** built by new
    pure `buildSprintReviewCsv(report, form, flyIns)` in `reportMarkdown.ts` (reuses `csvCell`/`csvRow`),
    combining those answers with **pulled data**: Sprint duration (start–end + working days), Sprint goals,
    Completed points, Incomplete points (committed − completed), and **Fly-ins** (`matchFlyIn` over the
    report's completed + carryover issues). No persistence, no tool/IO change.

## Changelog v1.36 (2026-07-01 — dependency link + assignable Dev create; ADR-046 Phase A, mcp-jira)

134. **§2 — `JIRA_LINK_TYPE` default `"Relates"` → `"Depends"`.** The PO↔Dev link now expresses a real
    dependency. Direction in code (`inwardIssue: dev, outwardIssue: po`) → with an asymmetric
    `Depends` type this was believed to read **"PO story depends on Dev task"**. The type must exist in the
    Jira instance. **⚠ Corrected in v1.42 (item 159): that payload actually read backwards ("Dev depends on
    PO"); the inward/outward keys were swapped and the default set to the exact name `"Depends on"`.**
135. **§4.2 — `create_dev_ticket` gains `assigneeAccountId?`.** After create (+ link + sprint), when
    present, the shared `assignIssue` (PUT assignee) is called **non-fatally** — a failure returns
    `assignWarning` and does not fail the creation; the output echoes `assigneeAccountId`. Enables a Dev
    task to be created already assigned (e.g. splitting a PO across two developers). jira tools still 36.
136. **Linking point-driven breakdown (ADR-046 Phase B, react-app — no tool-surface change).** A PO story's
    points now drive how many Dev tasks it becomes: pure `lib/points.ts` `suggestBreakdown` splits a total
    that is not a single allowed estimate into a balanced pair of the allowed scale `{0.2,0.3,0.5,1,2,3,5,7}`
    (4→[2,2], 6→[3,3], 8→[3,5]); a single allowed value or ≤1 stays one task. The Linking plan is grouped by
    PO with 1–2 editable Dev-task rows, each with its own free-numeric **Points** + **Assignee** (Dev-board
    roster) + add/remove. "Create all" loops `create_dev_ticket` with each row's `storyPoints` +
    `assigneeAccountId` (the §4.2 fields from item 135). Frontend-only; no new tool, IO shapes unchanged.

## Changelog v1.37 (2026-07-01 — Planning bulk assign + inline points + per-dev capacity; ADR-047, react-app)

All frontend; **no new tool, jira tools stay 36, IO shapes unchanged** (C reuses `assign_issue` +
`update_ticket`; D reuses `get_team_members` + `get_leaves` + `health.policy`).

137. **Planning — bulk assign (ADR-047 Phase C).** `AssignmentList` gains a checkbox column + select-all and
    a toolbar ("N selected · Assign to [dev] · Apply") that loops the existing `assign_issue` over the
    selected tickets (optimistic per row; Apply disabled until a developer is chosen).
138. **Planning — inline story points (ADR-047 Phase C).** The read-only Pts cell becomes a free-numeric input
    that writes via **`update_ticket` `{ ticketKey, storyPoints }`** on blur/Enter (optimistic, reverts on
    failure; wheel-guarded). New `updateTicketPoints` client wraps the existing tool.
139. **Planning — per-developer capacity (ADR-047 Phase D).** `LeavesPlotterCard` adds a per-dev table:
    `capacity = max(0, requiredPoints − workingLeaveDays)` (pure `lib/capacity.ts` `computeDevCapacity`),
    N from `health.policy.requiredPoints` (default 8) — e.g. 1 VL + 1 Offset → 6 = 8 − 2.

## Changelog v1.38 (2026-07-01 — formatted sprint-review export: Excel + PDF + per-member table; ADR-048, react-app)

Frontend only; **no new tool, jira tools stay 36, IO shapes unchanged** (reuses `get_sprint_report` +
`get_leaves` + `get_offset_ledger`). Adds one runtime dep, `xlsx-js-style`.

140. **Full sprint review → styled Excel / printable PDF, with a per-member table (ADR-048).** The export
    dialog (formerly CSV only) now offers **Excel (.xlsx)** (styled workbook via `xlsx-js-style` — title
    band, section headers, bordered member table, bold TOTAL), **Print / PDF** (self-contained print-ready
    HTML), and **CSV** (unchanged). A shared model powers all three: `buildSprintReviewMeta` (the
    Field/Value pairs) + `buildMemberReviewTable(report, leaves, ledger, requiredPoints, roster)` = one row
    per **roster developer ∪ anyone with points/leaves/offset**, with **committed = capacity =
    max(0, N − leave days)** (N = `health.policy.requiredPoints`; NOT the member's assigned tickets),
    **completed = done points**, leave days per type (VL/EL/Holiday/Offset over working days), and offset
    balance. **The summary "Commitment points" is prefilled from the TOTAL team capacity** (Σ committed over
    the roster), not Jira's committed. Reports (`SprintReportView`) reads `useLeaves(sprintId)` +
    `useOffsetLedger()` + `usePolicy()` + `useTeamMembers(sprint.boardId)` and threads them to the export.
141. **Sprint-goal newline normalization (ADR-048).** A multi-line Jira sprint goal is collapsed to one
    line joined with " · " (`normalizeGoal`) for both the on-screen Reports goal and the export — fixes
    the goal rendering run-on (newlines→spaces) on-screen and the first-line-only truncation in exports.
    All client-side download/print — no Jira writes.

## Changelog v1.39 (2026-07-03 — typed leaves on Planning + export cleanup + header shell; ADR-049, react-app)

All frontend/presentation; **no new tool, jira tools stay 36, IO shapes unchanged**.

142. **Planning leave calendar gains the typed leave painter.** The Offset Tracker's leave-type picker is
    extracted into a shared `LeaveTypePicker` (Vacation/Emergency/Holiday/Offset, ADR-038 visuals) and
    added to `LeavesPlotterCard` — pick a type, then click days; the type flows through the calendar's
    existing `paintType` into `set_leaves` typed entries. Same control on both pages.
143. **Export surfaces simplified.** Reports export toolbar is now **Copy · Full report · Print/PDF**
    (the ".md" and plain ".csv" downloads are removed; `buildReportMarkdown` still powers Copy). The Full
    report dialog footer is now **Cancel · Download as PDF · Download as CSV (Styled Format)** — the
    plain Field/Value CSV button is removed; the styled download remains the `.xlsx` workbook (the pure
    `buildReportCsv`/`buildSprintReviewCsv` builders stay in §6 as library functions).
144. **Shell: navigation back in the top header, full-width compact layout (ADR-049).** The v1.24 left
    sidebar is replaced by a single sticky header (brand · horizontal nav tabs · board/project controls ·
    version pill). `<main>` loses its `max-w-[1400px]` cap — every page now spans the full viewport with
    compact paddings (header h-12, main px-3/5 py-4). role=tab semantics and landmarks preserved.
145. **Full-screen polish after a live UI review (ADR-049 refinement, 2026-07-04).** Verified against the
    running app with real sprint data: `<main>` gains a soft `max-w-[1800px]` centered cap (ultrawide
    hygiene only); the leaves calendar/planner tables stop stretching (`w-full`→`w-auto`) and show FULL
    member names (truncation caps 80–90px→200px, assignee column min 170px, planner gutter `px-12`→`px-4`);
    the per-dev capacity table caps at `max-w-xl` and the Reports sprint select at `max-w-md`. Second pass
    (user: "too much blank white space"): the **leaves/capacity plotter, leave-planner, and offset-points
    CARDS are `w-fit max-w-full`** — each card shrink-wraps its content so the page background, not empty
    white card, fills the remaining width. Presentation-only; no behavior change.

## Changelog v1.40 (2026-07-04 — P1 batch: live-verified writes + assistant upgrades + freshness; ADR-050)

146. **Write paths LIVE-VERIFIED against real Jira (2026-07-04).** create_po_ticket, create_dev_ticket ×3
    (link + storyPoints + assigneeAccountId — no warnings), update_ticket points, assign_issue, and the
    PO→2-Dev breakdown all executed successfully. The dependency link required an env fix: the instance's
    type is named **"Depends on"** (`JIRA_LINK_TYPE` in `.env` updated from the stale `Relates`).
    **⚠ The direction was misread here: with payload inward=dev/outward=po the PO actually read "is depended
    upon by VRDB-x" (i.e. Dev depends on PO — backwards). Corrected in v1.42 (item 159) by swapping the keys.**
    Test tickets VBPO-1551 / VRDB-2740..2742 left for the team to delete.
147. **§4.9 — assistant read allowlist grows by 3.** `get_issue_pull_requests` (dev-panel PRs),
    `get_all_leaves`, and `get_offset_ledger` join READ_TOOLS — the assistant can now answer PR-review
    and offset/leave-balance questions.
148. **§4.9 — assistant conversation memory.** `/api/ai/ask` input gains optional `history` (≤8 prior
    `{role, content}` turns, content ≤2000), folded into the system prompt so follow-ups resolve
    references. ChatPanel sends its recent Ask-mode turns automatically.
149. **§4.9 — assistant may propose `set_leaves`.** Added to WRITE_TOOLS (proposal-only; same modal
    confirmation; never auto-executed). ConfirmActionDialog renders non-primitive args as JSON so the
    entries list is reviewable.
150. **Huddle freshness (react-app).** The Dashboard auto-refreshes the sprint + huddle every 5 minutes
    (pure `useAutoRefresh` hook) and shows an "Updated HH:MM" stamp; manual actions still refetch as before.
151. **Reports Completion Summary — remaining-by-status row (react-app).** Under the Committed / Completed /
    Carryover tiles, a compact row splits the not-completed points by raw status (To Do / In Progress —
    code review counts as completed per the ADR-014 DoD) via a pure `remainingByStatus(notCompleted)`
    helper — fills the card's dead space with signal.

## Changelog v1.41 (2026-07-04 — Huddle rich meeting notes with WYSIWYG editor; ADR-051)

152. **§4.27 (new) — `get_meeting_notes` / `set_meeting_notes`.** Per-sprint rich-text meeting notes
    (deployment notes, links) as an HTML string in a bridge-side JSON store
    (`JIRA_MEETING_NOTES_FILE`, default `<mcp-jira>/.invokeboard-meeting-notes.json`). Empty html clears
    the entry. jira tools **36 → 38**; smoke's expected-tool lists updated.
153. **Huddle "Meeting notes" card (react-app).** New `MeetingNotesCard` on the Huddle sidebar (under
    Meeting goal): renders the saved notes as sanitized HTML (links open in a new tab) and edits them in
    a **TipTap WYSIWYG editor** (`@tiptap/react` + starter-kit + link extension — NEW deps, with
    `dompurify` sanitizing **on save and on render**). Toolbar: bold, italic, strikethrough, H2,
    bullet/ordered list, link/unlink. `useMeetingNotes(sprintId)` hook + `meetingNotesClient`.
154. **§4.9 — `get_meeting_notes` joins the assistant read-allowlist** (17 read tools) so the chatbot can
    answer "what are the deployment notes for this sprint?".

## Changelog v1.42 (2026-07-06 — P2 batch: burndown + persisted retro + attention nudges; ADR-052)

155. **§3 — `IssueSummary` gains `resolvedAt?` and `updatedAt?`** (Jira `resolutiondate` / `updated`,
    both `string | null`). Additive — the sprint-issue endpoint already returns these fields; only the
    mapper and types change. Feeds the burndown (resolution dates) and staleness detection (updated).
156. **Reports — Burndown chart (react-app).** Pure `lib/burndown.ts` `computeBurndown(committedPoints,
    completedIssues, workingDays, today)`: per working day, `remaining = committed − Σ points of issues
    with resolvedAt ≤ that day`; days after "today" are omitted (active sprints show a partial line);
    plus the ideal committed→0 line. Rendered as a dependency-free SVG line chart (`BurndownCard`) on the
    Reports page. Known limits (documented): baseline = CURRENT committed (scope creep not re-based);
    code-review-complete issues burn only when Jira marks them resolved.
157. **§4.28 (new) — `get_retro` / `set_retro` (persisted retrospective).** Per-sprint retro fields
    `{ reasonForDelays, whatWorkedWell, whatDidNotWork, plannedImprovements, kudos }` (each ≤ 4000) in a
    bridge-side JSON store (`JIRA_RETRO_FILE`, default `<mcp-jira>/.invokeboard-retro.json`); `set_retro`
    stamps `updatedAt`; all-empty fields clear the entry. jira tools **38 → 40**; smoke lists updated.
    Reports gains a **Retrospective card** (inline editable, saved to the store) and the Full-report
    dialog **pre-fills from the store** (and saves typed values back on export) — the retro is written
    once, not retyped at export time. `get_retro` joins the assistant read-allowlist (18).
158. **Huddle — Attention card (react-app).** Pure `lib/attention.ts` `buildAttention({ issues, prsByKey,
    today, staleDays=3 })` → prioritized nudges: **stale in-progress** (in-progress + no `updatedAt` in
    ≥ staleDays calendar days; not double-flagged when unassigned), **unassigned** unfinished tickets, and
    **PRs awaiting review** (`status==="open" && decision==="review_required"`). `today` is injected so the
    function is pure. Rendered as a compact sidebar card at the top of the Huddle's widgets (reuses the
    already-lifted `sprintIssues` + `issuePrs`); empty state = "All clear".
159. **§2 / §4.2 — PO↔Dev dependency link direction FIXED (was backwards).** `create_dev_ticket` swapped
    the `issueLink` payload to `inwardIssue = PO, outwardIssue = Dev` so the story reads **"PO depends on
    Dev"** (previously `inwardIssue = Dev` made it read "Dev depends on PO"). Root cause: in the team's
    Jira the **inward** issue displays the link type's **outward** description ("depends on"), the opposite
    of the assumption in v1.36/v1.40. Also: `JIRA_LINK_TYPE` default `"Depends"` → **`"Depends on"`** (the
    exact link-type name in the instance, so a missing `.env` no longer produces an invalid type). Verified
    live against real Jira on the test tickets. `.env.example` / README updated off the stale `Relates`.

## Changelog v1.43 (2026-07-07 — collapsible Huddle sidebar cards; ADR-053)

160. **§6 — Huddle sidebar cards are collapsible (react-app, presentation-only).** Each right-column
    card (Needs attention, Meeting goal, Meeting notes, Impediments, On leave, Code review, and the Daily
    Huddle digest) gets a chevron in its header that collapses/expands the card body independently. State
    is remembered per browser in `localStorage` (`invokeboard.collapse.<key>`, default expanded). Shared
    `hooks/useCollapse.ts` + `components/CollapseToggle.tsx`; no tool/HTTP/IO change. react-app pill
    **1.42.0 → 1.43.0**. Live-verified: toggle hides the body and the choice survives a reload.

## Changelog v1.44 (2026-07-09 — Task Helper: per-user accounts + AI ticket→prompt; ADR-054)

161. **§8 (new) — Task Helper.** Additive, team-internal section on the mcp-jira bridge: signup/login,
    encrypted per-user Jira/GitHub connections, fetch-my-sprint-tickets, and an AI pipeline
    (refine → technical plan → prompt-engineer) producing `{ refinedText, prompt }`. New env
    `TOKEN_ENC_KEY` / `SESSION_SECRET` / `TASK_HELPER_FILE`; feature 503s unless both secrets set. New
    endpoints `/api/auth/*`, `/api/me/connections*`, `/api/me/tasks/*` (auth-gated). **Zero new deps** —
    Node `crypto` (AES-256-GCM tokens, HMAC sessions, scrypt passwords) + a git-ignored JSON user store
    (mirrors §4 stores). Tokens **never returned to the client or logged**. The MCP tool registry (40),
    stdio server, and shared board are untouched. react-app gains a login-gated **Task Helper** tab.
162. **v1.44.1 bugfix — §8.5 fetch-my-issues uses `/rest/api/3/search/jql`.** Atlassian **removed** the
    classic `GET /rest/api/3/search` (now **410 Gone**); `userJira.fetchMySprintIssues` migrated to the
    replacement `/rest/api/3/search/jql` (same issue shape; `fields` explicit; first page). The 40 MCP
    tools were unaffected (they read sprint issues via the Agile API). Verified live against real Jira.

## Changelog v1.58 (2026-07-17 — ticket aging: changelog-derived Work Item Age; ADR-070)

163. **§4.3 — `get_active_sprint` gains `withAging?: boolean` (default false).** When true, the
    inprogress + codereview buckets are enriched with `inProgressSince` via the dedicated paginated
    per-issue changelog endpoint (`GET /rest/api/3/issue/{key}/changelog`), bounded 2-page fetch
    (page 1 + tail page when total > 100), latest transition whose `toString` equals the CURRENT
    status; no match / fetch failure → `null` (never a guess). Default false performs zero changelog
    calls — velocity/report tools are unaffected.
164. **§3 — `IssueSummary` gains `inProgressSince?: string | null`** (populated only under
    `withAging: true`).
165. **§3 env / §9.5 — aging policy.** `JIRA_AGING_BASE_DAYS` (default 1) + `JIRA_AGING_DAYS_PER_POINT`
    (default 1); expected days in status = base + perPoint × storyPoints (unpointed = base only).
    Admin-configurable (global + per-user overrides). Exposed as a NEW sibling `aging` key on
    `GET /api/health` (global) and `GET /api/me/context` (per-user via the ADR-062 runWithUser
    pattern). UI tiers: ok < 100% of expected, watch ≥ 100%, overdue ≥ 150% (react-app `lib/aging.ts`).

## Changelog v1.59 (2026-07-17 — multi-sprint report + velocity KPIs; ADR-071)

166. **§4.29 — NEW tool `get_multi_sprint_report`** (jira tools 42 → 43): one aggregated report
    across a window of sprints. Pool path (default): the last `sprintCount` (1..26, default 10)
    closed sprints (+ active when `includeActive`), optional strict-before `beforeSprintId` anchor —
    the `get_velocity` selection verbatim, via `sortClosedSprintsLatestFirst` extracted into
    `sprintSelect.ts` from the previously duplicated getVelocity/listSprints closed-sort. Explicit
    path: `sprintIds` (1..26 entries, mutually exclusive with `sprintCount`/`beforeSprintId` →
    400 VALIDATION; refine-in-handler). Output: chronological per-sprint entries (points, rate,
    counts, byAssignee — §4.12 math, same DoD) + window `totals`, `averageCompleted`,
    `averageCompletionRate`, and a cross-sprint `byAssignee` aggregate (`sprintsActive`,
    `avgDonePoints` = donePoints / FULL window). Date-range selection is client-side over
    `list_sprints` dates → concrete `sprintIds`.
167. **§4.9 — AI Q&A read-allowlist** += `get_multi_sprint_report` (18 → 19 read tools). Smoke
    expected-jira-tools list +1 (NOT added to the empty-input-validation loop — all-optional
    schema, `{}` is valid input, same class as `get_velocity`).
168. **Reports UI — "Sprint report | Trends & KPIs" mode toggle** (client-only; mode inside Reports,
    no new tab per the ADR-060 tab-crowding precedent): Last-N (default 10) / pick-sprints /
    date-range selection → one `get_multi_sprint_report` fetch; team + per-developer velocity &
    trend sections + markdown/CSV export. Guide + USER-GUIDE updated.

## Changelog v1.60 (2026-07-17 — Huddle attention removal + leave-adjusted Trends KPIs; ADR-072)

No tool, route, or env surface changes — UI-only release (client-side joins of EXISTING tools).

169. **Huddle — "Needs attention" card REMOVED** (retires the ADR-052 Phase C surface): the v1.58
    Aging card supersedes the stale-ticket signal; the unassigned/PR-review nudges leave the Huddle
    with it. `lib/attention.ts` is deleted; its calendar-day helpers (`daysSince`/`toUtcMidnight`)
    relocate into `lib/aging.ts` (their only remaining consumer).
170. **Huddle — Aging card lists ALL tracked in-flight tickets**: the static "+N more" trailer
    becomes a "Show all N / Show less" toggle; the expanded list scrolls (max-height) so a 30-deep
    WIP list stays usable.
171. **Reports · Trends & KPIs — per-developer KPIs are leave-adjusted** (client-side join of
    `get_all_leaves` × the per-user `policy.requiredPoints` — zero new backend surface): per dev
    per sprint, `leaveDays` = plotted days of ANY type (VL/EL/Holiday/Offset — the ADR-038/048
    capacity convention: one leave day = one point of relief), adjusted target =
    `max(0, requiredPoints − leaveDays)`, met = donePoints ≥ adjusted target. Developers with
    plotted leaves but zero issues in a sprint still appear (names = byAssignee ∪ leaves).
    The per-dev bar chart renders donePoints against the adjusted target as its secondary series.
172. **Reports · Trends & KPIs — date range is the DEFAULT selection mode**, pre-filled to the span
    of the last 10 closed sprints (start = 10th-most-recent closed sprint's startDate, end = today);
    Last-N and pick-sprints modes remain.

## Changelog v1.61 (2026-07-17 — Trends hardening + styled exports, DoD-true aging, Task Helper UI retired; ADR-073)

Tool/route/env surface: ONE amendment (§4.3 step 8 — aging bucket scope). Everything else is UI.

173. **§4.3 step 8 amended — `withAging` enriches ONLY the `inprogress` bucket.** Code review counts
    as done (ADR-014 DoD), so code-review tickets are not "aging": they no longer fetch changelogs
    (cost drops to ≤ 2 calls per genuinely in-progress issue) and never carry `inProgressSince`.
    UI: age chips render only in the In Progress column; the Aging card receives the inprogress
    bucket alone.
174. **Aging display clamps to the sprint** (UI-only): shown age = days since
    `max(inProgressSince, sprint.startDate)` — a ticket carried in mid-flight starts its clock at
    sprint start. The tool's `inProgressSince` stays the raw changelog fact.
175. **Trends window is capped client-side at the §4.29 limit (26 sprints)**: date-range and
    pick-sprints selections keep the NEWEST 26 with a visible "showing the latest 26" note, so a
    wide range can no longer produce a 400 VALIDATION error; pick-mode checkboxes disable at 26.
176. **"Unassigned" is a ticket state, not a developer**: filtered out of the per-developer KPI
    union, the developer picker, and every per-assignee export section (markdown/CSV/xlsx). Team
    committed/completed totals are untouched (they sum issues, not assignees).
177. **Trends styled exports (xlsx-js-style, the ADR-048 technique)** — TWO separate downloads:
    a styled **team trends** workbook from the export bar (per-sprint rows + totals/averages) and a
    styled **developer KPIs** workbook from the Developer KPIs section (leave-adjusted columns:
    done, leaves, adjusted target, met). Markdown/CSV exports remain.
178. **Reports opens in Trends & KPIs mode by default** (the mode toggle still switches back to the
    single-sprint report).
179. **Task Helper UI retired** (tab, page, sprint-journal card, Guide + USER-GUIDE sections,
    frontend-only clients). The §7/§8 backend endpoints and stores remain in place but DORMANT
    (unchanged contract surface; no smoke changes) — login, Connections, Admin, and
    `GET /api/me/context` are app-wide infrastructure and unaffected. (ADR-073.)

## Changelog v1.62 (2026-07-18 — team trends workbook: per-developer aggregate section; ADR-074)

UI-only (export layer); no tool/route/env changes.

180. **The styled "Team trends" workbook gains a BY DEVELOPER section** below the AVERAGE row —
    the §4.29 cross-sprint `byAssignee` aggregate that the markdown/CSV exports have carried since
    v1.59, now in the styled .xlsx too: Assignee · Sprints active · Done pts · Total pts ·
    Avg done / sprint (raw `avgDonePoints` — the FULL-window velocity convention, NOT
    leave-adjusted; the leave-adjusted view stays in the Developer KPIs workbook). "Unassigned"
    is filtered (v1.61 item 176 rule). Same styling pass as the existing sections.

## Changelog v1.63 (2026-07-18 — atomic store writes + deployment hardening; ADR-075)

No tool/route/env surface changes — a durability guarantee + docs. Store file FORMATS unchanged.

181. **Every JSON store write is now crash-atomic.** All 11 mcp-jira store modules (leaves, team,
    impediments, prs, post-scrum, meeting-goal, offset, meeting-notes, retro, journal, users)
    write through one shared `writeJsonAtomic(filePath, data)` helper: serialize → write to a
    same-directory `<file>.tmp` → `fs.renameSync` over the target (atomic on the same filesystem).
    A crash or power loss mid-write can no longer truncate/corrupt a store — the old file survives
    intact. Read paths, file names, and JSON shapes are byte-identical. `.gitignore` += `*.tmp`
    (a crash may leave a stale temp file behind; readers ignore it).
182. **DEPLOYMENT.md production-hardening checklist expanded** (the security-review findings):
    TLS is mandatory (the one hop where a pasted token crosses in clear + session cookies);
    `NODE_ENV=production` must be set or the session cookie's `secure` flag stays off; back up the
    data volume on a schedule and NEVER into the same artifact as `.env` (`TOKEN_ENC_KEY` must not
    travel with the ciphertext it unlocks); prefer fine-grained GitHub PATs and Atlassian scoped
    API tokens with expiries (rotation = reconnect in Connections); exactly ONE bridge replica
    (JSON stores cannot be shared across instances). Login brute-force protection status
    verified and documented (report-only this release).

## Changelog v1.64 (2026-07-18 — total rebrand: Loopboard → InvokeBoard; ADR-076)

No tool names, routes, ports, or error codes change. The rename touches identity surfaces only.

183. **App identity: "InvokeBoard"** — UI banner/title and every user-facing mention; root package
    `invokeboard`; npm scope `@loopboard/*` → `@invokeboard/*` (lockfile regenerated); Docker
    images `invokeboard/*` + volume `invokeboard-data`.
184. **§3 store-file DEFAULTS renamed**: `.loopboard-*.json` → `.invokeboard-*.json` and the
    per-user store dir → `.invokeboard-user-stores/` (config.ts DEFAULT_*_FILE constants +
    .gitignore patterns). Existing host-local data files are MIGRATED by rename (`mv`) — data
    preserved; explicit `*_FILE` env overrides keep working unchanged. Frontend localStorage
    keys `loopboard.*` → `invokeboard.*` (persisted UI prefs like card-collapse reset once).
185. **Docs**: all LIVING docs fully renamed (README, CLAUDE.md, this contract, SETUP,
    DEPLOYMENT, ARCHITECTURE, USER-GUIDE, ASSISTANT). ADR-001..075 are dated history and keep
    the old name (the ADR-076 precedent, same as the Agile-AI-Companion → Loopboard rename).
    Jira's `/rest/agile/1.0/` API paths are Atlassian's, not brand strings — untouched.
186. **Repo + folder**: GitHub repo renamed `jrglomar/invokeboard` (old URLs redirect; open PRs
    survive); working folder `C:\Projects\invokeboard`; `origin` remote URL updated.

## Changelog v1.65 (2026-07-18 — working-day timeline + pluggable storage (json | sqlite); ADR-077)

187. **Huddle timeline counts WORKING days** (UI-only): "Day N of M · X days left" is now Mon–Fri
    only, built on the SAME `sprintWorkingDays` list burndown and capacity already use (one
    convention, no third copy). On a weekend, the day number clamps to Friday's (no phantom
    progress), and days-left counts remaining workdays. The pace heuristic (%time vs %points)
    consumes the timeline fraction and follows automatically.
188. **§3 — pluggable storage.** New env: `STORAGE_DRIVER` = `"json"` (default — dev behavior,
    byte-identical to v1.63/64: per-store files, `*_FILE` overrides honored, crash-atomic writes)
    | `"sqlite"` (production: one better-sqlite3 database file, default
    `.invokeboard-stores.sqlite`, override `STORAGE_SQLITE_FILE`; Docker compose points it at the
    `/data` volume). Every store's IO now routes through one storage port —
    `readDoc(scope, name)` / `writeDoc(scope, name, data)` where scope = shared or a user id —
    so all 11 stores (and the per-user store dirs) keep their exact logic and JSON shapes on both
    drivers. better-sqlite3 is SYNCHRONOUS — the store/tool/route call graph stays sync. In
    sqlite mode the per-store `*_FILE` env overrides are not applicable (documented).
189. **Auto-import on first sqlite boot**: when `STORAGE_DRIVER=sqlite`, the docs table is EMPTY,
    and JSON store files exist at their (json-driver) paths, the bridge imports them once at
    startup — loudly logged, JSON files left untouched as a natural backup. DEPLOYMENT.md:
    production may set `STORAGE_DRIVER=sqlite`; backup guidance covers the single sqlite file;
    the one-replica rule is unchanged (sqlite is still per-instance).

## Changelog v1.67 (2026-07-21 — granular per-provider credential sharing + admin email edit + self-service password change; ADR-078)

190. **§9.8.6 — granular per-provider sharing.** `StoredUser.sharedProviders?: ConnectionProvider[]`
    (undefined = share ALL providers the user doesn't own, the exact legacy §9.8 behavior — zero
    migration for existing shared accounts). An explicit array restricts fallback-sharing to only
    the listed providers; `getEffectiveConnection` returns `null` for a provider left off the list
    even when the credential source genuinely has that connection. A user's own connection for a
    provider still always wins. Admin CRUD (`POST`/`PUT /api/admin/users*`) accepts it; `PUT`
    treats `null` as clearing the restriction back to share-all (same convention as
    `credentialSourceUserId: null`).
191. **Admin view: own vs inherited vs none.** `userView()` adds `effective: { jira, github, ai }`
    (each `{status:"own"} | {status:"inherited", via} | {status:"none"}`, via `getEffectiveConnection`)
    and `sharedProviders`, alongside the unchanged own-only `connections` flags. The admin console's
    per-user connection badges become a 3-state indicator ("Jira" own / "Jira via admin@co.com"
    inherited / "Jira" none) instead of a plain on/off badge, so an admin can tell a borrowed token
    apart from a genuinely absent one at a glance — previously both read `false`.
192. **Admin UI: three sharing checkboxes + email edit.** "Share Jira" / "Share GitHub" / "Share AI"
    checkboxes (default CHECKED) appear next to the existing "allow Jira writes" checkbox wherever a
    credential source is picked (`AddUserCard`, `UserSetupForm`); create omits `sharedProviders` when
    all three stay checked (byte-identical legacy payload), the combined "Save changes" (v1.52,
    ADR-063) always sends it (`null` = all-checked). `UserSetupForm` also gains an `Email` input
    (the server has accepted `email` on `PUT /api/admin/users/:id` since ADR-056/v1.46 — the admin
    console just never exposed a field for it), folded into the same access-dirty tracking and save.
193. **§8.3 — self-service password change.** `PUT /api/auth/password` `{ currentPassword,
    newPassword(≥8) }` (any signed-in role; `requireAuth`) verifies the current password
    (`verifyPassword`) before updating the hash — `401 INVALID_PASSWORD` on mismatch, `400
    VALIDATION` on a too-short new password. Distinct from the admin's password RESET
    (`PUT /api/admin/users/:id { password }`, §9.8.4), which is an admin acting on someone else's
    account and doesn't require the old password. Surfaced as an "Account" card on the app-wide
    (not role-gated) Connections page, reachable by both "user" and "admin" roles.
194. **Tests**: mcp-jira 613 → **626** (+13: 5 delegation `sharedProviders` restriction cases, 4
    admin-view own/inherited/none + `sharedProviders` CRUD, 4 self-service password-change route);
    react-app 950 → **958** (+8: 5 Admin console sharing-checkbox/email-edit/inherited-badge
    cases, 3 Connections "Account" card password-change cases); mcp-github unchanged at 57. Total
    **1,641**; smoke 55/55.

## Changelog v1.68 (2026-07-21 — PO draft capacity plan: dev roster + capacity on the PO Planning page; ADR-079)

195. **§4.30 — `get_draft_plan` / `set_draft_plan`.** New per-PO-sprint store tools (same §4.21
    bridge-side store pattern, storage port json|sqlite, ADR-077): a DRAFT mapping of the PO
    sprint's tickets onto Dev-board team members (`assignments: Record<issueKey, { accountId,
    displayName }>` + the paired `devSprintId`). Full-replace per sprint; empty assignments deletes
    the entry. **Never writes to Jira** — real assignment remains `assign_issue` (§4.15) on the Dev
    board. jira tools 43 → **45**; `get_draft_plan` joins the AI Q&A read-allowlist (19 → **20**).
196. **§3 — `JIRA_DRAFT_PLAN_FILE`** (optional, default `<mcp-jira>/.invokeboard-draft-plan.json`);
    storage `registry.ts` gains the `draft-plan` name (json override + sqlite auto-import, ADR-077).
197. **react-app — Draft Capacity Plan card (PO board Planning only).** Dev-board roster tiles with
    per-developer capacity in points (ADR-047 model: `requiredPoints − working leave days`, leaves
    read from a PAIRED Dev sprint — default picked by date overlap with the PO sprint, overridable
    via a native select). PO ticket chips drag-and-drop onto developer tiles PLUS a per-ticket
    native "Draft to…" select fallback (ADR-009 — no dnd dependency); per-tile drafted-points total
    with an over/under delta chip (advisory only, never blocking); persisted via §4.30 with
    optimistic save + rollback; in-card "Manage dev team" = the existing `TeamManager` bound to the
    Dev board id (why devs "didn't show" before: rosters are per-board by design, ADR-019). The
    card is draft-only and never calls `assign_issue`.
198. **Tests**: mcp-jira 626 → **644** (+18: 17 draft-plan store/tool cases + 1 AI read-allowlist
    growth); react-app 958 → **1031** (+73: pairing 13, draft rollups 15, client 7, useDraftPlan
    hook 10, DraftPlanCard 25, Planning wiring 3); mcp-github unchanged at 57. Total **1,732**;
    smoke 55/55 → **60/60** (tool count 43 → 45 verified). react-app package version (the UI
    version pill, v1.13.1) bumped 1.65.0 → **1.68.0** — v1.66/v1.67 had skipped the bump.

## Changelog v1.69 (2026-07-21 — Draft Capacity Plan chips gain the usual ticket actions + rename; ADR-080, react-app only)

199. **react-app only — no tool/route/env changes.** The v1.68 Draft Capacity Plan chips dropped
    the per-ticket actions the Assign Tickets table has; the PO had to scroll to the table for
    points/status/sprint edits. The card's ticket chips (unplanned AND drafted-in-tile) now carry:
    inline story-points input; and a per-chip "Edit" expander with **rename** (new `SummaryCell` →
    `update_ticket { summary }` — §4.5 accepted `summary` all along, so NO backend change), status
    change (lazy `get_transitions` → `transition_issue`), and move-to-sprint
    (`move_issue_to_sprint`). Field edits refetch the PO sprint so tile totals/capacity deltas stay
    truthful; a move initiated FROM the card also removes the ticket's draft entry in the same
    action (a deliberate move must not leave a "Needs attention" stale row). The expanded editor
    carries the note "These edits change the real Jira ticket." — the card's "Draft only" badge
    keeps meaning ASSIGNMENTS (`assign_issue` is still never called).
200. **Shared cells extracted** — `PointsCell`/`StatusCell`/`MoveSprintCell` move verbatim from
    `AssignmentList.tsx` to `components/ticketCells.tsx` (+ new `SummaryCell`); both cards import
    them. `PointsCell` gains an optional `onSaved` callback, wired in BOTH cards — in the Assign
    Tickets table this fixes the pre-existing stale filtered-points summary after an inline points
    edit. The table's Summary column becomes the same rename-capable `SummaryCell`. New
    `updateTicketSummary(ticketKey, summary)` client next to `updateTicketPoints` (useJira.ts).
201. **Ticket breakdown.** The per-chip editor gains "Break down": a dialog that splits a too-big
    PO story into N new PO stories (2–6 rows, summary + points each), created in the SAME PO
    sprint via the existing `create_po_ticket` (§4.1 — `storyPoints` + `sprintId` supported
    already; NO backend change). Sequential per-row creation with per-row success/error (the
    Linking page's resilient-bulk pattern); succeeded rows lock so a retry never duplicates;
    optional "set the original's points to 0 after creating" (one `update_ticket` call); on
    success the sprint refetches — the new stories appear as unplanned chips ready to draft. No
    PO↔PO Jira link is created (the configured `JIRA_LINK_TYPE` carries PO→Dev dependency
    semantics, §4.2); each new story's description records "Broken down from <KEY>".
202. **Capacity-source transparency (fixes the live "every dev shows 8" report).** All-8s means
    the leaves read for the paired Dev sprint came back empty — a wrong paired sprint, leaves
    plotted under a different sprint (the Offset Tracker defaults to the ACTIVE sprint while
    pairing prefers FUTURE on ties), or a per-user store-scope mismatch (ADR-056) all look
    identical and silent. Three changes: (1) under the Dev-sprint select the card now shows
    either "N leave/offset day(s) found across M member(s)" or a warning-toned "No leaves or
    offsets recorded under this Dev sprint — pick the sprint where the team plotted them
    (Dev-board Planning or the Offset Tracker)"; (2) the AUTO pairing is no longer persisted as
    a side effect of drafting — only an explicit pick in the select stores `devSprintId` (draft
    mutations pass through the STORED value, staying `null` until chosen), with an
    "Auto-paired" label when the default is in use and a "Reset to auto" button when a stored
    choice exists; (3) tiles show a loading state while the Dev sprint's leaves load instead of
    flashing full capacity. The unplanned chip's drag affordance is disabled while its editor is
    expanded (dragging a draggable ancestor hijacks text selection in the rename/points inputs).
203. **Tests**: react-app 1031 → **1066** (+35: ticketCells 13, DraftPlanCard +18,
    AssignmentList +4 rename cases; Planning assertions extended in place); mcp-jira/mcp-github
    unchanged (644/57) — total **1,767**; smoke unchanged **60/60** (no backend surface touched).
    react-app package version (the UI version pill) bumped 1.68.0 → **1.69.0**.

## Changelog v1.70 (2026-07-21 — Draft Capacity Plan: pure-draft multi-developer point split + full-width redesign; Assign Tickets owns Jira writes; ADR-081)

204. **§4.30 shape change — a ticket splits across MULTIPLE developers.** `DraftShare[]` per issue
    key (`{ accountId, displayName, points }`) replaces the single `DraftAssignment`. One PO story
    can now be drafted to several developers, each carrying a DRAFT slice of the points ("breakdown
    points"). Points are draft-only — defaulting to the ticket's real Jira points when drafted
    whole, over/under-allocation allowed, **never written to Jira**. `readDraftPlans()` migrates any
    pre-v1.70 single-object value to a one-element array (`points: 0`); tool count unchanged (45).
205. **The Draft Capacity Plan card is now strictly Jira-write-free** (fixes the reported concern
    that draft-card edits hit Jira). Removed from the card: inline points WRITE, rename, status
    change, move-to-sprint, and the real (ticket-creating) breakdown. Real Jira points show
    **read-only**. What stays: draft ticket→developer splits (server-side draft store), per-share
    DRAFT point manipulation, per-developer capacity vs drafted load with over/under, the v1.69
    leaves/offset capacity-source transparency + non-sticky pairing, and the embedded dev
    `TeamManager`.
206. **Assign Tickets is the single real-edit surface** (per the user's note "Assign Tickets should
    handle those actual changes in JIRA"). It keeps points/status/move/rename (v1.15/v1.37/v1.69)
    and **gains the real breakdown** — the `BreakdownDialog` (creates new PO stories via
    `create_po_ticket`, §4.1) relocates here from the draft card. No new tools/routes.
207. **Full-width two-tier redesign of the Draft Capacity Plan card** (UI/UX pass, `frontend-design`).
    Developers on TOP as a full-width responsive grid of capacity cards (drop targets: capacity pts,
    drafted load = Σ share points, over/under chip, their share chips with an inline DRAFT points
    input + remove); PO tickets on the BOTTOM at full width (real points read-only, an "N of M pts
    drafted" allocation indicator, the developers a ticket is split across, drag + a native
    "Draft to…/Add developer" select — ADR-009 a11y path). Replaces the cramped left/right split so
    both tiers get full width.
208. **Tests**: mcp-jira 644 → **654** (+10: draft-plan multi-share round-trip, per-ticket de-dupe,
    points + empty-array validation, legacy single-object migration); react-app 1066 → **1099**
    (+33: draftPlan rollup over shares, DraftPlanCard multi-share/split/point-edit/read-only/
    full-width, AssignmentList breakdown relocation, ticketCells unchanged); mcp-github 57 — total
    **1,810**; smoke 60/60 (shape checks updated, no count change). react-app version pill
    1.69.0 → **1.70.0**.

209. **§4.9 — streaming Ask assistant (ADR-082).** New `POST /api/ai/ask/stream` runs the same
    agentic loop but emits SSE frames (`step` / `delta` / `cards` / `proposed` / `done` / `error`).
    `chatWithToolsStream(system, messages, tools, onDelta)` added to the `AiProvider` port: Anthropic
    streams true token deltas via `messages.stream`; GitHub Models uses a **buffered fallback**
    (delegates to `chatWithTools`, emits the final text as one `delta`). Pre-flush errors still use the
    JSON envelope so the client can fall back to `/api/ai/ask`.
210. **§4.9 — `cards` on Ask output.** Both Ask endpoints now return `cards?: AskCard[]` (≤3),
    deterministically captured from the in-process results of card-able read tools
    (`get_ticket`→`ticket`, `get_active_sprint`→`sprint`, `get_daily_huddle`→`huddle`) — **no extra
    model call**. The ChatPanel renders them with the same result-card components the deterministic
    commands use, and renders assistant answers as **markdown** (`marked` + DOMPurify) with a
    tool-transparency trace ("Looked at: …").
211. **Tests**: mcp-jira 654 → **661** (+7: askAssistantStream event sequence + write-proposal
    short-circuit, cardForTool mapping, Anthropic/GitHub provider streaming); react-app +**12**
    (Markdown sanitize/render 4, aiClient SSE parser 5, ChatPanel stream + trace + card + fallback 3);
    mcp-github 57 unchanged; smoke 60 → **61** (stream 503 parity). react-app version pill 1.70.0 →
    **1.71.0**.

## Changelog v1.72 (2026-07-27 — link EXISTING Dev tickets to a PO story (+ unlink), and roll Dev tickets up into a NEW PO story; ADR-083)

212. **§4.31/§4.32 (new) — `link_dev_to_po` / `unlink_dev_from_po`.** Until v1.72 a PO↔Dev link
    could only be born inside `create_dev_ticket`, so a Dev ticket that already existed could never
    be attached to its PO story, and a wrong link could only be fixed in Jira directly. Two new
    **write** tools close that gap, **one pair per call — the client loops** (the same precedent §6
    sets for `create_dev_ticket`; no bulk MCP tool). Deliberately domain-shaped rather than a
    generic `link_issues({ inwardKey, outwardKey })`: the PO-inward/Dev-outward direction invariant
    shipped backwards once already (v1.42), and a generic tool re-exports that trap to every caller
    including Copilot over stdio. `link_dev_to_po` **pre-checks for an existing link and skips the
    POST** (`alreadyLinked`), flags a pre-v1.42 reversed link as `reversed`, and treats a *failed*
    pre-check as non-fatal (`precheckWarning`) so a broken read never blocks a legitimate write.
    `unlink_dev_from_po` verifies the link id actually connects the supplied pair before deleting,
    and treats Jira's 404 as success (`alreadyGone`) since Jira returns it both for "already gone"
    and "you can't see it". Both added to **`JIRA_WRITE_TOOLS`** (8 → **10**); neither joins the AI
    Q&A allowlists. jira tools **45 → 47**.
213. **§4.17 — `get_linked_issues` now carries link identity.** `LinkedIssueRef` gains `linkId`,
    `linkTypeName` and `direction` ("inward" | "outward"), all derived from the payload the tool
    **already fetches** — no extra Jira call. `direction` is what lets the Dev-side view tell a
    canonical link from a reversed one, since Jira only ever returns the *other* side of a link.
    Required server-side, **optional** in react-app's `LinkedIssue` so no existing consumer or test
    fixture changed. Also corrected two long-standing doc bugs here: the documented
    `fields=issuelinks,summary,status` never matched the code (`fields=issuelinks`), and the
    **"one or none"** claim contradicted already-shipped behaviour (ADR-046 creates 1–2 Dev tasks
    per PO story) — it was only ever a UI selection heuristic. Fixed in §4.17, §6 and ADR-022.
214. **§4.9 (new) — `POST /api/ai/draft-po-story`.** The inverse of `plan-dev-tickets`: N Dev tasks
    in, **one** covering PO story out (`{ assistantMessage, summary, description }`), with
    acceptance criteria derived from the tasks' real content. Bridge-only REST, never an MCP tool.
    It deliberately returns **no story points** — the new story's points are the arithmetic *sum* of
    the selected Dev tickets' points, computed client-side and seeded into an editable field.
    AI off/unavailable → 503, and the client falls back to a deterministic rollup (`lib/poRollup.ts`)
    so the flow never blocks.
215. **§6 — Linking becomes a 3-mode page.** `pages/Linking.tsx` drops from 707 lines to a ~150-line
    shell (shared sprint context + mode toggle + render switch); each flow is its own component
    under `components/linking/`. **Mode 1 "Create Dev tasks"** is the original flow, moved verbatim.
    **Mode 2 "Link existing"** picks a target PO story and links many existing Dev tickets to it
    (assignee + unlinked-only filters), with an inline two-click **unlink** on every link badge.
    **Mode 3 "New PO from Dev tasks"** drafts one PO story from N Dev tickets, then creates and
    links it. The two sprint selects change *meaning* per mode (source vs target) but keep their
    accessible names, so a11y queries stay stable. Modes 2/3 disable their submit controls behind a
    single banner for read-only shared-credential users instead of emitting N × 403 log rows.
216. **Mode 3's create-then-link is retry-safe by construction.** The created PO key is held in a
    ref and the create step early-returns once it has run, so **"Retry failed" re-links only and can
    never duplicate the PO story**; a failed create aborts before any link, leaving no orphan. Two
    dedicated tests pin both halves — the naive single-handler implementation duplicates the story
    on every retry.
217. **Shared extractions + drift fix.** New `hooks/useBulkRun.ts` (the sequential write loop +
    per-row status + retry-only-failures, lifted from mode 1), `components/BulkStatusLog.tsx`,
    `components/SprintSelect.tsx`, `components/linking/DevTicketPicker.tsx`, `lib/issues.ts`
    (`flattenIssues`, previously copy-pasted in 5 places) and `lib/poRollup.ts`. Separately, the
    **`toolCatalog` drift was repaired**: it had 43 jira rows against a 45-tool registry
    (`get_draft_plan`/`set_draft_plan` were never added) **and** the test's hand-synced
    `ASK_SERVICE_READ_TOOLS` copy was missing `get_draft_plan` — the two omissions cancelled, so the
    anti-drift test passed while both were wrong. Catalog is now **52** rows / **47** jira = the
    registry; the stale 48/43/"reads 19" counts in `USER-GUIDE.md` and the in-app Guide were
    corrected too.
218. **Tests**: mcp-jira 661 → **685** (+24: link direction invariant, type-scoped dedupe, reversed
    flagging, pre-check resilience, self-link/malformed rejection, four unlink-guard paths,
    `linkId`/`linkTypeName`/`direction` pass-through, bridge round-trip, the `READ_ONLY_USER` 403
    regression guard, `draft-po-story` 503/400/happy/not-a-tool); react-app 1108 → **1142** (+34:
    poRollup 7, useBulkRun 4, SprintSelect 3, DevTicketPicker 4, LinkExistingMode 7,
    NewPoFromDevMode 8, aiDraftPoStory 1); mcp-github 57 unchanged — total 1,826 → **1,884**;
    smoke 61 → **62** (`draft-po-story` 503 parity; expected jira tools 45 → 47). react-app version
    pill 1.71.0 → **1.72.0**.
