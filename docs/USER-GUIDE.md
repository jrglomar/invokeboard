# InvokeBoard — User Guide

**InvokeBoard** is an Agile team dashboard and AI assistant that sits on top of your Jira (and,
optionally, GitHub). It turns your sprint into a live board, a daily-huddle digest, planning and
reporting tools, leave/capacity tracking, and an AI helper that drafts tickets and answers
questions.

This guide has two parts:
- **[What InvokeBoard offers](#what-invokeboard-offers)** — a tour of every feature.
- **[Setting up InvokeBoard](#setting-up-invokeboard)** — how to connect it to your Jira and run it.

> Deeper docs: developer setup in [`docs/SETUP.md`](SETUP.md), deployment in
> [`docs/DEPLOYMENT.md`](DEPLOYMENT.md), the AI assistant in [`docs/ASSISTANT.md`](ASSISTANT.md),
> and the full API/behavior contract in [`docs/CONTRACTS.md`](CONTRACTS.md).

---

## What InvokeBoard offers

InvokeBoard is organized into tabs across the top. Your team works against two Jira boards — a **PO
board** (product / stories) and a **Dev board** (development tasks) — and a board switcher in the
top‑right lets you flip between them on most pages.

### 🟦 Huddle — the daily dashboard

Your run‑the‑standup home screen.

- **Sprint board** — the selected sprint's issues in **To Do · In Progress · Code Review · Done**
  columns, with points, assignees, and a "has‑PR" badge on linked tickets. Filter by assignee.
- **Daily Huddle digest** — a copy‑pastable summary of the sprint, viewable **by status** or **by
  person** (walk‑the‑board‑by‑person standups).
- **Sidebar widgets** (each collapsible — click the chevron in a card's header; your choices are
  remembered):
  - **Meeting goal** — today's standup focus (distinct from the Jira sprint goal).
  - **Meeting notes** — a rich‑text (WYSIWYG) notepad for deployment notes, runbook links, reminders.
  - **Impediments** — a per‑sprint blocker log.
  - **On leave** — who's out today and in the next 7 days.
  - **Code review** — pull requests linked to the sprint's tickets (multi‑repo), with approval status.
- **Fly‑in tracker** — a strip highlighting "fly‑in" tickets across the Dev and PO boards.
- **Auto‑refresh** every few minutes, with a "last updated" stamp.
- **Ticket aging** — the sprint board's **In Progress** tickets each carry an age chip, and the
  sidebar's **Ticket aging** card lists them worst‑first (code‑review tickets are *not* aged —
  code review counts as done, per your Definition of Done). Age is the time since the ticket
  entered the column (from the Jira changelog), and it never starts before the sprint does — a
  ticket carried over mid‑flight starts its clock at the sprint's start date. The expected time is
  `base days + days‑per‑point × story points` (unpointed tickets use base days alone) — both
  admin‑configurable. A ticket reads **ok** under 100% of that expectation, **watch** from
  100–150%, and **overdue** past 150%. Tickets with no changelog history show no age at all,
  rather than a guess.

### 🗓️ Planning — grooming & sprint prep

Everything you need to prepare the next sprint.

- **Create a sprint** and target new tickets into it.
- **Ticket generator** — draft PO stories and Dev tasks (AI‑assisted when AI is enabled; deterministic
  templates otherwise), created straight into the chosen board's sprint.
- **Leaves / team calendar** — plot each teammate's leave by type (Vacation / Emergency / Holiday /
  Offset); the plotter shows each developer's remaining capacity (required points − leave days).
- **Assignment list** — assign the sprint's tickets to developers (bulk‑assign supported), and edit
  story points inline.
- **Team roster** — curate the team members InvokeBoard plans around (drawn from recent sprint activity).

### 📅 Offset Tracker — leaves & offset wallet

- **Typed leaves** — Vacation, Emergency, Holiday, and **Offset** days per person.
- **Offset wallet** — earned offset banks automatically per sprint; spending auto‑deducts from Offset
  leaves. See each developer's balance and a full **history** of earns and spends.

