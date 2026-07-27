// Verbatim copies of response types from CONTRACTS.md §4/§5 (ADR-005 sanctions this duplication)

// ── Board context types (CONTRACTS.md §2, ADR-017, v1.6) ─────────────────────

/** A single board reference (ADR-017; per-user via /api/me/context .boards since v1.51). */
export interface BoardRef {
  id: number;
  projectKey: string;
}

/**
 * Boards config — dev + po (ADR-017). v1.51 (ADR-062): sourced from the signed-in user's
 * context (/api/me/context .boards), which reflects per-user/admin overrides — NOT the global
 * GET /api/health.
 * v1.25 (ADR-037): each side is a LIST of projects (multi-project); element 0 = default.
 */
export interface Boards {
  dev: BoardRef[];
  po: BoardRef[];
}

/** Which board is currently selected in the UI */
export type BoardKey = "dev" | "po";

/**
 * Shared board+sprint context props (v1.13, ADR-024). When App passes these, the
 * page is CONTROLLED (board + the "explicit pick" sprint live in App); when absent,
 * the page is uncontrolled and keeps its own state (standalone / tests). The shared
 * sprintId is an explicit pick (null = none → page applies its per-ceremony default).
 */
export interface SharedSprintProps {
  boardKey?: BoardKey;
  sprintId?: number | null;
  onBoardChange?: (key: BoardKey) => void;
  onSprintChange?: (id: number) => void;
  /**
   * v1.25 (ADR-037): the active project index for the currently-selected board side.
   * Board-scoped pages resolve `boards[boardKey][projectIdx]`. Undefined → 0 (default project).
   */
  projectIdx?: number;
}

// ── mcp-jira shared types (CONTRACTS.md §4) ──────────────────────────────────

/** ActiveSprintRef — one entry in the activeSprints list (CONTRACTS.md §4.3 v1.1) */
export interface ActiveSprintRef {
  id: number;
  name: string;
  startDate: string | null;
  endDate: string | null;
  goal: string | null;
}

/**
 * SprintRef — full sprint descriptor used by create_sprint / list_sprints /
 * get_sprint_report / get_velocity (CONTRACTS.md §4.10–§4.13 v1.4)
 */
export interface SprintRef {
  id: number;
  name: string;
  state: "active" | "future" | "closed";
  startDate: string | null;
  endDate: string | null;
  completeDate: string | null; // closed sprints only, else null
  goal: string | null;
  boardId: number;
}

/** create_sprint request body (CONTRACTS.md §4.10 v1.4) */
export interface CreateSprintRequest {
  name: string;
  goal?: string;
  startDate?: string;
  endDate?: string;
  boardId?: number;
}

/** list_sprints response (CONTRACTS.md §4.11 v1.4) */
export interface ListSprintsResponse {
  boardId: number;
  active: SprintRef[];
  future: SprintRef[];
  closed: SprintRef[];
}

export interface TicketRef {
  key: string;
  url: string;
  board: "PO" | "DEV";
}

export interface IssueSummary {
  key: string;
  summary: string;
  status: string; // e.g. "In Progress"
  statusCategory: "todo" | "inprogress" | "done";
  assignee: string | null; // display name
  /** v1.8 — Jira accountId (for assignment pre-select + roster derivation) */
  assigneeAccountId: string | null;
  storyPoints: number | null;
  issueType: string; // "Story", "Task", "Bug", ...
  url: string; // browse URL
  blocked: boolean;
  /** v1.42 (ADR-052) — Jira resolutiondate (ISO) or null; burndown input. */
  resolvedAt?: string | null;
  /** v1.42 (ADR-052) — Jira updated (ISO) or null; staleness detection. */
  updatedAt?: string | null;
  /**
   * v1.58 (ADR-070) — when the issue entered its CURRENT status (ISO), from the Jira changelog.
   * Present only for in-progress/code-review issues when the sprint was fetched with
   * `withAging: true`. null/undefined = unknown → the UI shows no age (never a guess).
   */
  inProgressSince?: string | null;
}

export interface HuddleItem {
  key: string;
  summary: string;
  assignee: string | null;
  status: string;
}

// ── mcp-jira tool outputs (CONTRACTS.md §4.1–§4.6) ───────────────────────────

/** create_po_ticket output (CONTRACTS.md §4.1 v1.4) */
export type CreatePoTicketOutput = TicketRef & {
  sprintId?: number;
  sprintWarning?: string;
  // board: "PO"
};

