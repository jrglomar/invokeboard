// aiClient tests — keyless/offline (mocks fetch globally)
// CONTRACTS.md §4.9 v1.1, §7
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getAiStatus, aiDraftTickets, aiEnhanceTicket, aiDraftPoStory } from "./aiClient";
import type { McpError } from "./mcpClient";

// Mock fetch globally
const mockFetch = vi.fn<typeof fetch>();
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Helper: build a Response-like object */
function makeResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

// ── getAiStatus ───────────────────────────────────────────────────────────────
// v1.53 (ADR-064): reads the PER-USER GET /api/me/context .ai (envelope { ok, data }), not the global
// GET /api/health. So a user on their own AI token is reported enabled. Any failure → disabled.

/** A /api/me/context envelope carrying the given .ai (plus the other required context fields). */
function ctxWithAi(ai: unknown): Response {
  return makeResponse({ ok: true, data: { connections: {}, ready: true, boards: { dev: [], po: [] }, role: "user", ai } });
}

describe("getAiStatus", () => {
  it("returns enabled status when the user's context .ai is enabled", async () => {
    mockFetch.mockResolvedValueOnce(ctxWithAi({ enabled: true, provider: "anthropic", model: "claude-opus-4-8" }));
    const status = await getAiStatus();
    expect(status.enabled).toBe(true);
    expect(status.provider).toBe("anthropic");
    expect(status.model).toBe("claude-opus-4-8");
  });

  it("returns disabled when the ai field is absent from the context", async () => {
    mockFetch.mockResolvedValueOnce(ctxWithAi(undefined));
    const status = await getAiStatus();
    expect(status.enabled).toBe(false);
    expect(status.provider).toBeNull();
    expect(status.model).toBeNull();
  });

  it("returns disabled when ai.enabled is false", async () => {
    mockFetch.mockResolvedValueOnce(ctxWithAi({ enabled: false, provider: null, model: null }));
    const status = await getAiStatus();
    expect(status.enabled).toBe(false);
  });

  it("returns disabled when fetch fails (BRIDGE_DOWN) — must NOT throw", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network failure"));
    const status = await getAiStatus();
    expect(status.enabled).toBe(false);
    expect(status.provider).toBeNull();
    expect(status.model).toBeNull();
  });

  it("returns disabled when not signed in (error envelope) — must NOT throw", async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({ ok: false, error: { code: "UNAUTHENTICATED", message: "no session" } }, 401));
    const status = await getAiStatus();
    expect(status.enabled).toBe(false);
  });

  it("returns disabled when the context response is not valid JSON", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => { throw new Error("not json"); },
    } as unknown as Response);
    const status = await getAiStatus();
    expect(status.enabled).toBe(false);
  });
});

// ── aiDraftTickets ────────────────────────────────────────────────────────────

describe("aiDraftTickets", () => {
  it("unwraps { ok: true, data } envelope and returns DraftResponse", async () => {
    const draftRes = {
      assistantMessage: "Here are your drafts",
      po: { summary: "PO summary", description: "PO desc", storyPoints: 5 },
      dev: { summary: "Dev summary", description: "Dev desc" },
      provider: "anthropic" as const,
      model: "claude-opus-4-8",
    };
    mockFetch.mockResolvedValueOnce(makeResponse({ ok: true, data: draftRes }));

    const result = await aiDraftTickets({ messages: [{ role: "user", content: "Add dark mode" }] });
    expect(result).toEqual(draftRes);
  });

  it("throws McpError with code AI_UNAVAILABLE when ok: false and code AI_UNAVAILABLE", async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse(
        { ok: false, error: { code: "AI_UNAVAILABLE", message: "AI drafting is disabled — set AI_PROVIDER=anthropic or github and the matching key (see docs/SETUP.md)" } },
        503
      )
    );

    let thrown: McpError | null = null;
    try {
      await aiDraftTickets({ messages: [{ role: "user", content: "test" }] });
    } catch (e) {
      thrown = e as McpError;
    }
    expect(thrown).not.toBeNull();
    expect(thrown?.code).toBe("AI_UNAVAILABLE");
  });

  it("throws McpError with BRIDGE_DOWN when fetch rejects", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network failure"));

    let thrown: McpError | null = null;
    try {
      await aiDraftTickets({ messages: [{ role: "user", content: "test" }] });
    } catch (e) {
      thrown = e as McpError;
    }
    expect(thrown?.code).toBe("BRIDGE_DOWN");
  });

  it("POSTs to /api/ai/draft-tickets", async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({ ok: true, data: {
      assistantMessage: "ok",
      po: { summary: "s", description: "d", storyPoints: null },
      dev: { summary: "s", description: "d" },
      provider: "github",
      model: "openai/gpt-4o-mini",
    } }));

    const body = { messages: [{ role: "user" as const, content: "feat" }], storyPoints: 3 };
    await aiDraftTickets(body);

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("/api/ai/draft-tickets");
    const init = mockFetch.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual(body);
  });

  it("throws McpError on UPSTREAM (502) error from AI provider", async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse(
        { ok: false, error: { code: "UPSTREAM", message: "Anthropic rate limit reached" } },
        502
      )
    );

    let thrown: McpError | null = null;
    try {
      await aiDraftTickets({ messages: [{ role: "user", content: "test" }] });
    } catch (e) {
      thrown = e as McpError;
    }
    expect(thrown?.code).toBe("UPSTREAM");
  });
});