### 🔗 Linking — connect PO stories and Dev tasks, in both directions

Three modes, switched at the top of the page. Both sprint pickers stay on screen; what they *mean*
changes per mode (source vs target).

**Create Dev tasks** (the original flow)

- Select PO stories and **bulk‑create linked Dev tasks**, with an AI plan drafted from each story's
  description.
- **Point‑driven breakdown** — a story's points auto‑split into one or two Dev tasks on the allowed
  scale (e.g. 4 → 2 + 2), each with its own points and assignee.

**Link existing** (v1.72) — for Dev tickets that already exist

- Pick a target PO story, then tick any number of **existing** Dev tickets from a Dev sprint and
  link them in one go. **Many Dev tickets can hang off one PO story.**
- Filter the candidate list by assignee, or show only tickets that have **no PO link** yet.
- Already‑linked pairs are detected and skipped rather than duplicated.
- **Unlink** — each link badge has an unlink control (click once to arm, again to confirm) for
  fixing a wrong link without leaving InvokeBoard.

**New PO from Dev tasks** (v1.72) — the inverse, for when the work landed first

- Select existing Dev tickets and have the AI draft **one PO story that covers all of them**, with
  acceptance criteria derived from the tasks themselves. Edit it, then create and link in one step.
- The new story's points are pre‑filled with the **sum** of the selected Dev tickets' points.
- When AI is off, the draft falls back to a deterministic template — the flow never blocks.

Links are always created so the **PO story "depends on" its Dev task(s)**.

### 📊 Reports — sprint review & metrics

- **Per‑sprint report** — committed vs. completed points, completion rate, and a by‑assignee table.
  (Code‑review‑complete counts as done, per your Definition of Done.)
- **Velocity** — the average of recent closed sprints, capacity‑adjusted for leave.
- **Burndown chart** — actual vs. ideal points remaining across the sprint's working days.
- **Retrospective** — a persisted retro (reason for delays, what worked, what didn't, improvements,
  kudos) that also **pre‑fills the full‑report export**.
- **Export** — Copy (Markdown), a **printable PDF**, or a **styled Excel** workbook with a per‑member
  table (committed/completed points + leaves by type + offset balance).
- **AI executive summary** — an on‑demand narrative of the sprint (when AI is enabled).
- **Trends & KPIs** — a second mode (toggle next to the board switcher) that reports across a *window*
  of sprints instead of one: committed/completed points, rate, carryover and blocked counts per sprint,
  team‑wide averages, and a per‑developer view (pick a name to see their trend). The window defaults to
  a **date range** pre‑filled to the span of the last 10 closed sprints — or choose the **last N** closed
  sprints instead, or **pick sprints** individually — then export the same way (Copy, .md, .csv).
  Per‑developer KPIs are leave‑adjusted: each plotted leave day (Vacation, Emergency, Holiday, or Offset)
  reduces that developer's sprint target by a point, so their **met target** mark reflects the adjusted
  number, not the flat team target.

### 🔌 Accounts & Connections

InvokeBoard is **login‑gated and per‑user**: sign up, then open the **Connections** tab and connect
**your own** Jira and GitHub tokens (plus an AI token if you want the AI features) — the app
unlocks the moment Jira and GitHub are connected.

