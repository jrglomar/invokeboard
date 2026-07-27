#!/usr/bin/env node
/**
 * Smoke test — validates both HTTP bridges with stub env vars.
 * No real credentials. No calls that reach upstream APIs.
 *
 * Checks performed:
 *  [JIRA] health shape
 *  [JIRA] /api/tools returns exactly 6 tools with contract names
 *  [JIRA] POST /api/tools/nope → 404 UNKNOWN_TOOL
 *  [JIRA] POST /api/tools/create_po_ticket {} → 400 VALIDATION with issues
 *  [JIRA] POST /api/tools/update_ticket {ticketKey:"DEV-1"} → 400 VALIDATION (refine)
 *  [JIRA] health.ai reports disabled when AI_PROVIDER is empty (v1.1)
 *  [JIRA] POST /api/ai/draft-tickets → 503 AI_UNAVAILABLE when AI disabled (v1.1)
 *  [JIRA] POST set_draft_plan with one developer share → 200, echoes sprintId/devSprintId/assignments (v1.68; DraftShare[] v1.70)
 *  [JIRA] POST get_draft_plan for an unused sprintId → 200 with devSprintId:null, assignments:{} (v1.68)
 *  [JIRA] POST set_draft_plan with an invalid (lowercase) assignments key → 400 VALIDATION (v1.68)
 *  [GITHUB] health shape
 *  [GITHUB] /api/tools returns exactly 4 tools with contract names
 *  [GITHUB] POST /api/tools/nope → 404 UNKNOWN_TOOL
 *  [GITHUB] POST /api/tools/link_pr_to_ticket {} → 400 VALIDATION
 *  [STDIO-JIRA] startup log to stderr, nothing to stdout
 *  [STDIO-GITHUB] startup log to stderr, nothing to stdout
 */

import { spawn } from "child_process";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const isWin = process.platform === "win32";

// ── Ports (avoid clashes with real servers on 4001/4002) ─────────────────────

const JIRA_PORT = 4101;
const GITHUB_PORT = 4102;

// ── Stub env vars (no real credentials; stub.invalid never gets hit) ─────────

const JIRA_ENV = {
  ...process.env,
  JIRA_BASE_URL: "https://stub.invalid",
  JIRA_EMAIL: "stub@stub.dev",
  JIRA_API_TOKEN: "stub",
  JIRA_PO_BOARD_ID: "1",
  JIRA_DEV_BOARD_ID: "2",
  MCP_JIRA_HTTP_PORT: String(JIRA_PORT),
  // Point the leaves + team stores at throwaway temp files so smoke never touches the real ones.
  JIRA_LEAVES_FILE: path.join(os.tmpdir(), `invokeboard-smoke-leaves-${process.pid}.json`),
  JIRA_TEAM_FILE: path.join(os.tmpdir(), `invokeboard-smoke-team-${process.pid}.json`),
  JIRA_OFFSET_FILE: path.join(os.tmpdir(), `invokeboard-smoke-offset-${process.pid}.json`),
  JIRA_DRAFT_PLAN_FILE: path.join(os.tmpdir(), `invokeboard-smoke-draft-plan-${process.pid}.json`),
  // Pin AI off so the AI_UNAVAILABLE checks are deterministic even when the
  // developer's .env configures a provider (set vars are never overridden by dotenv)
  AI_PROVIDER: "",
  // Unset VITEST so the startup/listen block in mcp-jira/http.ts runs
  VITEST: "",
};
delete JIRA_ENV["VITEST"];

const GITHUB_ENV = {
  ...process.env,
  GITHUB_TOKEN: "stub",
  GITHUB_REPO: "stub/stub",
  JIRA_BASE_URL: "https://stub.invalid",
  JIRA_EMAIL: "stub@stub.dev",
  JIRA_API_TOKEN: "stub",
  MCP_GITHUB_HTTP_PORT: String(GITHUB_PORT),
};

// ── Expected contract tool names ─────────────────────────────────────────────

