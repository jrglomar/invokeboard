/**
 * Jira MCP HTTP bridge — Express adapter for the React dashboard.
 *
 * Exposes the same transport-agnostic tool registry as the stdio entry
 * via HTTP on port MCP_JIRA_HTTP_PORT (default 4001).
 *
 * Also exposes AI drafting endpoints (§4.9) that are NOT in the tool registry.
 *
 * CORS: allows http://localhost:5173 and http://127.0.0.1:5173.
 *
 * Design note: getConfig() is NOT called at module-import time so that
 * this module can be imported in tests that set process.env before calling
 * getConfig(). The only top-level code here is Express middleware registration,
 * which has no side effects on env.
 */

import express from "express";
import cors from "cors";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import * as path from "path";
import { z } from "zod";
import { tools } from "./tools/index.js";
import { getConfig, getProjects, getOffsetPolicy, getAgingPolicy, type ProjectRef } from "./lib/config.js";
import { UpstreamError, ConfigError } from "./lib/errors.js";
import { ZodError } from "zod";
import { getAiProvider, getAiStatus } from "./lib/ai/provider.js";
import { draftTickets, enhanceTicket, draftSprintSummary, planDevTickets, draftPoStory } from "./lib/ai/draftService.js";
import { askAssistant, askAssistantStream } from "./lib/ai/askService.js";
import { taskHelperRouter } from "./routes/taskHelper.js";
import { adminRouter } from "./routes/admin.js";
import { perUserContext } from "./lib/auth/perUserContext.js";
import { canWriteJira } from "./lib/requestContext.js";
import { JIRA_WRITE_TOOLS } from "./lib/delegation.js";

// ---- Read package version at startup ----
const _require = createRequire(import.meta.url);
const thisDir = path.dirname(fileURLToPath(import.meta.url));
// src/http.ts → ../package.json
const pkgPath = path.resolve(thisDir, "../package.json");
const pkgJson = _require(pkgPath) as { version: string };
const SERVICE_VERSION = pkgJson.version;

// ---- Express app ----

export const app = express();

app.use(express.json());

// CORS allowlist — read from CORS_ORIGINS (comma-separated) at REQUEST time so
// this module stays importable in tests without calling getConfig() at import.
// Default preserves the original dev origins. "*" allows any origin (use behind
// a trusted proxy only). Requests with no Origin header (server-to-server, same
// -origin, curl) are always allowed.
export function parseCorsOrigins(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") {
    return ["http://localhost:5173", "http://127.0.0.1:5173"];
  }
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// v1.66 (security): per-request CORS options so `credentials` can depend on HOW the origin
// matched. The Task Helper session cookie makes this bridge credentialed, so honoring a
// `CORS_ORIGINS=*` wildcard WITH credentials would let ANY site drive the API using a victim's
// cookie. Fix: credentials are granted only for an EXPLICITLY listed origin (or a no-Origin
// same-origin request). A `*` wildcard still reflects the origin for cross-origin reads, but with
// credentials OFF — the cookie is never honored against a wildcard. See CONTRACTS.md §2.
app.use(
  cors((req, callback) => {
    const origin = req.headers.origin;
    const allow = parseCorsOrigins(process.env["CORS_ORIGINS"]);
    const explicit = origin !== undefined && allow.includes(origin);
    const allowed = origin === undefined || explicit || allow.includes("*");
    callback(null, {
      origin: allowed,
      // Credentials ONLY when the origin was explicitly listed (or same-origin/no-Origin).
      // A `*` match reflects the origin but must NOT carry credentials.
      credentials: origin === undefined || explicit,
      // v1.47 (ADR-057): PATCH is required by the journal to-do toggle. Omitting a verb here makes
      // the browser's preflight reject the call even though the route exists (same-process tests
      // never preflight, so this only ever fails in a real browser).
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
      allowedHeaders: ["Content-Type"],
    });
  })
);

// v1.44 (ADR-054): Task Helper routes (auth + per-user connections + AI ticket→prompt).
// Mounted here only — never in the MCP tool registry or the stdio server.
app.use(taskHelperRouter);

// v1.45 (ADR-055 Phase B): super-admin console API (/api/admin/*), guarded by requireAdmin.
app.use(adminRouter);

// v1.45 (ADR-055): per-user request scoping. When authenticated, tool + AI calls run on the
// signed-in user's own Jira/GitHub/AI (via AsyncLocalStorage in getConfig); unauthenticated
// requests fall back to the global .env (stdio/Copilot + keyless smoke unaffected).
app.use(["/api/tools", "/api/ai"], perUserContext);

// ---- Error envelope helper ----