/** create_dev_ticket output (CONTRACTS.md §4.2 v1.4) */
export type CreateDevTicketOutput = TicketRef & {
  linkedTo?: string;
  linkWarning?: string;
  sprintId?: number;
  sprintWarning?: string;
  // v1.36 (ADR-046): the Dev task may be created already assigned; assignment is
  // non-fatal, so a failure returns assignWarning (the ticket is still created).
  assigneeAccountId?: string;
  assignWarning?: string;
  // board: "DEV"
};

/** get_active_sprint output */
export interface GetActiveSprintOutput {
  sprint: {
    id: number;
    name: string;
    state: "active" | "future"; // v1.4: may be future when no active sprint exists
    startDate: string | null;
    endDate: string | null;
    goal: string | null;
  };
  /** ALL active sprints on the board, latest-first (v1.1, CONTRACTS.md §4.3) */
  activeSprints: ActiveSprintRef[];
  /** ALL future sprints, earliest-first — next-up first (v1.4, CONTRACTS.md §4.3) */
  futureSprints: ActiveSprintRef[];
  issuesByStatus: {
    todo: IssueSummary[];
    inprogress: IssueSummary[];
    codereview: IssueSummary[]; // v1.2 (CONTRACTS.md §4.3)
    done: IssueSummary[];
  };
  totals: {
    total: number;
    todo: number;
    inprogress: number;
    codereview: number; // v1.2 (CONTRACTS.md §4.3)
    done: number;
    blocked: number;
    storyPointsTotal: number;
    storyPointsDone: number;
    storyPointsCodeReview: number; // v1.5 — sum of code-review bucket points (CONTRACTS.md §4.3)
  };
}

/** get_ticket output */
export interface GetTicketOutput {
  key: string;
  url: string;
  summary: string;
  description: string; // plain text extracted from ADF
  status: string;
  statusCategory: "todo" | "inprogress" | "done";
  assignee: string | null;
  reporter: string | null;
  storyPoints: number | null;
  issueType: string;
  labels: string[];
  created: string; // ISO 8601
  updated: string; // ISO 8601
}

/** update_ticket output */
export interface UpdateTicketOutput {
  key: string;
  url: string;
  updatedFields: string[];
}

/** get_daily_huddle output */
export interface GetDailyHuddleOutput {
  sprintName: string;
  sprintId: number; // added in v1.1 (CONTRACTS.md §4.6)
  boardId: number;
  generatedAt: string; // ISO timestamp
  inProgress: HuddleItem[];
  codeReview: HuddleItem[]; // v1.2 (CONTRACTS.md §4.6) — camelCase per contract
  blocked: HuddleItem[];
  done: HuddleItem[];
  upNext: HuddleItem[];
  summaryText: string;
}

// ── AI drafting types (CONTRACTS.md §4.9 v1.1) ───────────────────────────────

/**
 * AI status. v1.53 (ADR-064): the UI reads this PER-USER from /api/me/context .ai (via AuthContext) so a
 * user on their own AI token — with no global .env AI — is correctly shown as enabled. The global
 * GET /api/health .ai still exists for keyless smoke/health, but is no longer the UI's source.
 */
export interface AiStatus {
  enabled: boolean;
  provider: string | null;
  model: string | null;
}

/** Single message in an AI conversation */
export interface AiMessage {
  role: "user" | "assistant";
  content: string;
}

/** POST /api/ai/draft-tickets request body */
export interface DraftRequest {
  messages: AiMessage[];
  storyPoints?: number;
}

/** POST /api/ai/draft-tickets response */
export interface DraftResponse {
  assistantMessage: string;
  po: { summary: string; description: string; storyPoints: number | null };
  dev: { summary: string; description: string };
  provider: "anthropic" | "github";
  model: string;
}

/** POST /api/ai/enhance-ticket request body */
export interface EnhanceRequest {
  ticketKey: string;
  notes?: string;
  current: { summary: string; description: string };
}

/** POST /api/ai/enhance-ticket response */
export interface EnhanceResponse {
  assistantMessage: string;
  summary: string;
  description: string;
  provider: "anthropic" | "github";
  model: string;
}

// ── Phase 3 report types (CONTRACTS.md §4.12 / §4.13 / §4.9 v1.4) ──────────

