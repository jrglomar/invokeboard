// AI drafting client for mcp-jira bridge AI endpoints — CONTRACTS.md §4.9 v1.1
// Same envelope/unwrap/error semantics as mcpClient (incl. BRIDGE_DOWN).
// AI_UNAVAILABLE (503) throws McpError with code "AI_UNAVAILABLE" so callers
// can branch to the deterministic fallback.

import { type McpError } from "./mcpClient";
import { getMyContext } from "./connectionsClient";
import type {
  AiStatus,
  DraftRequest,
  DraftResponse,
  EnhanceRequest,
  EnhanceResponse,
  SprintSummaryRequest,
  SprintSummaryResponse,
  PlanDevTicketsRequest,
  PlanDevTicketsResponse,
  DraftPoStoryRequest,
  DraftPoStoryResponse,
  AskRequest,
  AskResponse,
  AskCard,
  AskStreamEvent,
} from "./types";

/** HTTP bridge base URL — same as mcpClient jira base */
const JIRA_BASE =
  (import.meta.env.VITE_MCP_JIRA_URL as string | undefined) ??
  "http://localhost:4001";

/** Bridge-down error message, consistent with mcpClient */
function bridgeDownError(): McpError {
  return {
    code: "BRIDGE_DOWN",
    message: "Cannot reach jira bridge — run: npm run dev:jira:http",
  };
}

/**
 * Generic POST to a mcp-jira AI endpoint.
 * Unwraps the { ok, data } envelope.
 * Throws McpError on network failure (BRIDGE_DOWN) or ok: false.
 */