const EXPECTED_JIRA_TOOLS = [
  "create_po_ticket",
  "create_dev_ticket",
  "get_active_sprint",
  "get_ticket",
  "update_ticket",
  "get_daily_huddle",
  // v1.4 — sprint management + reports
  "create_sprint",
  "list_sprints",
  "get_sprint_report",
  "get_velocity",
  // v1.59 (ADR-071) — windowed multi-sprint report for trends/KPIs
  "get_multi_sprint_report",
  // v1.5 — leaves/offset tracker
  "get_leaves",
  "get_all_leaves",
  "set_leaves",
  // v1.7 — sprint-planning assignment
  "get_assignable_users",
  "assign_issue",
  // v1.8 — curated team roster
  "get_recent_assignees",
  "get_team_members",
  "set_team_members",
  // v1.11 — existing PO→Dev links (Linking page)
  "get_linked_issues",
  // v1.14 — PO descriptions for Dev drafting (Linking page)
  "get_issue_descriptions",
  // v1.13 — sprint goal write (Scrum-Master review)
  "set_sprint_goal",
  // v1.15 — Planning ticket actions (status transition + move sprint)
  "get_transitions",
  "transition_issue",
  "move_issue_to_sprint",
  // v1.16 — Huddle stores (impediments + pending PRs)
  "get_impediments",
  "set_impediments",
  "get_pull_requests",
  "set_pull_requests",
  // v1.20 — Huddle daily sections (post-scrum + meeting goal)
  "get_post_scrum",
  "set_post_scrum",
  "get_meeting_goal",
  "set_meeting_goal",
  // v1.41 — Huddle rich meeting notes (WYSIWYG, ADR-051)
  "get_meeting_notes",
  "set_meeting_notes",
  // v1.42 — persisted retrospective (ADR-052)
  "get_retro",
  "set_retro",
  // v1.22 — multi-repo linked PRs from Jira Development Information
  "get_issue_pull_requests",
  // v1.26 — offset-points ledger
  "get_offset_ledger",
  "set_offset_for_sprint",
  "set_offset_adjustment",
  // v1.54 (ADR-065) — manual-adjustment log
  "add_offset_adjustment",
  "delete_offset_adjustment",
  // v1.68 — PO draft capacity plan
  "get_draft_plan",
  "set_draft_plan",
  // v1.72 (ADR-083) — link/unlink EXISTING PO ↔ Dev issues (Linking page modes 2 & 3)
  "link_dev_to_po",
  "unlink_dev_from_po",
];

const EXPECTED_GITHUB_TOOLS = [
  "list_prs",
  "get_pr",
  "get_pr_reviews",
  "link_pr_to_ticket",
  "sync_pr_links",
];

// ── Results accumulator ───────────────────────────────────────────────────────

const results = [];
let anyFail = false;

function pass(label) {
  results.push({ status: "PASS", label });
  console.log(`  PASS  ${label}`);
}

function fail(label, detail) {
  results.push({ status: "FAIL", label, detail });
  console.error(`  FAIL  ${label}`);
  if (detail) console.error(`        ${detail}`);
  anyFail = true;
}

// ── Process management ────────────────────────────────────────────────────────

function spawnBridge(packageDir, env) {
  const srcPath = path.join(packageDir, "src", "http.ts");

  // On Windows use shell:true so npx is resolved correctly
  const child = spawn("npx", ["tsx", srcPath], {
    cwd: packageDir,
    env,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return child;
}

function spawnStdio(packageDir, env) {
  const srcPath = path.join(packageDir, "src", "index.ts");

  const child = spawn("npx", ["tsx", srcPath], {
    cwd: packageDir,
    env,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return child;
}

async function killProcess(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    if (isWin) {
      // On Windows, kill the entire process tree
      const pid = child.pid;
      if (pid) {
        spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
          shell: true,
          stdio: "ignore",
        }).on("close", () => resolve());
      } else {
        child.kill();
        resolve();
      }
    } else {
      child.kill("SIGTERM");
      child.on("exit", resolve);
      setTimeout(resolve, 1000);
    }
  });
}

// ── HTTP polling ──────────────────────────────────────────────────────────────

async function waitForHealth(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function httpGet(url) {
  const res = await fetch(url);
  const body = await res.json();
  return { status: res.status, body };
}

async function httpPost(url, bodyObj) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(bodyObj),
  });
  const body = await res.json();
  return { status: res.status, body };
}

// ── Bridge smoke checks ───────────────────────────────────────────────────────