/**
 * get_sprint_report output — CONTRACTS.md §4.12 v1.4
 * Committed/completed points, completion rate, completed vs carryover issue
 * lists, blocker count, and per-assignee breakdown.
 */
export interface SprintReport {
  sprint: SprintRef;
  committedPoints: number;
  completedPoints: number;
  completionRate: number; // completedPoints / committedPoints, 0 when committed=0
  totalCount: number;
  completedCount: number;
  carryoverCount: number;
  blockedCount: number;
  completed: IssueSummary[];
  notCompleted: IssueSummary[];
  byAssignee: Array<{
    name: string; // "Unassigned" for null
    donePoints: number;
    totalPoints: number;
    doneCount: number;
    totalCount: number;
  }>;
}

/**
 * get_velocity output — CONTRACTS.md §4.13 v1.4
 * Last N closed sprints (chronological) + average + heuristic forecast.
 */
export interface VelocityData {
  boardId: number;
  sprintCount: number;
  sprints: Array<{
    id: number;
    name: string;
    committedPoints: number;
    completedPoints: number;
    completeDate: string | null;
  }>;
  averageCompleted: number;
  forecastNext: number; // = averageCompleted (heuristic, not a commitment)
}

/**
 * Per-assignee stats within ONE sprint — name, done/total points and counts. Mirrors
 * SprintReport.byAssignee's element shape (kept inline there to avoid touching existing
 * contract-adjacent types) plus get_multi_sprint_report's per-sprint byAssignee.
 * CONTRACTS.md §4.12 / §4.29, v1.59, ADR-071.
 */
export interface AssigneeStats {
  name: string; // "Unassigned" for null
  donePoints: number;
  totalPoints: number;
  doneCount: number;
  totalCount: number;
}

/**
 * One sprint's entry within a get_multi_sprint_report window, chronological (oldest → newest).
 * CONTRACTS.md §4.29 v1.59, ADR-071.
 */
export interface MultiSprintEntry {
  sprint: SprintRef;
  committedPoints: number;
  completedPoints: number;
  completionRate: number; // completedPoints / committedPoints, 0 when committed=0
  totalCount: number;
  completedCount: number;
  carryoverCount: number; // totalCount − completedCount
  blockedCount: number;
  byAssignee: AssigneeStats[];
}

/**
 * Cross-sprint per-assignee aggregate — CONTRACTS.md §4.29 v1.59, ADR-071.
 * avgDonePoints is donePoints / sprintCount over the FULL window (velocity convention — a
 * quiet sprint still drags the average down), NOT donePoints / sprintsActive.
 */
export interface MultiSprintAssigneeSummary {
  name: string;
  sprintsActive: number; // sprints where the person had >=1 issue
  donePoints: number;
  totalPoints: number;
  avgDonePoints: number;
}

/**
 * get_multi_sprint_report output — CONTRACTS.md §4.29 v1.59, ADR-071.
 * One aggregated report across a WINDOW of sprints — the data source for the Reports page's
 * "Trends & KPIs" mode (team + per-developer velocity & trend). Empty window → the all-zero /
 * empty-array shape, NOT an error (get_velocity convention).
 */
export interface MultiSprintReport {
  boardId: number;
  sprintCount: number; // sprints actually included
  sprints: MultiSprintEntry[];
  totals: { committedPoints: number; completedPoints: number };
  averageCompleted: number; // totals.completedPoints / sprintCount (0 when empty)
  averageCompletionRate: number; // mean of per-sprint completionRate (0 when empty)
  byAssignee: MultiSprintAssigneeSummary[]; // aggregated across the window, donePoints desc
}

/**
 * POST /api/ai/sprint-summary request body — CONTRACTS.md §4.9 v1.4
 */
export interface SprintSummaryRequest {
  sprintName: string;
  state: string;
  startDate?: string;
  endDate?: string;
  goal?: string | null;
  committedPoints: number;
  completedPoints: number;
  completedCount: number;
  totalCount: number;
  carryoverCount: number;
  blockedCount: number;
  byAssignee: Array<{
    name: string;
    donePoints: number;
    totalPoints: number;
    doneCount: number;
    totalCount: number;
  }>;
}

/**
 * POST /api/ai/sprint-summary response — CONTRACTS.md §4.9 v1.4
 */
export interface SprintSummaryResponse {
  summary: string;
  provider: "anthropic" | "github";
  model: string;
}