Your tokens are **encrypted at rest and never shown back to you** (only a masked "…last4" hint).
Admins can also onboard viewers on **shared credentials** (read‑only against Jira unless granted
writes). See [Enabling accounts (login)](#enabling-accounts-login) to turn accounts on.

### 🤖 AI assistant (floating widget)

The lower‑right chat button is available on every tab. When AI is enabled you can **ask questions**
about the current sprint ("what's in code review?", "who owns VRDB‑1234?", "any impediments today?")
and even **propose changes** (update points, move a ticket, set a sprint goal, file leave) — each
change is shown for **confirmation before it's applied**. Nothing is changed without your OK.

### 🧰 Using the MCP tools

Every tab above is a thin UI over **52 MCP tools**, split across two servers: `mcp-jira` (47
tools — tickets, sprints, reports, leaves, the offset wallet, the Huddle stores, PO ↔ Dev links)
and `mcp-github` (5 tools — pull requests). There are two ways to reach them:

- **VS Code Copilot Chat** gets **all 52**. This repo's `.vscode/mcp.json` registers both servers,
  and VS Code loads them automatically the moment you open the workspace folder — see **Step 3**
  of [`docs/SETUP.md`](SETUP.md). Copilot talks to them over **stdio**; the dashboard instead
  talks to an HTTP bridge in front of the same tool registry (see `docs/ARCHITECTURE.md`, §7, for
  the split). Three tools have **no dashboard button at all** and are Copilot‑only: `get_pr`
  (full detail on one pull request), `get_pr_reviews` (batch approval status), and
  `sync_pr_links` (auto‑link every open PR in a repo to its Jira ticket).
- **The floating AI assistant** (bottom‑right, every tab) reaches a curated subset: **19 read
  tools** it can call on its own to answer a question, and **7 write tools** it can only
  *propose* — every proposed change waits in a confirmation dialog until you approve it (see "AI
  assistant", above). It never calls a GitHub tool; anything it tells you about PRs comes from
  Jira's own linked‑issue data, not a live GitHub call.

**Jira/GitHub tools vs. local tools.** Most tools act on your real Jira boards (or, for the PR
tools, GitHub) — those changes land immediately. A second group instead reads and writes
InvokeBoard's own local store: the team roster, typed leaves, the offset ledger, and the Huddle
sidebar's impediments, post‑scrum notes, meeting goal, meeting notes, and retro. Those are
InvokeBoard app state rather than Jira history, so they work the same for everyone regardless of
Jira write permissions.

**Shared‑credential users:** an account that's borrowing someone else's Jira connection has its
Jira‑mutating tools **blocked with a read‑only error** unless an admin has explicitly granted it
write access. Local‑store tools (leaves, retro, notes, impediments…) always work for these
accounts too, since nothing there is attributed to a Jira user.

A few prompts that work well in Copilot Chat:

> "What's in code review on the Dev board right now?"
> "Create a PO story for CSV export on Reports, with a linked Dev task."
> "Check the review status of PRs 41, 42, and 44 in our repo."
> "Auto-link every open PR to its Jira ticket."
> "What's our velocity over the last three sprints?"

### 📋 Tool reference

All 52 tools, grouped the same way the in‑app Guide groups them. **Type** marks which system a
tool acts on and whether it reads or writes; **AI** marks whether the floating assistant can call
it itself (`Ask`), only propose it for your confirmation (`Propose`), or not reach it at all
(`—` — dashboard-only or Copilot‑only).

#### Ticket CRUD (5)

| Tool | What it does | Type | AI | Used in the app |
|---|---|---|---|---|
| `create_po_ticket` | Create a PO story in Jira (plain text becomes a formatted description); optionally into a sprint. | Jira·Write | — | Planning · Ticket generator, Linking |
| `create_dev_ticket` | Create a Dev task, optionally linked to a PO story, assigned, and added to a sprint. | Jira·Write | — | Planning · Ticket generator, Linking |
| `get_ticket` | Fetch one ticket's summary, description, status, assignee, points and labels. | Jira·Read | Ask | Huddle chat · `ticket <KEY>` |
| `update_ticket` | Update a ticket's summary, description and/or story points. | Jira·Write | Propose | Planning · Assignment list (points) |
| `get_issue_descriptions` | Batch‑fetch plain‑text descriptions for up to 50 issue keys at once. | Jira·Read | — | Linking (AI plan drafting) |

#### Sprint reads (3)

| Tool | What it does | Type | AI | Used in the app |
|---|---|---|---|---|
| `get_active_sprint` | The active (or chosen) sprint's issues bucketed by status, with totals and points. | Jira·Read | Ask | Huddle, Reports |
| `get_daily_huddle` | A deterministic standup digest — in progress, code review, blocked, done, up next. | Jira·Read | Ask | Huddle |
| `list_sprints` | List a board's sprints grouped by active, future and closed. | Jira·Read | Ask | Planning, Reports (sprint pickers) |

#### Sprint management (5)

| Tool | What it does | Type | AI | Used in the app |
|---|---|---|---|---|
| `create_sprint` | Create a new future sprint with a name, goal and optional dates. | Jira·Write | Propose | Planning · New sprint |
| `set_sprint_goal` | Set or clear a sprint's goal. | Jira·Write | Propose | Huddle · Sprint goal editor |
| `get_transitions` | List the valid next‑status transitions for a ticket. | Jira·Read | — | Planning · Assignment list |
| `transition_issue` | Move a ticket to a new status using a transition id. | Jira·Write | Propose | Planning · Assignment list |
| `move_issue_to_sprint` | Move a ticket into a different sprint. | Jira·Write | Propose | Planning · Assignment list |

#### Reports & velocity (3)

| Tool | What it does | Type | AI | Used in the app |
|---|---|---|---|---|
| `get_sprint_report` | Committed vs completed points, completion rate and a by‑assignee breakdown. | Jira·Read | Ask | Reports |
| `get_velocity` | Average completed points over recent sprints, with a simple forecast. | Jira·Read | Ask | Reports |
| `get_multi_sprint_report` | One report across a window of sprints (default last 10 closed): per‑sprint points and counts plus team and per‑developer aggregates. | Jira·Read | Ask | Reports · Trends & KPIs |

#### Assignment & roster (7)

| Tool | What it does | Type | AI | Used in the app |
|---|---|---|---|---|
| `get_assignable_users` | List the developers eligible to be assigned tickets on a project or board. | Jira·Read | — | Planning · Assignment list |
| `assign_issue` | Assign (or unassign) a ticket to a developer. | Jira·Write | Propose | Planning · Assignment list |
| `get_recent_assignees` | Suggest roster members from everyone assigned a ticket recently on the board. | Jira·Read | — | Planning · Team roster |
| `get_team_members` | The curated team roster InvokeBoard plans around, per board. | Local·Read | Ask | Planning · Team roster |
| `set_team_members` | Replace the curated team roster for a board. | Local·Write | — | Planning · Team roster |
| `get_draft_plan` | The DRAFT split of a PO sprint's tickets across developers (never a Jira write). | Local·Read | Ask | Planning · Draft Capacity Plan |
| `set_draft_plan` | Replace a PO sprint's whole draft capacity plan (draft only — never writes to Jira). | Local·Write | — | Planning · Draft Capacity Plan |

#### Leaves & offset wallet (8)

| Tool | What it does | Type | AI | Used in the app |
|---|---|---|---|---|
| `get_leaves` | One sprint's typed leave days (VL, EL, Holiday, Offset) per person. | Local·Read | Ask | Planning · Leaves & capacity |
| `get_all_leaves` | The entire leaves store across every sprint, for the planner and wallet. | Local·Read | Ask | Offset Tracker |
| `set_leaves` | Replace one person's typed leave days for a sprint. | Local·Write | Propose | Planning, Offset Tracker |
| `get_offset_ledger` | Every developer's offset balance — earned, used, opening, adjustments. | Local·Read | Ask | Offset Tracker |
| `set_offset_for_sprint` | Bank a sprint's computed offset earnings (idempotent per sprint). | Local·Write | — | Offset Tracker · Bank earned offsets |
| `set_offset_adjustment` | Set a developer's one‑time opening offset balance. | Local·Write | — | Offset Tracker · Opening column |
| `add_offset_adjustment` | Log a manual ± offset adjustment (decimals allowed) with an optional note. | Local·Write | — | Offset Tracker · History dialog |
| `delete_offset_adjustment` | Remove one manual offset adjustment from a developer's log. | Local·Write | — | Offset Tracker · History dialog |

#### Huddle stores (12)

| Tool | What it does | Type | AI | Used in the app |
|---|---|---|---|---|
| `get_impediments` | This sprint's logged blockers and impediments. | Local·Read | Ask | Huddle · Impediments card |
| `set_impediments` | Replace this sprint's logged blockers. | Local·Write | — | Huddle · Impediments card |
| `get_pull_requests` | This sprint's manually‑tracked pending PR links. | Local·Read | Ask | Huddle · Code review card |
| `set_pull_requests` | Replace this sprint's manually‑tracked PR links. | Local·Write | — | Huddle · Code review card |
| `get_post_scrum` | This sprint's post‑standup follow‑up notes, per person. | Local·Read | Ask | Huddle · Post‑scrum card |
| `set_post_scrum` | Replace this sprint's post‑scrum follow‑up notes. | Local·Write | — | Huddle · Post‑scrum card |
| `get_meeting_goal` | Today's standup focus (distinct from the Jira sprint goal). | Local·Read | Ask | Huddle · Meeting goal card |
| `set_meeting_goal` | Set or clear today's standup focus. | Local·Write | — | Huddle · Meeting goal card |
| `get_meeting_notes` | The sprint's rich‑text meeting notes. | Local·Read | Ask | Huddle · Meeting notes card |
| `set_meeting_notes` | Replace the sprint's rich‑text meeting notes. | Local·Write | — | Huddle · Meeting notes card |
| `get_retro` | The sprint's saved retrospective (delays, what worked, kudos and more). | Local·Read | Ask | Reports · Retrospective |
| `set_retro` | Replace the sprint's retrospective fields. | Local·Write | — | Reports · Retrospective |

#### Linking & PR visibility (4)

| Tool | What it does | Type | AI | Used in the app |
|---|---|---|---|---|
| `link_dev_to_po` | Link an existing Dev ticket to an existing PO story (PO depends on Dev). | Jira·Write | — | Linking · Link existing |
| `unlink_dev_from_po` | Remove a PO ↔ Dev issue link by its link id. | Jira·Write | — | Linking · Link existing |
| `get_linked_issues` | Issues linked to a set of keys, filtered to a project (PO ↔ Dev links). | Jira·Read | Ask | Linking, fly‑in tracker |
| `get_issue_pull_requests` | Every linked PR (any repo) for a set of issues, with approval status. | Jira·Read | Ask | Huddle has‑PR badges, Reports |

#### GitHub pull requests (5)

| Tool | What it does | Type | AI | Used in the app |
|---|---|---|---|---|
| `list_prs` | List pull requests in a GitHub repo, with detected Jira keys. | GitHub·Read | — | Huddle chat · `prs` |
| `get_pr` | Full details for one pull request by number. | GitHub·Read | — | VS Code Copilot only |
| `get_pr_reviews` | Approval / changes‑requested status for a batch of PR numbers. | GitHub·Read | — | VS Code Copilot only |
| `link_pr_to_ticket` | Link a PR to Jira ticket(s) — a remote link plus a PR comment (idempotent). | GitHub·Write | — | Huddle chat · `link pr <n> [KEY]` |
| `sync_pr_links` | Auto‑link every open PR in a repo to its detected Jira ticket(s). | GitHub·Write | — | VS Code Copilot only |

**47** tools live on `mcp-jira`, **5** on `mcp-github` — **52** in total. The floating assistant
can read 20 of them and propose 7 more with your confirmation; the rest are driven directly by
the dashboard's UI (or, for three GitHub tools, reachable only via Copilot).

---

## Setting up InvokeBoard

### Prerequisites

- **Node.js 20+** (Node 22 recommended) and npm.
- A **Jira Cloud** account with permission to view your boards, plus an **API token**
  (create one at <https://id.atlassian.com/manage-profile/security/api-tokens>).
- The IDs of your **PO board** and **Dev board** (the number in a board URL:
  `…/RapidBoard.jspa?rapidView=<ID>`).
- *(Optional)* An **AI provider** — an Anthropic API key, or a GitHub token with the **Models: read**
  permission — to enable the AI features. Without it, InvokeBoard falls back to deterministic templates.
- *(Optional)* A **GitHub** token if you want linked‑PR and repo features.

### 1. Configure your environment

Copy the template and fill it in (root `.env`, or `packages/mcp-jira/.env`):

```bash
cp packages/mcp-jira/.env.example packages/mcp-jira/.env
```

**Required — connect to Jira:**

```ini
JIRA_BASE_URL=https://yourcompany.atlassian.net
JIRA_EMAIL=you@company.com
JIRA_API_TOKEN=your-api-token
JIRA_PO_BOARD_ID=10001         # your PO board id
JIRA_DEV_BOARD_ID=10002        # your Dev board id
```

**Optional — tuning** (sensible defaults shown):

```ini
JIRA_STORY_POINTS_FIELD=customfield_10016
JIRA_LINK_TYPE=Depends on            # must match a link type in your Jira
JIRA_CODE_REVIEW_STATUSES=code review,in review,peer review,review
JIRA_VELOCITY_SPRINTS=6
```

**Optional — enable AI** (`anthropic` **or** `github`; leave `AI_PROVIDER` empty to disable):

```ini
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
# — or —
AI_PROVIDER=github
GITHUB_MODELS_TOKEN=github-token-with-models-read
```

> **AI not working?** If you see *"GitHub Models authentication failed … PAT needs models:read"*, your
> GitHub token is missing the **Models: read** permission — use a fine‑grained PAT that has it, or
> switch to `AI_PROVIDER=anthropic` with an `ANTHROPIC_API_KEY`.

### 2. Run it

Install once, then start the three processes (two MCP bridges + the web app):

```bash
npm install
npm run dev:all          # starts the Jira bridge (:4001), GitHub bridge (:4002) and web app (:5173)
```

Open **<http://localhost:5173>**. (You can also start each process separately —
`npm run dev:jira:http`, `npm run dev:github:http`, `npm run dev:app` — or deploy with Docker; see
[`docs/DEPLOYMENT.md`](DEPLOYMENT.md).)

### 3. Verify

```bash
npm run typecheck && npm run test && npm run build   # all green, no network needed
node scripts/smoke.mjs                               # boots both bridges with stub creds
```

### Enabling accounts (login)

Per‑user accounts (the login gate + the Connections tab) are **off by default**. To turn them on,
add two secrets to the bridge's `.env` and restart it:

```bash
# generate the values:
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # → TOKEN_ENC_KEY
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"   # → SESSION_SECRET
```

```ini
TOKEN_ENC_KEY=<32-byte base64 value>
SESSION_SECRET=<random base64 value>
```

Then each teammate **signs up** on the login screen and **connects their own** Jira and GitHub
tokens on the **Connections** tab. Tokens are AES‑256‑GCM encrypted at rest and are never returned
to the browser.

---

## Tips & FAQ

- **PO vs. Dev board:** use the board switcher (top‑right) to flip context. Linking works across both.
- **Collapsing clutter:** every Huddle sidebar card collapses via the chevron in its header — handy on
  long sprints. Your choices persist per browser.
- **"Bridge is offline":** a page can't reach the Jira/GitHub bridge — make sure `npm run dev:all` (or
  the individual `dev:*:http` processes) is running.
- **Sprint reports look empty:** confirm the board id is correct and the sprint has issues assigned to
  your rostered team members.
- **Security:** API tokens live only in the server's `.env` (team config) or the encrypted per‑user
  vault (Connections). They are never logged or sent to the browser.

---

*InvokeBoard is a proof‑of‑concept that integrates Jira/GitHub into an Agile workflow via the Model
Context Protocol (MCP). For architecture and design decisions, see [`docs/ARCHITECTURE.md`](ARCHITECTURE.md)
and the ADRs under [`docs/adr/`](adr/).*