interface ErrorEnvelope {
  ok: false;
  error: {
    code: string;
    message: string;
    issues?: unknown[];
  };
}

function errorResponse(
  res: express.Response,
  status: number,
  code: string,
  message: string,
  issues?: unknown[]
): void {
  const body: ErrorEnvelope = { ok: false, error: { code, message } };
  if (issues !== undefined) body.error.issues = issues;
  res.status(status).json(body);
}

// ---- Input zod schemas for AI endpoints (v3 zod — same as rest of codebase) ----

const messageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(4000),
});

const draftTicketsInputSchema = z
  .object({
    messages: z.array(messageSchema).min(1),
    storyPoints: z.number().int().nonnegative().optional(),
  })
  .refine(
    (val) => val.messages[val.messages.length - 1]?.role === "user",
    { message: "Last message must have role 'user'" }
  );

const TICKET_KEY_REGEX = /^[A-Z][A-Z0-9]{1,9}-\d+$/;

const enhanceTicketInputSchema = z.object({
  ticketKey: z
    .string()
    .regex(TICKET_KEY_REGEX, "ticketKey must match PROJECT-NUMBER format"),
  notes: z.string().max(2000).optional(),
  current: z.object({
    summary: z.string(),
    description: z.string(),
  }),
});

// ---- Input zod schema for plan-dev-tickets AI endpoint (v1.11, ADR-022) ----

const planDevTicketsInputSchema = z.object({
  poStories: z
    .array(
      z.object({
        key: z.string().min(1),
        summary: z.string().min(1),
        description: z.string().optional(),
      })
    )
    .min(1)
    .max(20),
  instructions: z.string().max(2000).optional(),
});

// ---- Input zod schema for draft-po-story AI endpoint (v1.72, ADR-083) ----

const draftPoStoryInputSchema = z.object({
  devTickets: z
    .array(
      z.object({
        key: z.string().min(1),
        summary: z.string().min(1),
        description: z.string().optional(),
        storyPoints: z.number().nonnegative().nullable().optional(),
      })
    )
    .min(1)
    .max(20),
  instructions: z.string().max(2000).optional(),
});

// ---- Input zod schema for the AI Q&A assistant (v1.18, ADR-029) ----

const askInputSchema = z.object({
  question: z.string().min(1).max(2000),
  boardId: z.number().int().positive().optional(),
  sprintId: z.number().int().positive().optional(),
  // v1.40 (ADR-050): prior Ask-mode turns, oldest first — folded into the system prompt.
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(2000),
      })
    )
    .max(8)
    .optional(),
});

// ---- Input zod schema for sprint-summary AI endpoint (v1.4) ----