// ── aiEnhanceTicket ───────────────────────────────────────────────────────────

describe("aiEnhanceTicket", () => {
  it("unwraps { ok: true, data } envelope and returns EnhanceResponse", async () => {
    const enhanceRes = {
      assistantMessage: "Ticket enhanced",
      summary: "Enhanced summary",
      description: "Enhanced description",
      provider: "github" as const,
      model: "openai/gpt-4o-mini",
    };
    mockFetch.mockResolvedValueOnce(makeResponse({ ok: true, data: enhanceRes }));

    const result = await aiEnhanceTicket({
      ticketKey: "DEV-42",
      notes: "add Given/When/Then",
      current: { summary: "Old summary", description: "Old desc" },
    });
    expect(result).toEqual(enhanceRes);
  });

  it("throws McpError with code AI_UNAVAILABLE on 503", async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse(
        { ok: false, error: { code: "AI_UNAVAILABLE", message: "AI drafting is disabled" } },
        503
      )
    );

    let thrown: McpError | null = null;
    try {
      await aiEnhanceTicket({
        ticketKey: "DEV-1",
        current: { summary: "s", description: "d" },
      });
    } catch (e) {
      thrown = e as McpError;
    }
    expect(thrown?.code).toBe("AI_UNAVAILABLE");
  });

  it("throws McpError with BRIDGE_DOWN when fetch rejects", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network failure"));

    let thrown: McpError | null = null;
    try {
      await aiEnhanceTicket({ ticketKey: "DEV-1", current: { summary: "s", description: "d" } });
    } catch (e) {
      thrown = e as McpError;
    }
    expect(thrown?.code).toBe("BRIDGE_DOWN");
  });

  it("POSTs to /api/ai/enhance-ticket", async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({ ok: true, data: {
      assistantMessage: "done",
      summary: "s",
      description: "d",
      provider: "anthropic",
      model: "claude-opus-4-8",
    } }));

    const body = {
      ticketKey: "DEV-10",
      notes: "my notes",
      current: { summary: "old", description: "old desc" },
    };
    await aiEnhanceTicket(body);

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("/api/ai/enhance-ticket");
    const init = mockFetch.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual(body);
  });
});

// ── aiDraftPoStory (v1.72, ADR-083) ────────────────────────────────────────────

describe("aiDraftPoStory", () => {
  it("POSTs to /api/ai/draft-po-story and unwraps { ok: true, data }", async () => {
    const draftRes = {
      assistantMessage: "Rolled up 2 Dev tasks",
      summary: "Password reset",
      description: "## User Story\n\n...",
      provider: "anthropic" as const,
      model: "claude-opus-4-8",
    };
    mockFetch.mockResolvedValueOnce(makeResponse({ ok: true, data: draftRes }));

    const body = {
      devTickets: [
        { key: "DEV-1", summary: "Add reset endpoint" },
        { key: "DEV-2", summary: "Add reset email", description: "uses SES" },
      ],
    };
    const result = await aiDraftPoStory(body);

    expect(result).toEqual(draftRes);
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("/api/ai/draft-po-story");
    const init = mockFetch.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual(body);
  });
});