// ── Linking types (CONTRACTS.md §4.17 + §4.9 plan-dev-tickets, v1.11, ADR-022) ─

/** A single issue linked to another (from get_linked_issues). */
export interface LinkedIssue {
  key: string;
  summary: string;
  status: string;
  url: string;
  /**
   * v1.72 (ADR-083): the Jira issue-link id, its type name, and this row's direction
   * relative to the queried key. OPTIONAL ON PURPOSE — the server always sends them,
   * but making them required would force edits to test fixture literals in 3+ existing
   * test files for zero gain (this endpoint predates §4.31/§4.32, which are what
   * actually consume these fields to build the unlink control and dedupe check).
   */
  linkId?: string;
  linkTypeName?: string;
  direction?: "inward" | "outward";
}

/** get_linked_issues output — keyed by the input (PO) key. */
export interface GetLinkedIssuesResponse {
  links: Record<string, LinkedIssue[]>;
}

/** get_issue_descriptions output (v1.14) — plain-text description keyed by the input key. */
export interface GetIssueDescriptionsResponse {
  descriptions: Record<string, string>;
}

/** POST /api/ai/plan-dev-tickets input. */
export interface PlanDevTicketsRequest {
  poStories: Array<{ key: string; summary: string; description?: string }>;
  instructions?: string;
}

/** One planned Dev draft for a PO story. */
export interface PlanDevTicketItem {
  poKey: string;
  devSummary: string;
  devDescription: string;
  // v1.30 (ADR-042): drafted from the PO's points, editable on the Linking plan card before
  // create. Frontend-populated — the plan-dev-tickets endpoint does not return it.
  storyPoints?: number | null;
}

/**
 * One editable Dev-task row in the Linking plan (v1.36, ADR-046).
 * Extends the AI draft shape with a stable row id, a per-task estimate, and an
 * optional assignee — a single PO story may expand into up to two of these rows.
 */
export interface PlanRow extends PlanDevTicketItem {
  id: string;
  assigneeAccountId?: string;
}

/** POST /api/ai/plan-dev-tickets output. */
export interface PlanDevTicketsResponse {
  assistantMessage: string;
  items: PlanDevTicketItem[];
  provider: "anthropic" | "github";
  model: string;
}

// ── Linking write types (CONTRACTS.md §4.31/§4.32/§4.9 draft-po-story, v1.72, ADR-083) ─

/**
 * link_dev_to_po output (CONTRACTS.md §4.31). `linkId` is non-null ONLY on the
 * `alreadyLinked` path — Jira's create response has no body to read one back from.
 * `reversed` is set when a pre-v1.42 link already exists with the keys swapped.
 */
export interface LinkDevToPoResult {
  poKey: string;
  devKey: string;
  linkTypeName: string;
  created: boolean;
  alreadyLinked: boolean;
  linkId: string | null;
  reversed?: boolean;
  precheckWarning?: string;
}

/**
 * unlink_dev_from_po output (CONTRACTS.md §4.32). A missing/already-gone link is
 * reported via `alreadyGone: true`, not an error — matches get_linked_issues'
 * "missing key → []" resilience convention.
 */
export interface UnlinkDevFromPoResult {
  linkId: string;
  deleted: boolean;
  alreadyGone: boolean;
  poKey?: string;
  devKey?: string;
}

/** POST /api/ai/draft-po-story request body (CONTRACTS.md §4.9 v1.72, ADR-083). */
export interface DraftPoStoryRequest {
  devTickets: Array<{
    key: string;
    summary: string;
    description?: string;
    storyPoints?: number | null;
  }>;
  instructions?: string;
}

/**
 * POST /api/ai/draft-po-story response (CONTRACTS.md §4.9 v1.72, ADR-083). No
 * `storyPoints` — deliberate; the client sums the selected Dev tickets' points itself.
 */
export interface DraftPoStoryResponse {
  assistantMessage: string;
  summary: string;
  description: string;
  provider: "anthropic" | "github";
  model: string;
}

/** POST /api/ai/ask input (v1.18, ADR-029) — free-form Q&A over read tools. */
export interface AskRequest {
  question: string;
  boardId?: number;
  sprintId?: number;
  /** v1.40 (ADR-050): prior Ask-mode turns (oldest first, ≤8) — gives the assistant memory. */
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}