const sprintSummaryInputSchema = z.object({
  sprintName: z.string(),
  state: z.string(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  goal: z.string().nullable().optional(),
  committedPoints: z.number(),
  completedPoints: z.number(),
  completedCount: z.number().int(),
  totalCount: z.number().int(),
  carryoverCount: z.number().int(),
  blockedCount: z.number().int(),
  byAssignee: z.array(
    z.object({
      name: z.string(),
      donePoints: z.number(),
      totalPoints: z.number(),
      doneCount: z.number().int(),
      totalCount: z.number().int(),
    })
  ),
});

// ---- AI unavailable message ----
const AI_UNAVAILABLE_MSG =
  "AI drafting is disabled — set AI_PROVIDER=anthropic or github and the matching key (see docs/SETUP.md)";

// ---- Routes ----

// GET /api/health
app.get("/api/health", (_req, res) => {
  const ai = getAiStatus();

  // boards — pure config, no Jira call (v1.6, ADR-017)
  // getConfig() is safe here: if board IDs were missing the server would have
  // already exited at startup. The try/catch is a belt-and-suspenders guard so
  // health never throws (same philosophy as getAiStatus).
  // v1.25 (ADR-037): boards are now PER-SIDE LISTS (multi-project); element 0 = default.
  let boards: { dev: ProjectRef[]; po: ProjectRef[] };
  try {
    boards = getProjects();
  } catch {
    // Fallback: return sentinel values rather than crashing health
    boards = {
      dev: [{ id: NaN, projectKey: "DEV" }],
      po: [{ id: NaN, projectKey: "PO" }],
    };
  }

  // v1.26 (ADR-038): offset policy (N required points + N2 threshold) — pure config.
  let policy: { requiredPoints: number; offsetThreshold: number };
  try {
    policy = getOffsetPolicy();
  } catch {
    policy = { requiredPoints: 8, offsetThreshold: 2 };
  }

  // v1.58 (ADR-070): ticket-aging policy — pure config, sibling of `policy`.
  let aging: { baseDays: number; daysPerPoint: number };
  try {
    aging = getAgingPolicy();
  } catch {
    aging = { baseDays: 1, daysPerPoint: 1 };
  }

  res.json({
    ok: true,
    service: "mcp-jira",
    version: SERVICE_VERSION,
    ai,
    boards,
    policy,
    aging,
  });
});

// GET /api/tools — tool registry only (AI endpoints NOT listed here)
app.get("/api/tools", (_req, res) => {
  res.json({
    ok: true,
    data: tools.map((t) => ({ name: t.name, description: t.description })),
  });
});

// POST /api/tools/:name
app.post("/api/tools/:name", async (req, res) => {
  const toolName = req.params["name"];
  const tool = tools.find((t) => t.name === toolName);

  if (!tool) {
    errorResponse(res, 404, "UNKNOWN_TOOL", `Tool '${toolName}' not found`);
    return;
  }

  // v1.46 (ADR-056): a user on SHARED Jira credentials may not mutate Jira unless an admin
  // granted writes — the change would be recorded under the token owner's name.
  if (JIRA_WRITE_TOOLS.has(tool.name) && !canWriteJira()) {
    errorResponse(
      res,
      403,
      "READ_ONLY_USER",
      "You're using shared Jira credentials, so you can't change Jira. Ask an admin to enable writes for your account, or connect your own Jira token."
    );
    return;
  }

  try {
    const result = await tool.handler(req.body);
    res.json({ ok: true, data: result });
  } catch (err) {
    if (err instanceof ZodError) {
      errorResponse(res, 400, "VALIDATION", "Input validation failed", err.issues);
      return;
    }
    if (err instanceof ConfigError) {
      errorResponse(res, 500, "CONFIG", err.message);
      return;
    }
    if (err instanceof UpstreamError) {
      errorResponse(res, 502, "UPSTREAM", err.message);
      return;
    }
    const msg = err instanceof Error ? err.message : "Internal server error";
    errorResponse(res, 500, "INTERNAL", msg);
  }
});

// POST /api/ai/draft-tickets
app.post("/api/ai/draft-tickets", async (req, res) => {
  // Parse input
  const parsed = draftTicketsInputSchema.safeParse(req.body);
  if (!parsed.success) {
    errorResponse(res, 400, "VALIDATION", "Input validation failed", parsed.error.issues);
    return;
  }

  // Resolve provider
  let provider;
  try {
    provider = await getAiProvider();
  } catch (err) {
    if (err instanceof ConfigError) {
      errorResponse(res, 500, "CONFIG", err.message);
      return;
    }
    const msg = err instanceof Error ? err.message : "Internal server error";
    errorResponse(res, 500, "INTERNAL", msg);
    return;
  }

  if (provider === null) {
    errorResponse(res, 503, "AI_UNAVAILABLE", AI_UNAVAILABLE_MSG);
    return;
  }

  // Call service
  try {
    const result = await draftTickets(
      provider,
      parsed.data.messages,
      parsed.data.storyPoints
    );
    res.json({ ok: true, data: result });
  } catch (err) {
    if (err instanceof UpstreamError) {
      errorResponse(res, 502, "UPSTREAM", err.message);
      return;
    }
    if (err instanceof ConfigError) {
      errorResponse(res, 500, "CONFIG", err.message);
      return;
    }
    const msg = err instanceof Error ? err.message : "Internal server error";
    errorResponse(res, 500, "INTERNAL", msg);
  }
});

// POST /api/ai/enhance-ticket
app.post("/api/ai/enhance-ticket", async (req, res) => {
  // Parse input
  const parsed = enhanceTicketInputSchema.safeParse(req.body);
  if (!parsed.success) {
    errorResponse(res, 400, "VALIDATION", "Input validation failed", parsed.error.issues);
    return;
  }

  // Resolve provider
  let provider;
  try {
    provider = await getAiProvider();
  } catch (err) {
    if (err instanceof ConfigError) {
      errorResponse(res, 500, "CONFIG", err.message);
      return;
    }
    const msg = err instanceof Error ? err.message : "Internal server error";
    errorResponse(res, 500, "INTERNAL", msg);
    return;
  }

  if (provider === null) {
    errorResponse(res, 503, "AI_UNAVAILABLE", AI_UNAVAILABLE_MSG);
    return;
  }

  // Call service
  try {
    const result = await enhanceTicket(
      provider,
      parsed.data.ticketKey,
      parsed.data.notes,
      parsed.data.current
    );
    res.json({ ok: true, data: result });
  } catch (err) {
    if (err instanceof UpstreamError) {
      errorResponse(res, 502, "UPSTREAM", err.message);
      return;
    }
    if (err instanceof ConfigError) {
      errorResponse(res, 500, "CONFIG", err.message);
      return;
    }
    const msg = err instanceof Error ? err.message : "Internal server error";
    errorResponse(res, 500, "INTERNAL", msg);
  }
});

// POST /api/ai/sprint-summary (v1.4, §4.9)
app.post("/api/ai/sprint-summary", async (req, res) => {
  // Parse input
  const parsed = sprintSummaryInputSchema.safeParse(req.body);
  if (!parsed.success) {
    errorResponse(res, 400, "VALIDATION", "Input validation failed", parsed.error.issues);
    return;
  }

  // Resolve provider
  let provider;
  try {
    provider = await getAiProvider();
  } catch (err) {
    if (err instanceof ConfigError) {
      errorResponse(res, 500, "CONFIG", err.message);
      return;
    }
    const msg = err instanceof Error ? err.message : "Internal server error";
    errorResponse(res, 500, "INTERNAL", msg);
    return;
  }

  if (provider === null) {
    errorResponse(res, 503, "AI_UNAVAILABLE", AI_UNAVAILABLE_MSG);
    return;
  }

  // Call service
  try {
    const result = await draftSprintSummary(provider, parsed.data);
    res.json({ ok: true, data: result });
  } catch (err) {
    if (err instanceof UpstreamError) {
      errorResponse(res, 502, "UPSTREAM", err.message);
      return;
    }
    if (err instanceof ConfigError) {
      errorResponse(res, 500, "CONFIG", err.message);
      return;
    }
    const msg = err instanceof Error ? err.message : "Internal server error";
    errorResponse(res, 500, "INTERNAL", msg);
  }
});

// POST /api/ai/plan-dev-tickets (v1.11, §4.9, ADR-022)
app.post("/api/ai/plan-dev-tickets", async (req, res) => {
  const parsed = planDevTicketsInputSchema.safeParse(req.body);
  if (!parsed.success) {
    errorResponse(res, 400, "VALIDATION", "Input validation failed", parsed.error.issues);
    return;
  }

  // Resolve provider
  let provider;
  try {
    provider = await getAiProvider();
  } catch (err) {
    if (err instanceof ConfigError) {
      errorResponse(res, 500, "CONFIG", err.message);
      return;
    }
    const msg = err instanceof Error ? err.message : "Internal server error";
    errorResponse(res, 500, "INTERNAL", msg);
    return;
  }

  if (provider === null) {
    errorResponse(res, 503, "AI_UNAVAILABLE", AI_UNAVAILABLE_MSG);
    return;
  }

  // Call service
  try {
    const result = await planDevTickets(
      provider,
      parsed.data.poStories,
      parsed.data.instructions
    );
    res.json({ ok: true, data: result });
  } catch (err) {
    if (err instanceof UpstreamError) {
      errorResponse(res, 502, "UPSTREAM", err.message);
      return;
    }
    if (err instanceof ConfigError) {
      errorResponse(res, 500, "CONFIG", err.message);
      return;
    }
    const msg = err instanceof Error ? err.message : "Internal server error";
    errorResponse(res, 500, "INTERNAL", msg);
  }
});

// POST /api/ai/draft-po-story (v1.72, §4.9, ADR-083) — roll N Dev tasks up into ONE PO story
app.post("/api/ai/draft-po-story", async (req, res) => {
  const parsed = draftPoStoryInputSchema.safeParse(req.body);
  if (!parsed.success) {
    errorResponse(res, 400, "VALIDATION", "Input validation failed", parsed.error.issues);
    return;
  }

  // Resolve provider
  let provider;
  try {
    provider = await getAiProvider();
  } catch (err) {
    if (err instanceof ConfigError) {
      errorResponse(res, 500, "CONFIG", err.message);
      return;
    }
    const msg = err instanceof Error ? err.message : "Internal server error";
    errorResponse(res, 500, "INTERNAL", msg);
    return;
  }

  if (provider === null) {
    errorResponse(res, 503, "AI_UNAVAILABLE", AI_UNAVAILABLE_MSG);
    return;
  }

  // Call service
  try {
    const result = await draftPoStory(
      provider,
      parsed.data.devTickets,
      parsed.data.instructions
    );
    res.json({ ok: true, data: result });
  } catch (err) {
    if (err instanceof UpstreamError) {
      errorResponse(res, 502, "UPSTREAM", err.message);
      return;
    }
    if (err instanceof ConfigError) {
      errorResponse(res, 500, "CONFIG", err.message);
      return;
    }
    const msg = err instanceof Error ? err.message : "Internal server error";
    errorResponse(res, 500, "INTERNAL", msg);
  }
});

// POST /api/ai/ask (v1.18, §4.9, ADR-029) — in-app AI Q&A assistant (read-only tool calls)
app.post("/api/ai/ask", async (req, res) => {
  const parsed = askInputSchema.safeParse(req.body);
  if (!parsed.success) {
    errorResponse(res, 400, "VALIDATION", "Input validation failed", parsed.error.issues);
    return;
  }

  let provider;
  try {
    provider = await getAiProvider();
  } catch (err) {
    if (err instanceof ConfigError) {
      errorResponse(res, 500, "CONFIG", err.message);
      return;
    }
    const msg = err instanceof Error ? err.message : "Internal server error";
    errorResponse(res, 500, "INTERNAL", msg);
    return;
  }

  if (provider === null) {
    errorResponse(res, 503, "AI_UNAVAILABLE", AI_UNAVAILABLE_MSG);
    return;
  }

  try {
    const result = await askAssistant(provider, parsed.data.question, {
      boardId: parsed.data.boardId,
      sprintId: parsed.data.sprintId,
      today: new Date().toISOString().slice(0, 10),
      history: parsed.data.history,
    });
    res.json({ ok: true, data: result });
  } catch (err) {
    if (err instanceof UpstreamError) {
      errorResponse(res, 502, "UPSTREAM", err.message);
      return;
    }
    if (err instanceof ConfigError) {
      errorResponse(res, 500, "CONFIG", err.message);
      return;
    }
    const msg = err instanceof Error ? err.message : "Internal server error";
    errorResponse(res, 500, "INTERNAL", msg);
  }
});

// POST /api/ai/ask/stream (v1.71, §4.9, ADR-082) — SSE streaming variant of /api/ai/ask.
// Pre-flush failures (validation / config / AI_UNAVAILABLE) use the JSON envelope + status, exactly
// like /api/ai/ask, so the client can fall back. Once headers are flushed, failures are `error` frames.
app.post("/api/ai/ask/stream", async (req, res) => {
  const parsed = askInputSchema.safeParse(req.body);
  if (!parsed.success) {
    errorResponse(res, 400, "VALIDATION", "Input validation failed", parsed.error.issues);
    return;
  }

  let provider;
  try {
    provider = await getAiProvider();
  } catch (err) {
    if (err instanceof ConfigError) {
      errorResponse(res, 500, "CONFIG", err.message);
      return;
    }
    const msg = err instanceof Error ? err.message : "Internal server error";
    errorResponse(res, 500, "INTERNAL", msg);
    return;
  }

  if (provider === null) {
    errorResponse(res, 503, "AI_UNAVAILABLE", AI_UNAVAILABLE_MSG);
    return;
  }

  // Open the SSE stream — headers flush here, so any later error becomes an `error` frame.
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // disable proxy buffering (nginx) so frames arrive promptly
  });

  let closed = false;
  req.on("close", () => {
    closed = true;
  });

  // Each event is an SSE frame; the client keys off the event NAME. Sending the whole event object
  // as data is a harmless superset of the documented per-event shapes.
  const send = (event: string, data: unknown) => {
    if (closed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    await askAssistantStream(
      provider,
      parsed.data.question,
      {
        boardId: parsed.data.boardId,
        sprintId: parsed.data.sprintId,
        today: new Date().toISOString().slice(0, 10),
        history: parsed.data.history,
      },
      (e) => send(e.type, e)
    );
  } catch (err) {
    const [code, message] =
      err instanceof UpstreamError
        ? (["UPSTREAM", err.message] as const)
        : err instanceof ConfigError
          ? (["CONFIG", err.message] as const)
          : (["INTERNAL", err instanceof Error ? err.message : "Internal server error"] as const);
    send("error", { code, message });
  } finally {
    if (!closed) res.end();
  }
});

// ---- Start server (only when run directly, not when imported for tests) ----

// This block only runs when the file is executed as a script, not when imported.
// We detect this by checking whether import.meta.url matches the main module.
// In practice, tsx/node will set process.argv[1] to the file path.
// We use a sentinel env var (VITEST=true) to skip the listen call during tests.
if (process.env["VITEST"] !== "true") {
  // Validate config at startup — fail fast with clear error
  let port: number;
  try {
    const cfg = getConfig();
    port = cfg.MCP_JIRA_HTTP_PORT;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[mcp-jira] Config error at startup: ${msg}\n`);
    process.exit(1);
  }

  app.listen(port, () => {
    process.stdout.write(
      `mcp-jira HTTP bridge listening on http://localhost:${port}\n`
    );
  });
}