async function checkBridge(label, port, expectedTools) {
  const base = `http://127.0.0.1:${port}`;

  // Health
  try {
    const { status, body } = await httpGet(`${base}/api/health`);
    if (status === 200 && body.ok === true && typeof body.service === "string" && typeof body.version === "string") {
      pass(`[${label}] health shape: ok=true service=${body.service} version=${body.version}`);
    } else {
      fail(`[${label}] health shape`, `status=${status} body=${JSON.stringify(body)}`);
    }
  } catch (e) {
    fail(`[${label}] health shape`, String(e));
  }

  // Tools list — exact names + exact count
  try {
    const { status, body } = await httpGet(`${base}/api/tools`);
    if (status === 200 && body.ok === true && Array.isArray(body.data)) {
      const names = body.data.map((t) => t.name);
      if (names.length !== expectedTools.length) {
        fail(
          `[${label}] /api/tools count`,
          `expected ${expectedTools.length} tools, got ${names.length}: ${JSON.stringify(names)}`
        );
      } else {
        pass(`[${label}] /api/tools count=${expectedTools.length}`);
      }
      const missing = expectedTools.filter((n) => !names.includes(n));
      const extra = names.filter((n) => !expectedTools.includes(n));
      if (missing.length > 0) {
        fail(`[${label}] /api/tools missing names`, JSON.stringify(missing));
      } else {
        pass(`[${label}] /api/tools all contract names present`);
      }
      if (extra.length > 0) {
        fail(`[${label}] /api/tools extra names not in contract`, JSON.stringify(extra));
      }
    } else {
      fail(`[${label}] /api/tools`, `status=${status} body=${JSON.stringify(body)}`);
    }
  } catch (e) {
    fail(`[${label}] /api/tools`, String(e));
  }

  // 404 UNKNOWN_TOOL
  try {
    const { status, body } = await httpPost(`${base}/api/tools/nope`, {});
    if (status === 404 && body.ok === false && body.error?.code === "UNKNOWN_TOOL") {
      pass(`[${label}] POST /api/tools/nope → 404 UNKNOWN_TOOL`);
    } else {
      fail(`[${label}] POST /api/tools/nope`, `status=${status} code=${body.error?.code}`);
    }
  } catch (e) {
    fail(`[${label}] POST /api/tools/nope`, String(e));
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

const jiraDir = path.join(repoRoot, "packages", "mcp-jira");
const githubDir = path.join(repoRoot, "packages", "mcp-github");

console.log("\n=== HTTP Bridge Smoke Tests ===\n");

// Spawn both bridges
console.log("Spawning mcp-jira HTTP bridge on port", JIRA_PORT, "...");
const jiraBridge = spawnBridge(jiraDir, JIRA_ENV);
let jiraBridgeStderr = "";
jiraBridge.stderr.on("data", (d) => { jiraBridgeStderr += d.toString(); });
jiraBridge.on("error", (e) => console.error("jira bridge spawn error:", e));

console.log("Spawning mcp-github HTTP bridge on port", GITHUB_PORT, "...");
const githubBridge = spawnBridge(githubDir, GITHUB_ENV);
let githubBridgeStderr = "";
githubBridge.stderr.on("data", (d) => { githubBridgeStderr += d.toString(); });
githubBridge.on("error", (e) => console.error("github bridge spawn error:", e));

// Wait for both to become healthy
console.log("Waiting for bridges to start (timeout: 20s each)...\n");

const [jiraReady, githubReady] = await Promise.all([
  waitForHealth(`http://127.0.0.1:${JIRA_PORT}/api/health`),
  waitForHealth(`http://127.0.0.1:${GITHUB_PORT}/api/health`),
]);

if (!jiraReady) {
  fail("[JIRA] bridge startup", `Did not respond within 20s. stderr: ${jiraBridgeStderr.slice(0, 500)}`);
} else {
  pass("[JIRA] bridge started and health endpoint reachable");
  await checkBridge("JIRA", JIRA_PORT, EXPECTED_JIRA_TOOLS);

  // JIRA-specific: create_po_ticket {} → 400 VALIDATION with issues
  try {
    const { status, body } = await httpPost(
      `http://127.0.0.1:${JIRA_PORT}/api/tools/create_po_ticket`,
      {}
    );
    if (
      status === 400 &&
      body.ok === false &&
      body.error?.code === "VALIDATION" &&
      Array.isArray(body.error.issues) &&
      body.error.issues.length > 0
    ) {
      pass("[JIRA] POST create_po_ticket {} → 400 VALIDATION with issues array");
    } else {
      fail(
        "[JIRA] POST create_po_ticket {} → 400 VALIDATION",
        `status=${status} code=${body.error?.code} issues=${JSON.stringify(body.error?.issues)}`
      );
    }
  } catch (e) {
    fail("[JIRA] POST create_po_ticket {} → 400 VALIDATION", String(e));
  }

  // JIRA: update_ticket {ticketKey:"DEV-1"} → 400 VALIDATION (refine: no summary or description)
  try {
    const { status, body } = await httpPost(
      `http://127.0.0.1:${JIRA_PORT}/api/tools/update_ticket`,
      { ticketKey: "DEV-1" }
    );
    if (
      status === 400 &&
      body.ok === false &&
      body.error?.code === "VALIDATION"
    ) {
      pass("[JIRA] POST update_ticket {ticketKey:DEV-1} → 400 VALIDATION (refine path)");
    } else {
      fail(
        "[JIRA] POST update_ticket {ticketKey:DEV-1} → 400 VALIDATION (refine)",
        `status=${status} code=${body.error?.code} body=${JSON.stringify(body)}`
      );
    }
  } catch (e) {
    fail("[JIRA] POST update_ticket refine → 400 VALIDATION", String(e));
  }

  // JIRA v1.1: health.ai reports disabled when AI_PROVIDER is empty
  try {
    const { status, body } = await httpGet(`http://127.0.0.1:${JIRA_PORT}/api/health`);
    const ai = body.ai;
    if (
      status === 200 &&
      ai &&
      ai.enabled === false &&
      ai.provider === null &&
      ai.model === null
    ) {
      pass("[JIRA] health.ai disabled shape: enabled=false provider=null model=null");
    } else {
      fail("[JIRA] health.ai disabled shape", `status=${status} ai=${JSON.stringify(ai)}`);
    }
  } catch (e) {
    fail("[JIRA] health.ai disabled shape", String(e));
  }

  // JIRA v1.6 + v1.25: health.boards exposes dev + po project LISTS (arrays; element 0 = default)
  try {
    const { status, body } = await httpGet(`http://127.0.0.1:${JIRA_PORT}/api/health`);
    const b = body.boards;
    if (
      status === 200 && b &&
      Array.isArray(b.dev) && typeof b.dev[0]?.id === "number" && typeof b.dev[0]?.projectKey === "string" &&
      Array.isArray(b.po) && typeof b.po[0]?.id === "number" && typeof b.po[0]?.projectKey === "string"
    ) {
      pass(`[JIRA] health.boards arrays: dev[${b.dev.length}]=${b.dev[0].id}/${b.dev[0].projectKey} po[${b.po.length}]=${b.po[0].id}/${b.po[0].projectKey}`);
    } else {
      fail("[JIRA] health.boards arrays shape", `status=${status} boards=${JSON.stringify(b)}`);
    }
  } catch (e) {
    fail("[JIRA] health.boards arrays shape", String(e));
  }

  // JIRA v1.26: health.policy exposes the offset policy (N required points + N2 threshold)
  try {
    const { status, body } = await httpGet(`http://127.0.0.1:${JIRA_PORT}/api/health`);
    const p = body.policy;
    if (status === 200 && p && typeof p.requiredPoints === "number" && typeof p.offsetThreshold === "number") {
      pass(`[JIRA] health.policy: requiredPoints=${p.requiredPoints} offsetThreshold=${p.offsetThreshold}`);
    } else {
      fail("[JIRA] health.policy shape", `status=${status} policy=${JSON.stringify(p)}`);
    }
  } catch (e) {
    fail("[JIRA] health.policy shape", String(e));
  }

  // JIRA v1.26: get_offset_ledger {} → 200 with an entries map (read-only; temp store)
  try {
    const { status, body } = await httpPost(`http://127.0.0.1:${JIRA_PORT}/api/tools/get_offset_ledger`, {});
    if (status === 200 && body.ok === true && body.data && typeof body.data.entries === "object") {
      pass("[JIRA] POST get_offset_ledger {} → 200 entries map");
    } else {
      fail("[JIRA] POST get_offset_ledger {} → 200", `status=${status} body=${JSON.stringify(body).slice(0, 160)}`);
    }
  } catch (e) {
    fail("[JIRA] POST get_offset_ledger {} → 200", String(e));
  }

  // JIRA v1.29: get_all_leaves {} → 200 with a leaves map (read-only; whole store)
  try {
    const { status, body } = await httpPost(`http://127.0.0.1:${JIRA_PORT}/api/tools/get_all_leaves`, {});
    if (status === 200 && body.ok === true && body.data && typeof body.data.leaves === "object") {
      pass("[JIRA] POST get_all_leaves {} → 200 leaves map");
    } else {
      fail("[JIRA] POST get_all_leaves {} → 200", `status=${status} body=${JSON.stringify(body).slice(0, 160)}`);
    }
  } catch (e) {
    fail("[JIRA] POST get_all_leaves {} → 200", String(e));
  }

  // JIRA v1.44 (ADR-054): Task Helper routes must SAFELY REFUSE an unauthenticated request —
  // 503 TASK_HELPER_UNAVAILABLE when the secrets aren't set, or 401 UNAUTHENTICATED when they
  // are (a developer .env may carry them). Either is fine; a 200/500/token-leak is not.
  try {
    const { status, body } = await httpGet(`http://127.0.0.1:${JIRA_PORT}/api/me/connections`);
    const safe =
      body.ok === false &&
      ((status === 503 && body.error?.code === "TASK_HELPER_UNAVAILABLE") ||
        (status === 401 && body.error?.code === "UNAUTHENTICATED"));
    if (safe) {
      pass(`[JIRA] GET /api/me/connections (no session) → ${status} ${body.error?.code} (safely refuses)`);
    } else {
      fail("[JIRA] GET /api/me/connections → 401/503", `status=${status} code=${body.error?.code}`);
    }
  } catch (e) {
    fail("[JIRA] GET /api/me/connections → 401/503", String(e));
  }

  // JIRA v1.5: set_leaves {} → 400 VALIDATION (sprintId/assignee required) — no Jira, no real file write
  try {
    const { status, body } = await httpPost(`http://127.0.0.1:${JIRA_PORT}/api/tools/set_leaves`, {});
    if (status === 400 && body.ok === false && body.error?.code === "VALIDATION") {
      pass("[JIRA] POST set_leaves {} → 400 VALIDATION");
    } else {
      fail("[JIRA] POST set_leaves {} → 400 VALIDATION", `status=${status} code=${body.error?.code}`);
    }
  } catch (e) {
    fail("[JIRA] POST set_leaves {} → 400 VALIDATION", String(e));
  }

  // JIRA v1.7: assign_issue {} → 400 VALIDATION (ticketKey required) — never reaches Jira (no real write)
  try {
    const { status, body } = await httpPost(`http://127.0.0.1:${JIRA_PORT}/api/tools/assign_issue`, {});
    if (status === 400 && body.ok === false && body.error?.code === "VALIDATION") {
      pass("[JIRA] POST assign_issue {} → 400 VALIDATION (no real assignment)");
    } else {
      fail("[JIRA] POST assign_issue {} → 400 VALIDATION", `status=${status} code=${body.error?.code}`);
    }
  } catch (e) {
    fail("[JIRA] POST assign_issue {} → 400 VALIDATION", String(e));
  }

  // JIRA v1.13: set_sprint_goal {} → 400 VALIDATION (sprintId required) — never reaches Jira (no real write)
  try {
    const { status, body } = await httpPost(`http://127.0.0.1:${JIRA_PORT}/api/tools/set_sprint_goal`, {});
    if (status === 400 && body.ok === false && body.error?.code === "VALIDATION") {
      pass("[JIRA] POST set_sprint_goal {} → 400 VALIDATION (no real goal write)");
    } else {
      fail("[JIRA] POST set_sprint_goal {} → 400 VALIDATION", `status=${status} code=${body.error?.code}`);
    }
  } catch (e) {
    fail("[JIRA] POST set_sprint_goal {} → 400 VALIDATION", String(e));
  }

  // JIRA v1.14: get_issue_descriptions {} → 400 VALIDATION (keys required) — never reaches Jira (no real read)
  try {
    const { status, body } = await httpPost(`http://127.0.0.1:${JIRA_PORT}/api/tools/get_issue_descriptions`, {});
    if (status === 400 && body.ok === false && body.error?.code === "VALIDATION") {
      pass("[JIRA] POST get_issue_descriptions {} → 400 VALIDATION (keys required)");
    } else {
      fail("[JIRA] POST get_issue_descriptions {} → 400 VALIDATION", `status=${status} code=${body.error?.code}`);
    }
  } catch (e) {
    fail("[JIRA] POST get_issue_descriptions {} → 400 VALIDATION", String(e));
  }

  // JIRA v1.15: ticket-action tools reject empty input (no real Jira writes)
  // JIRA v1.16: Huddle store tools reject empty input (validation precedes any file write)
  for (const tool of [
    "get_transitions", "transition_issue", "move_issue_to_sprint",
    "get_impediments", "set_impediments", "get_pull_requests", "set_pull_requests",
    // v1.20 — post-scrum + meeting-goal stores (validation precedes any file write)
    "get_post_scrum", "set_post_scrum", "get_meeting_goal", "set_meeting_goal",
    // v1.41 — meeting-notes store (validation precedes any file write)
    "get_meeting_notes", "set_meeting_notes",
    // v1.42 — retro store (validation precedes any file write)
    "get_retro", "set_retro",
    // v1.22 — linked PRs (validation precedes any Jira read)
    "get_issue_pull_requests",
    // v1.26 — offset writes reject empty input (validation precedes any file write)
    "set_offset_for_sprint", "set_offset_adjustment",
    // v1.54 (ADR-065) — manual-adjustment log writes reject empty input
    "add_offset_adjustment", "delete_offset_adjustment",
    // v1.68 — draft-plan store tools reject empty input (sprintId is required on both;
    // validation precedes any file read/write — draft only, never reaches Jira)
    "get_draft_plan", "set_draft_plan",
  ]) {
    try {
      const { status, body } = await httpPost(`http://127.0.0.1:${JIRA_PORT}/api/tools/${tool}`, {});
      if (status === 400 && body.ok === false && body.error?.code === "VALIDATION") {
        pass(`[JIRA] POST ${tool} {} → 400 VALIDATION (no real write)`);
      } else {
        fail(`[JIRA] POST ${tool} {} → 400 VALIDATION`, `status=${status} code=${body.error?.code}`);
      }
    } catch (e) {
      fail(`[JIRA] POST ${tool} {} → 400 VALIDATION`, String(e));
    }
  }

  // JIRA v1.8: team roster store round-trip (temp file; no Jira call) + clear
  try {
    const m = [{ accountId: "acc-smoke-1", displayName: "Smoke Tester" }];
    const set = await httpPost(`http://127.0.0.1:${JIRA_PORT}/api/tools/set_team_members`, { boardId: 1, members: m });
    const get = await httpPost(`http://127.0.0.1:${JIRA_PORT}/api/tools/get_team_members`, { boardId: 1 });
    const ok = set.status === 200 && get.status === 200 &&
      Array.isArray(get.body.data?.members) && get.body.data.members[0]?.accountId === "acc-smoke-1";
    if (ok) pass("[JIRA] set_team_members → get_team_members round-trips (temp store)");
    else fail("[JIRA] team roster round-trip", `set=${set.status} get=${JSON.stringify(get.body).slice(0,160)}`);
    // clear
    await httpPost(`http://127.0.0.1:${JIRA_PORT}/api/tools/set_team_members`, { boardId: 1, members: [] });
  } catch (e) {
    fail("[JIRA] team roster round-trip", String(e));
  }

  // JIRA v1.68 (ADR-079): set_draft_plan with one developer share → 200, echoes
  // { sprintId, devSprintId, assignments } — assignments values are DraftShare[] (v1.70,
  // ADR-081: a ticket may be split across multiple developers) (temp file; DRAFT ONLY — never
  // calls Jira)
  try {
    const { status, body } = await httpPost(`http://127.0.0.1:${JIRA_PORT}/api/tools/set_draft_plan`, {
      sprintId: 9001,
      devSprintId: 9002,
      assignments: { "DEV-1": [{ accountId: "acc-1", displayName: "Dev One", points: 3 }] },
    });
    const ok =
      status === 200 &&
      body.ok === true &&
      body.data?.sprintId === 9001 &&
      body.data?.devSprintId === 9002 &&
      Array.isArray(body.data?.assignments?.["DEV-1"]) &&
      body.data.assignments["DEV-1"][0]?.accountId === "acc-1" &&
      body.data.assignments["DEV-1"][0]?.displayName === "Dev One" &&
      body.data.assignments["DEV-1"][0]?.points === 3;
    if (ok) {
      pass("[JIRA] POST set_draft_plan → 200, echoes sprintId/devSprintId/assignments");
    } else {
      fail("[JIRA] POST set_draft_plan → 200", `status=${status} body=${JSON.stringify(body).slice(0, 200)}`);
    }
    // clear so this smoke run leaves no draft behind in the temp store
    await httpPost(`http://127.0.0.1:${JIRA_PORT}/api/tools/set_draft_plan`, { sprintId: 9001, assignments: {} });
  } catch (e) {
    fail("[JIRA] POST set_draft_plan → 200", String(e));
  }

  // JIRA v1.68 (ADR-079): get_draft_plan for a sprintId with no saved draft → 200 with the
  // empty-but-valid shape (devSprintId: null, assignments: {}) — not an error
  try {
    const { status, body } = await httpPost(`http://127.0.0.1:${JIRA_PORT}/api/tools/get_draft_plan`, {
      sprintId: 9099,
    });
    const ok =
      status === 200 &&
      body.ok === true &&
      body.data?.sprintId === 9099 &&
      body.data?.devSprintId === null &&
      Object.keys(body.data?.assignments ?? { x: 1 }).length === 0;
    if (ok) {
      pass("[JIRA] POST get_draft_plan (unused sprintId) → 200 devSprintId:null assignments:{}");
    } else {
      fail("[JIRA] POST get_draft_plan (unused sprintId) → 200", `status=${status} body=${JSON.stringify(body).slice(0, 200)}`);
    }
  } catch (e) {
    fail("[JIRA] POST get_draft_plan (unused sprintId) → 200", String(e));
  }

  // JIRA v1.68 (ADR-079): set_draft_plan with an invalid (lowercase) assignments key → 400
  // VALIDATION — never reaches the store write (assignments value is DraftShare[], v1.70)
  try {
    const { status, body } = await httpPost(`http://127.0.0.1:${JIRA_PORT}/api/tools/set_draft_plan`, {
      sprintId: 9001,
      assignments: { "dev-1": [{ accountId: "a", displayName: "b", points: 1 }] },
    });
    if (status === 400 && body.ok === false && body.error?.code === "VALIDATION") {
      pass("[JIRA] POST set_draft_plan (invalid assignments key) → 400 VALIDATION");
    } else {
      fail("[JIRA] POST set_draft_plan (invalid assignments key) → 400 VALIDATION", `status=${status} code=${body.error?.code}`);
    }
  } catch (e) {
    fail("[JIRA] POST set_draft_plan (invalid assignments key) → 400 VALIDATION", String(e));
  }

  // JIRA v1.1: AI endpoint returns 503 AI_UNAVAILABLE when no provider configured
  try {
    const { status, body } = await httpPost(
      `http://127.0.0.1:${JIRA_PORT}/api/ai/draft-tickets`,
      { messages: [{ role: "user", content: "Password reset via email" }] }
    );
    if (status === 503 && body.ok === false && body.error?.code === "AI_UNAVAILABLE") {
      pass("[JIRA] POST /api/ai/draft-tickets → 503 AI_UNAVAILABLE when AI disabled");
    } else {
      fail(
        "[JIRA] POST /api/ai/draft-tickets → 503 AI_UNAVAILABLE",
        `status=${status} code=${body.error?.code} body=${JSON.stringify(body).slice(0, 300)}`
      );
    }
  } catch (e) {
    fail("[JIRA] POST /api/ai/draft-tickets → 503 AI_UNAVAILABLE", String(e));
  }

  // JIRA v1.4: create_sprint {} → 400 VALIDATION (name required) — does NOT hit Jira
  try {
    const { status, body } = await httpPost(
      `http://127.0.0.1:${JIRA_PORT}/api/tools/create_sprint`,
      {}
    );
    if (status === 400 && body.ok === false && body.error?.code === "VALIDATION") {
      pass("[JIRA] POST create_sprint {} → 400 VALIDATION (name required)");
    } else {
      fail("[JIRA] POST create_sprint {} → 400 VALIDATION",
        `status=${status} code=${body.error?.code}`);
    }
  } catch (e) {
    fail("[JIRA] POST create_sprint {} → 400 VALIDATION", String(e));
  }

  // JIRA v1.4: AI sprint-summary → 503 AI_UNAVAILABLE when AI disabled
  try {
    const { status, body } = await httpPost(
      `http://127.0.0.1:${JIRA_PORT}/api/ai/sprint-summary`,
      { sprintName: "S", state: "closed", committedPoints: 0, completedPoints: 0,
        completedCount: 0, totalCount: 0, carryoverCount: 0, blockedCount: 0, byAssignee: [] }
    );
    if (status === 503 && body.ok === false && body.error?.code === "AI_UNAVAILABLE") {
      pass("[JIRA] POST /api/ai/sprint-summary → 503 AI_UNAVAILABLE when AI disabled");
    } else {
      fail("[JIRA] POST /api/ai/sprint-summary → 503 AI_UNAVAILABLE",
        `status=${status} code=${body.error?.code} body=${JSON.stringify(body).slice(0, 200)}`);
    }
  } catch (e) {
    fail("[JIRA] POST /api/ai/sprint-summary → 503 AI_UNAVAILABLE", String(e));
  }

  // JIRA v1.11: AI plan-dev-tickets → 503 AI_UNAVAILABLE when AI disabled
  try {
    const { status, body } = await httpPost(
      `http://127.0.0.1:${JIRA_PORT}/api/ai/plan-dev-tickets`,
      { poStories: [{ key: "PO-1", summary: "x" }] }
    );
    if (status === 503 && body.ok === false && body.error?.code === "AI_UNAVAILABLE") {
      pass("[JIRA] POST /api/ai/plan-dev-tickets → 503 AI_UNAVAILABLE when AI disabled");
    } else {
      fail("[JIRA] POST /api/ai/plan-dev-tickets → 503 AI_UNAVAILABLE",
        `status=${status} code=${body.error?.code} body=${JSON.stringify(body).slice(0, 200)}`);
    }
  } catch (e) {
    fail("[JIRA] POST /api/ai/plan-dev-tickets → 503 AI_UNAVAILABLE", String(e));
  }

  // JIRA v1.72 (ADR-083): AI draft-po-story (the inverse rollup) → 503 AI_UNAVAILABLE when AI
  // disabled — the Linking "New PO from Dev tasks" mode falls back to a deterministic rollup.
  try {
    const { status, body } = await httpPost(
      `http://127.0.0.1:${JIRA_PORT}/api/ai/draft-po-story`,
      { devTickets: [{ key: "DEV-1", summary: "x" }] }
    );
    if (status === 503 && body.ok === false && body.error?.code === "AI_UNAVAILABLE") {
      pass("[JIRA] POST /api/ai/draft-po-story → 503 AI_UNAVAILABLE when AI disabled");
    } else {
      fail("[JIRA] POST /api/ai/draft-po-story → 503 AI_UNAVAILABLE",
        `status=${status} code=${body.error?.code} body=${JSON.stringify(body).slice(0, 200)}`);
    }
  } catch (e) {
    fail("[JIRA] POST /api/ai/draft-po-story → 503 AI_UNAVAILABLE", String(e));
  }

  // JIRA v1.18: AI Q&A assistant /api/ai/ask → 503 AI_UNAVAILABLE when AI disabled
  try {
    const { status, body } = await httpPost(
      `http://127.0.0.1:${JIRA_PORT}/api/ai/ask`,
      { question: "any impediments today?" }
    );
    if (status === 503 && body.ok === false && body.error?.code === "AI_UNAVAILABLE") {
      pass("[JIRA] POST /api/ai/ask → 503 AI_UNAVAILABLE when AI disabled");
    } else {
      fail("[JIRA] POST /api/ai/ask → 503 AI_UNAVAILABLE",
        `status=${status} code=${body.error?.code} body=${JSON.stringify(body).slice(0, 200)}`);
    }
  } catch (e) {
    fail("[JIRA] POST /api/ai/ask → 503 AI_UNAVAILABLE", String(e));
  }

  // JIRA v1.71 (ADR-082): streaming assistant /api/ai/ask/stream → 503 AI_UNAVAILABLE (pre-flush
  // failure uses the JSON envelope + status, exactly like /api/ai/ask, so clients can fall back).
  try {
    const { status, body } = await httpPost(
      `http://127.0.0.1:${JIRA_PORT}/api/ai/ask/stream`,
      { question: "any impediments today?" }
    );
    if (status === 503 && body.ok === false && body.error?.code === "AI_UNAVAILABLE") {
      pass("[JIRA] POST /api/ai/ask/stream → 503 AI_UNAVAILABLE when AI disabled");
    } else {
      fail("[JIRA] POST /api/ai/ask/stream → 503 AI_UNAVAILABLE",
        `status=${status} code=${body.error?.code} body=${JSON.stringify(body).slice(0, 200)}`);
    }
  } catch (e) {
    fail("[JIRA] POST /api/ai/ask/stream → 503 AI_UNAVAILABLE", String(e));
  }

  // JIRA v1.18: /api/ai/ask {} → 400 VALIDATION (question required)
  try {
    const { status, body } = await httpPost(`http://127.0.0.1:${JIRA_PORT}/api/ai/ask`, {});
    if (status === 400 && body.ok === false && body.error?.code === "VALIDATION") {
      pass("[JIRA] POST /api/ai/ask {} → 400 VALIDATION (question required)");
    } else {
      fail("[JIRA] POST /api/ai/ask {} → 400 VALIDATION", `status=${status} code=${body.error?.code}`);
    }
  } catch (e) {
    fail("[JIRA] POST /api/ai/ask {} → 400 VALIDATION", String(e));
  }
}

if (!githubReady) {
  fail("[GITHUB] bridge startup", `Did not respond within 20s. stderr: ${githubBridgeStderr.slice(0, 500)}`);
} else {
  pass("[GITHUB] bridge started and health endpoint reachable");
  await checkBridge("GITHUB", GITHUB_PORT, EXPECTED_GITHUB_TOOLS);

  // GITHUB: link_pr_to_ticket {} → 400 VALIDATION (number is required)
  try {
    const { status, body } = await httpPost(
      `http://127.0.0.1:${GITHUB_PORT}/api/tools/link_pr_to_ticket`,
      {}
    );
    if (
      status === 400 &&
      body.ok === false &&
      body.error?.code === "VALIDATION"
    ) {
      pass("[GITHUB] POST link_pr_to_ticket {} → 400 VALIDATION");
    } else {
      fail(
        "[GITHUB] POST link_pr_to_ticket {}",
        `status=${status} code=${body.error?.code}`
      );
    }
  } catch (e) {
    fail("[GITHUB] POST link_pr_to_ticket {} → 400 VALIDATION", String(e));
  }

  // GITHUB v1.21: get_pr_reviews {} → 400 VALIDATION (numbers required; no real GitHub read)
  try {
    const { status, body } = await httpPost(
      `http://127.0.0.1:${GITHUB_PORT}/api/tools/get_pr_reviews`,
      {}
    );
    if (status === 400 && body.ok === false && body.error?.code === "VALIDATION") {
      pass("[GITHUB] POST get_pr_reviews {} → 400 VALIDATION (numbers required)");
    } else {
      fail("[GITHUB] POST get_pr_reviews {} → 400 VALIDATION",
        `status=${status} code=${body.error?.code}`);
    }
  } catch (e) {
    fail("[GITHUB] POST get_pr_reviews {} → 400 VALIDATION", String(e));
  }
}

// Kill bridges
await Promise.all([killProcess(jiraBridge), killProcess(githubBridge)]);

// ── stdio smoke tests ─────────────────────────────────────────────────────────

console.log("\n=== stdio MCP Smoke Tests ===\n");

async function checkStdio(label, packageDir, env, expectedLine) {
  return new Promise((resolve) => {
    const child = spawnStdio(packageDir, env);
    let stderr = "";
    let stdout = "";

    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.stdout.on("data", (d) => { stdout += d.toString(); });

    const deadline = setTimeout(async () => {
      await killProcess(child);
      // Check assertions
      if (stderr.includes(expectedLine)) {
        pass(`[${label}] stderr contains startup line: "${expectedLine}"`);
      } else {
        fail(
          `[${label}] stderr startup line`,
          `Expected: "${expectedLine}"\nGot stderr: ${stderr.slice(0, 500)}`
        );
      }
      if (stdout.length > 0) {
        fail(
          `[${label}] nothing written to stdout`,
          `stdout contained: ${stdout.slice(0, 200)}`
        );
      } else {
        pass(`[${label}] stdout is empty (MCP protocol frames not polluted)`);
      }
      resolve();
    }, 7000);

    // If process exits early with error, still check
    child.on("exit", (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(deadline);
        fail(`[${label}] stdio process exited with code ${code}`, `stderr: ${stderr.slice(0, 500)}`);
        resolve();
      }
    });
  });
}

await checkStdio(
  "STDIO-JIRA",
  jiraDir,
  JIRA_ENV,
  "Jira MCP server running — waiting for tool calls..."
);

await checkStdio(
  "STDIO-GITHUB",
  githubDir,
  GITHUB_ENV,
  "GitHub MCP server running — waiting for tool calls..."
);

// ── Summary ───────────────────────────────────────────────────────────────────

console.log("\n=== Summary ===\n");
const passed = results.filter((r) => r.status === "PASS").length;
const failed = results.filter((r) => r.status === "FAIL").length;

for (const r of results) {
  const mark = r.status === "PASS" ? "PASS" : "FAIL";
  console.log(`  ${mark}  ${r.label}`);
  if (r.status === "FAIL" && r.detail) {
    console.log(`         ${r.detail}`);
  }
}

console.log(`\n${passed} passed, ${failed} failed\n`);

if (anyFail) {
  process.exit(1);
}