/** A write the assistant proposes (v1.19, ADR-030) — confirmed in a modal, not auto-run. */
export interface ProposedAction {
  tool: string;
  args: Record<string, unknown>;
}

/**
 * A rich card the assistant captured from a read tool it ran (v1.71, ADR-082) — rendered with the
 * same result-card components the deterministic commands use. `data` is that tool's output.
 */
export interface AskCard {
  kind: "ticket" | "sprint" | "huddle";
  data: GetTicketOutput | GetActiveSprintOutput | GetDailyHuddleOutput;
}

/** POST /api/ai/ask output. */
export interface AskResponse {
  answer: string;
  toolsUsed: string[];
  provider: "anthropic" | "github";
  model: string;
  proposedAction?: ProposedAction;
  /** v1.71 (ADR-082): rich cards captured from the read tools the loop ran (≤3). */
  cards?: AskCard[];
}

/**
 * One decoded SSE frame from POST /api/ai/ask/stream (v1.71, ADR-082). The client keys off the SSE
 * event name; `error` is only used when the failure happens after the stream has started.
 */
export type AskStreamEvent =
  | { type: "step"; tools: string[] }
  | { type: "delta"; text: string }
  | { type: "cards"; cards: AskCard[] }
  | {
      type: "proposed";
      answer: string;
      proposedAction: ProposedAction;
      toolsUsed: string[];
      provider: "anthropic" | "github";
      model: string;
    }
  | {
      type: "done";
      answer: string;
      toolsUsed: string[];
      provider: "anthropic" | "github";
      model: string;
      cards?: AskCard[];
    }
  | { type: "error"; code: string; message: string };

// ── Huddle stores (CONTRACTS.md §4.21/§4.22 v1.16, ADR-027) ──────────────────

/** A sprint impediment/blocker (manual store). */
export interface Impediment {
  id: string;
  text: string;
  ticketKey?: string;
  createdAt: string;
  resolved?: boolean;
}

/** A pending pull-request link (manual store). */
export interface PullRequest {
  id: string;
  url: string;
  title?: string;
  ticketKey?: string;
  status?: string;
  addedAt: string;
}

/** A post-scrum note — per-person standup follow-up (manual store, v1.20, ADR-031). */
export interface PostScrumNote {
  id: string;
  person: string;
  note: string;
  createdAt: string;
  resolved?: boolean;
}

/** The per-sprint meeting goal (standup focus, v1.20, ADR-031). */
export interface MeetingGoal {
  sprintId: number;
  goal: string;
  updatedAt: string | null;
}

// ── Assignment types (CONTRACTS.md §4.15 v1.7, ADR-018) ─────────────────────

/**
 * A user who can be assigned to Jira issues.
 * From get_assignable_users — active users only, sorted by displayName.
 */
export interface AssignableUser {
  accountId: string;
  displayName: string;
  active: boolean;
}

// ── Team roster types (CONTRACTS.md §4.16 v1.8, ADR-019) ────────────────────

/**
 * A member of the curated per-board team roster.
 * From get_team_members / set_team_members.
 */
export interface TeamMember {
  accountId: string;
  displayName: string;
}

/**
 * A distinct assignee from recent sprints — used to seed the team roster.
 * From get_recent_assignees (sorted by ticketCount desc).
 */
export interface RecentAssignee extends TeamMember {
  ticketCount: number;
}

// ── mcp-github types (CONTRACTS.md §5) ───────────────────────────────────────

export interface PrSummary {
  number: number;
  title: string;
  author: string;
  branch: string;
  baseBranch: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  url: string; // html_url
  jiraKeys: string[];
}

/** list_prs output */
export interface ListPrsOutput {
  repo: string;
  prs: PrSummary[];
}

/** Overall review/approval decision for a PR (v1.21, §5.6). */
export type ReviewDecision = "approved" | "changes_requested" | "review_required";

/** Aggregated reviewer/approval status for a PR (v1.21, §5.6, ADR-033). */
export interface PrReviewStatus {
  decision: ReviewDecision;
  approvals: number;
  changesRequested: number;
  reviewers: string[];
}

/** get_pr_reviews output — review status keyed by PR number. */
export interface GetPrReviewsOutput {
  repo: string;
  reviews: Record<number, PrReviewStatus>;
}