async function postAi<T>(path: string, body: unknown): Promise<T> {
  const url = `${JIRA_BASE}${path}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include", // v1.45 (ADR-055): run AI on the signed-in user's own token
      body: JSON.stringify(body),
    });
  } catch {
    // Network failure — bridge not running
    throw bridgeDownError();
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    const err: McpError = {
      code: "INTERNAL",
      message: `Bridge returned non-JSON response (status ${response.status})`,
    };
    throw err;
  }

  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "ok" in parsed
  ) {
    const envelope = parsed as {
      ok: boolean;
      data?: T;
      error?: { code: string; message: string; issues?: unknown[] };
    };

    if (envelope.ok && "data" in envelope) {
      return envelope.data as T;
    }

    if (envelope.error) {
      const err: McpError = {
        code: envelope.error.code,
        message: envelope.error.message,
        issues: envelope.error.issues,
      };
      throw err;
    }
  }

  const err: McpError = {
    code: "INTERNAL",
    message: "Unexpected response shape from AI endpoint",
  };
  throw err;
}

/**
 * The signed-in user's EFFECTIVE AI status, from GET /api/me/context → .ai (v1.53, ADR-064).
 * Per-user: a user on their OWN AI token — with no global .env AI — is correctly reported enabled,
 * fixing the old bug where this read the global, unauthenticated GET /api/health .ai and showed
 * "AI disabled" for them. Any failure (not signed in, bridge down, missing field) → disabled, so
 * the page never crashes.
 *
 * CONTRACTS.md §9.5
 */
export async function getAiStatus(): Promise<AiStatus> {
  try {
    const ai = (await getMyContext()).ai;
    if (!ai || typeof ai.enabled !== "boolean") {
      return { enabled: false, provider: null, model: null };
    }
    return { enabled: ai.enabled, provider: ai.provider ?? null, model: ai.model ?? null };
  } catch {
    // Not signed in, bridge down, or malformed → disabled (safe default)
    return { enabled: false, provider: null, model: null };
  }
}

/**
 * POST /api/ai/draft-tickets — AI-powered ticket pair drafting.
 * Throws McpError. AI_UNAVAILABLE (503) throws McpError{ code: "AI_UNAVAILABLE" }.
 *
 * CONTRACTS.md §4.9
 */
export async function aiDraftTickets(body: DraftRequest): Promise<DraftResponse> {
  return postAi<DraftResponse>("/api/ai/draft-tickets", body);
}

/**
 * POST /api/ai/enhance-ticket — AI-powered ticket enhancement.
 * Throws McpError. AI_UNAVAILABLE (503) throws McpError{ code: "AI_UNAVAILABLE" }.
 *
 * CONTRACTS.md §4.9
 */
export async function aiEnhanceTicket(body: EnhanceRequest): Promise<EnhanceResponse> {
  return postAi<EnhanceResponse>("/api/ai/enhance-ticket", body);
}

/**
 * POST /api/ai/sprint-summary — AI executive summary of a sprint report.
 * Throws McpError. AI_UNAVAILABLE (503) throws McpError{ code: "AI_UNAVAILABLE" }.
 * AI errors must NOT break the data report — callers handle them gracefully.
 *
 * CONTRACTS.md §4.9 v1.4, ADR-012
 */
export async function aiSprintSummary(
  body: SprintSummaryRequest
): Promise<SprintSummaryResponse> {
  return postAi<SprintSummaryResponse>("/api/ai/sprint-summary", body);
}

/**
 * POST /api/ai/plan-dev-tickets — bulk plan: one Dev draft per PO story (v1.11, ADR-022).
 * Throws McpError. AI_UNAVAILABLE (503) throws McpError{ code: "AI_UNAVAILABLE" } so the
 * Linking page can fall back to deterministic templates.
 */
export async function aiPlanDevTickets(
  body: PlanDevTicketsRequest
): Promise<PlanDevTicketsResponse> {
  return postAi<PlanDevTicketsResponse>("/api/ai/plan-dev-tickets", body);
}

/**
 * POST /api/ai/draft-po-story — roll N existing Dev tasks up into ONE PO story draft
 * (v1.72, ADR-083). Throws McpError. AI_UNAVAILABLE (503) throws
 * McpError{ code: "AI_UNAVAILABLE" } so the Linking page's "New PO from Dev tasks"
 * mode can fall back to the deterministic `lib/poRollup.ts` rollup.
 */
export async function aiDraftPoStory(
  body: DraftPoStoryRequest
): Promise<DraftPoStoryResponse> {
  return postAi<DraftPoStoryResponse>("/api/ai/draft-po-story", body);
}

/**
 * POST /api/ai/ask — in-app AI Q&A assistant (v1.18, ADR-029).
 * Free-form question answered by an agentic loop over read-only tools.
 * Throws McpError. AI_UNAVAILABLE (503) throws McpError{ code: "AI_UNAVAILABLE" }.
 */
export async function aiAsk(body: AskRequest): Promise<AskResponse> {
  return postAi<AskResponse>("/api/ai/ask", body);
}

/** Handlers for the streaming Ask endpoint (v1.71, ADR-082) — all optional. */
export interface AskStreamHandlers {
  /** A read-tool batch is about to run (drives the live "Looking at…" indicator). */
  onStep?: (tools: string[]) => void;
  /** A chunk of the streamed answer — append in order. */
  onDelta?: (text: string) => void;
  /** Rich cards captured so far (≤3). */
  onCards?: (cards: AskCard[]) => void;
}

/**
 * Parse one SSE frame ("event: <name>\n data: <json>") into a typed event. The bridge sends the whole
 * event object as data; we trust the SSE event NAME for the discriminant. Returns null for frames
 * with no/invalid data (e.g. comments/keep-alives).
 */
function parseSseFrame(frame: string): AskStreamEvent | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
  }
  if (dataLines.length === 0) return null;
  try {
    const data = JSON.parse(dataLines.join("\n")) as Record<string, unknown>;
    return { ...data, type: event } as AskStreamEvent;
  } catch {
    return null;
  }
}

/**
 * POST /api/ai/ask/stream — streaming AI Q&A assistant (v1.71, ADR-082).
 * Consumes the SSE stream, forwarding progress to `handlers`, and resolves to the final AskResponse
 * (from the `done` or `proposed` event). Pre-flush failures arrive as a JSON error envelope and throw
 * the same McpError shape as {@link aiAsk} (incl. AI_UNAVAILABLE / BRIDGE_DOWN), so callers can fall
 * back to the non-streaming endpoint. An `error` event mid-stream also throws.
 */
export async function aiAskStream(
  body: AskRequest,
  handlers: AskStreamHandlers = {}
): Promise<AskResponse> {
  const url = `${JIRA_BASE}/api/ai/ask/stream`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      credentials: "include",
      body: JSON.stringify(body),
    });
  } catch {
    throw bridgeDownError();
  }

  const contentType = response.headers.get("content-type") ?? "";

  // Pre-flush failure (validation / config / AI_UNAVAILABLE) → JSON error envelope, like postAi.
  if (!response.ok || contentType.includes("application/json")) {
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      const err: McpError = {
        code: "INTERNAL",
        message: `Bridge returned non-JSON error (status ${response.status})`,
      };
      throw err;
    }
    if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
      const e = (parsed as { error: { code: string; message: string; issues?: unknown[] } }).error;
      const err: McpError = { code: e.code, message: e.message, issues: e.issues };
      throw err;
    }
    const err: McpError = { code: "INTERNAL", message: "Unexpected error from AI stream endpoint" };
    throw err;
  }

  if (!response.body) {
    const err: McpError = { code: "INTERNAL", message: "AI stream endpoint returned no body" };
    throw err;
  }

  let result: AskResponse | null = null;
  const handle = (ev: AskStreamEvent): void => {
    switch (ev.type) {
      case "step":
        handlers.onStep?.(ev.tools);
        break;
      case "delta":
        handlers.onDelta?.(ev.text);
        break;
      case "cards":
        handlers.onCards?.(ev.cards);
        break;
      case "proposed":
        result = {
          answer: ev.answer,
          toolsUsed: ev.toolsUsed,
          provider: ev.provider,
          model: ev.model,
          proposedAction: ev.proposedAction,
        };
        break;
      case "done":
        result = {
          answer: ev.answer,
          toolsUsed: ev.toolsUsed,
          provider: ev.provider,
          model: ev.model,
          ...(ev.cards ? { cards: ev.cards } : {}),
        };
        break;
      case "error": {
        const err: McpError = { code: ev.code, message: ev.message };
        throw err;
      }
    }
  };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const ev = parseSseFrame(frame);
        if (ev) handle(ev);
      }
      if (done) break;
    }
    const tail = buffer.trim();
    if (tail) {
      const ev = parseSseFrame(tail);
      if (ev) handle(ev);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }

  if (result) return result;
  const err: McpError = { code: "INTERNAL", message: "AI stream ended without a final answer" };
  throw err;
}