/** A PR linked to a Jira issue via its Development panel (multi-repo; v1.22, ADR-034). */
export interface LinkedPr {
  url: string;
  title: string;
  repo: string;
  status: "open" | "merged" | "declined" | "unknown";
  decision: ReviewDecision;
  approvals: number;
  reviewers: string[];
  lastUpdate?: string;
}

/** get_issue_pull_requests output — linked PRs keyed by issue key. */
export interface GetIssuePullRequestsOutput {
  pullRequests: Record<string, LinkedPr[]>;
}

// ── Leaves & offset (v1.26, ADR-038) ─────────────────────────────────────────

/** A leave type plotted per day. */
export type LeaveType = "VL" | "EL" | "Holiday" | "Offset";

/** Per-assignee map of ISO date (YYYY-MM-DD) → leave type. */
export type AssigneeLeaves = Record<string, LeaveType>;

/** v1.54 (ADR-065): one ad-hoc manual balance adjustment — the Offset History log. */
export interface OffsetAdjustment {
  id: string;
  amount: number; // signed, non-zero; decimals allowed (v1.55, ADR-066 — e.g. 0.5)
  note?: string;
  createdAt: string; // ISO
}

/** One developer's computed offset standing (get_offset_ledger). */
export interface OffsetSummary {
  earned: number;
  spent: number;
  manualAdjust: number; // the single manual/opening balance (surfaced as "Opening balance" in the UI)
  balance: number;
  /** v1.50 (ADR-061): per-sprint banked earned/spent — lets the UI show if a sprint is banked. */
  bySprint?: Record<string, { earned: number; spent: number }>;
  /** v1.54 (ADR-065): the manual-adjustment log (newest-first), managed from the Offset History dialog. */
  adjustments?: OffsetAdjustment[];
}

/** Offset policy (per-user via /api/me/context .policy since v1.51; global default otherwise). */
export interface OffsetPolicy {
  requiredPoints: number; // N
  offsetThreshold: number; // N2
}

/**
 * Ticket-aging expectation policy (v1.58, ADR-070; per-user via /api/me/context .aging).
 * expected days in a status = baseDays + daysPerPoint × storyPoints (unpointed → baseDays).
 */
export interface AgingPolicy {
  baseDays: number;
  daysPerPoint: number;
}

/** get_pr output */
export type GetPrOutput = PrSummary & {
  body: string | null;
  mergeable: boolean | null;
  headSha: string;
};

/** link_pr_to_ticket output */
export interface LinkPrOutput {
  prUrl: string;
  results: Array<{
    ticketKey: string;
    remoteLinkCreated: boolean;
    commentPosted: boolean;
    error?: string;
  }>;
}

/** sync_pr_links output */
export interface SyncPrLinksOutput {
  repo: string;
  linked: Array<{ number: number; ticketKeys: string[] }>;
  skipped: Array<{ number: number; reason: string }>;
}

// ── Draft capacity plan (CONTRACTS.md §4.30 v1.70, ADR-081) ─────────────────

/**
 * One developer's DRAFT point slice of a PO-sprint ticket. displayName is
 * snapshotted alongside accountId so a member later removed from the Dev roster
 * still renders meaningfully (leaves/capacity are display-name-keyed, ADR-016).
 * `points` is a draft figure only — defaults to the ticket's real Jira points
 * when drafted whole to one person, splits when a second share is added;
 * over/under vs the real points is allowed and never enforced (capacity is
 * advisory, ADR-079). DRAFT ONLY — never written to Jira; real assignment
 * remains assign_issue (§4.15) from the Dev board's Planning/Linking flow.
 *
 * v1.70 (ADR-081): replaces the single-member `DraftAssignment` — a ticket now
 * maps to an ARRAY of shares (`DraftPlan.assignments[issueKey]: DraftShare[]`),
 * so one PO story can be split across several developers.
 */
export interface DraftShare {
  accountId: string;
  displayName: string;
  points: number;
}

/**
 * get_draft_plan / set_draft_plan output — a PO sprint's draft ticket→developer-
 * shares mapping, paired with the Dev sprint used as the capacity source. No
 * draft saved yet → { sprintId, devSprintId: null, assignments: {} }. An empty
 * share array for a key is invalid server-side — omit the key to leave a ticket
 * undrafted.
 */
export interface DraftPlan {
  sprintId: number;
  devSprintId: number | null;
  assignments: Record<string, DraftShare[]>;
}
