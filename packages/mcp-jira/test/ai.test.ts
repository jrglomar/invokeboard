/**
 * AI module and HTTP bridge tests for §4.9 endpoints.
 *
 * All tests run keyless and offline:
 * - @anthropic-ai/sdk is mocked via vi.mock
 * - global fetch is stubbed with vi.stubGlobal
 *
 * Tests cover:
 * - 503 AI_UNAVAILABLE when AI_PROVIDER is unset/empty
 * - 500 CONFIG when AI_PROVIDER=anthropic but ANTHROPIC_API_KEY is missing
 * - Anthropic happy path (mocked messages.parse → parsed_output) for both endpoints
 * - GitHub happy path (mocked fetch) + retry-on-bad-JSON + second-failure UpstreamError + 401
 * - 400 VALIDATION (empty messages, last-role-not-user)
 * - GET /api/health has ai shape for both enabled and disabled
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  type Mock,
} from "vitest";
import type { Server } from "http";
import { resetConfigCache } from "../src/lib/config.js";

// ---- Mock @anthropic-ai/sdk before anything imports it ----
vi.mock("@anthropic-ai/sdk", () => {
  const mockParse = vi.fn();

  class MockAuthenticationError extends Error {
    constructor() {
      super("Invalid API key");
      this.name = "AuthenticationError";
    }
  }
  class MockRateLimitError extends Error {
    constructor() {
      super("Rate limit exceeded");
      this.name = "RateLimitError";
    }
  }
  class MockAPIError extends Error {
    status: number;
    constructor(status: number, msg: string) {
      super(msg);
      this.name = "APIError";
      this.status = status;
    }
  }

  const mockMessages = { parse: mockParse };
  const MockAnthropic = vi.fn().mockImplementation(() => ({
    messages: mockMessages,
  }));

  // Expose error classes as static properties on the constructor
  (MockAnthropic as unknown as Record<string, unknown>)["AuthenticationError"] =
    MockAuthenticationError;
  (MockAnthropic as unknown as Record<string, unknown>)["RateLimitError"] =
    MockRateLimitError;
  (MockAnthropic as unknown as Record<string, unknown>)["APIError"] =
    MockAPIError;

  return { default: MockAnthropic };
});

// zodOutputFormat helper — must resolve without errors
vi.mock("@anthropic-ai/sdk/helpers/zod", () => ({
  zodOutputFormat: vi.fn().mockReturnValue({ type: "json_schema" }),
}));

// ---- Mock jiraClient (not used by AI endpoints, but http.ts imports tools) ----
vi.mock("../src/lib/jiraClient.js", () => ({
  createIssue: vi.fn(),
  createIssueLink: vi.fn(),
  addIssuesToSprint: vi.fn(),
  getActiveSprints: vi.fn(),
  getActiveAndFutureSprints: vi.fn(),
  getSprintIssues: vi.fn(),
  getSprintsByState: vi.fn(),
  getSprintMeta: vi.fn(),
  createSprint: vi.fn(),
  getIssue: vi.fn(),
  updateIssue: vi.fn(),
  isBlocked: vi.fn(),
  mapIssue: vi.fn(),
  resetClientCache: vi.fn(),
}));

// Set env before importing the app
process.env["JIRA_BASE_URL"] = "https://test.atlassian.net";
process.env["JIRA_EMAIL"] = "test@example.com";
process.env["JIRA_API_TOKEN"] = "test-token";
process.env["JIRA_PO_BOARD_ID"] = "10001";
process.env["JIRA_DEV_BOARD_ID"] = "10002";
process.env["VITEST"] = "true";

resetConfigCache();

import { app } from "../src/http.js";
import Anthropic from "@anthropic-ai/sdk";

const MockAnthropicClass = Anthropic as unknown as Mock;

let server: Server;
let baseUrl: string;

beforeAll(
  () =>
    new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        const port =
          addr !== null && typeof addr === "object" ? addr.port : 0;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    })
);

afterAll(
  () =>
    new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    })
);

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  resetConfigCache();
  // Reset AI env vars
  delete process.env["AI_PROVIDER"];
  delete process.env["ANTHROPIC_API_KEY"];
  delete process.env["ANTHROPIC_MODEL"];
  delete process.env["GITHUB_MODELS_TOKEN"];
  delete process.env["GITHUB_MODELS_MODEL"];
  delete process.env["GITHUB_MODELS_BASE_URL"];
  // Restore required vars
  process.env["JIRA_BASE_URL"] = "https://test.atlassian.net";
  process.env["JIRA_EMAIL"] = "test@example.com";
  process.env["JIRA_API_TOKEN"] = "test-token";
  process.env["JIRA_PO_BOARD_ID"] = "10001";
  process.env["JIRA_DEV_BOARD_ID"] = "10002";
  process.env["VITEST"] = "true";
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
  resetConfigCache();
  vi.unstubAllGlobals();
});

// ---- Helpers ----

async function post(path: string, body: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function get(path: string) {
  return fetch(`${baseUrl}${path}`);
}

const validDraftBody = {
  messages: [{ role: "user", content: "Build a login feature" }],
};

const validEnhanceBody = {
  ticketKey: "PO-42",
  current: { summary: "Login page", description: "Users need to log in" },
};

// ---- Health endpoint: ai field ----

describe("GET /api/health — ai field", () => {
  it("reports enabled:false when AI_PROVIDER is not set", async () => {
    const res = await get("/api/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ai: { enabled: boolean; provider: unknown; model: unknown };
    };
    expect(body.ai.enabled).toBe(false);
    expect(body.ai.provider).toBeNull();
    expect(body.ai.model).toBeNull();
  });

  it("reports enabled:true with provider and model when AI_PROVIDER=anthropic", async () => {
    resetConfigCache();
    process.env["AI_PROVIDER"] = "anthropic";
    process.env["ANTHROPIC_MODEL"] = "claude-opus-4-8";
    resetConfigCache();

    const res = await get("/api/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ai: { enabled: boolean; provider: string; model: string };
    };
    expect(body.ai.enabled).toBe(true);
    expect(body.ai.provider).toBe("anthropic");
    expect(body.ai.model).toBe("claude-opus-4-8");
  });

  it("reports enabled:true with github provider when AI_PROVIDER=github", async () => {
    process.env["AI_PROVIDER"] = "github";
    process.env["GITHUB_MODELS_MODEL"] = "openai/gpt-4o-mini";
    resetConfigCache();

    const res = await get("/api/health");
    const body = (await res.json()) as {
      ai: { enabled: boolean; provider: string; model: string };
    };
    expect(body.ai.enabled).toBe(true);
    expect(body.ai.provider).toBe("github");
    expect(body.ai.model).toBe("openai/gpt-4o-mini");
  });
});

// ---- 503 AI_UNAVAILABLE ----

describe("POST /api/ai/draft-tickets — 503 AI_UNAVAILABLE", () => {
  it("returns 503 when AI_PROVIDER is not set", async () => {
    const res = await post("/api/ai/draft-tickets", validDraftBody);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; error: { code: string; message: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("AI_UNAVAILABLE");
    expect(body.error.message).toMatch(/AI_PROVIDER/);
  });

  it("returns 503 when AI_PROVIDER is empty string", async () => {
    process.env["AI_PROVIDER"] = "";
    resetConfigCache();

    const res = await post("/api/ai/draft-tickets", validDraftBody);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("AI_UNAVAILABLE");
  });
});

describe("POST /api/ai/enhance-ticket — 503 AI_UNAVAILABLE", () => {
  it("returns 503 when AI_PROVIDER is not set", async () => {
    const res = await post("/api/ai/enhance-ticket", validEnhanceBody);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("AI_UNAVAILABLE");
  });
});

// ---- 500 CONFIG — key missing ----

describe("POST /api/ai/draft-tickets — 500 CONFIG", () => {
  it("returns 500 CONFIG when AI_PROVIDER=anthropic but ANTHROPIC_API_KEY is missing", async () => {
    process.env["AI_PROVIDER"] = "anthropic";
    // ANTHROPIC_API_KEY not set
    resetConfigCache();

    const res = await post("/api/ai/draft-tickets", validDraftBody);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: boolean; error: { code: string; message: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("CONFIG");
    expect(body.error.message).toContain("ANTHROPIC_API_KEY");
  });

  it("returns 500 CONFIG when AI_PROVIDER=github but no token available", async () => {
    process.env["AI_PROVIDER"] = "github";
    delete process.env["GITHUB_MODELS_TOKEN"];
    delete process.env["GITHUB_TOKEN"];
    resetConfigCache();

    const res = await post("/api/ai/draft-tickets", validDraftBody);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CONFIG");
  });
});

// ---- 400 VALIDATION ----

describe("POST /api/ai/draft-tickets — 400 VALIDATION", () => {
  it("returns 400 when messages is empty array", async () => {
    process.env["AI_PROVIDER"] = "anthropic";
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    resetConfigCache();

    const res = await post("/api/ai/draft-tickets", { messages: [] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION");
  });

  it("returns 400 when last message role is not user", async () => {
    process.env["AI_PROVIDER"] = "anthropic";
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    resetConfigCache();

    const res = await post("/api/ai/draft-tickets", {
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "OK" },
      ],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION");
  });

  it("returns 400 when messages is missing", async () => {
    const res = await post("/api/ai/draft-tickets", {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION");
  });
});

describe("POST /api/ai/enhance-ticket — 400 VALIDATION", () => {
  it("returns 400 when ticketKey is invalid format", async () => {
    const res = await post("/api/ai/enhance-ticket", {
      ticketKey: "not-a-valid-key",
      current: { summary: "x", description: "y" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION");
  });

  it("returns 400 when current is missing", async () => {
    const res = await post("/api/ai/enhance-ticket", { ticketKey: "PO-1" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION");
  });
});

// ---- Anthropic happy path ----

describe("POST /api/ai/draft-tickets — Anthropic happy path", () => {
  it("returns 200 with draft tickets output", async () => {
    process.env["AI_PROVIDER"] = "anthropic";
    process.env["ANTHROPIC_API_KEY"] = "test-key-anthropic";
    process.env["ANTHROPIC_MODEL"] = "claude-opus-4-8";
    resetConfigCache();

    const mockParsedOutput = {
      assistantMessage: "I've drafted your tickets.",
      po: {
        summary: "Allow users to log in",
        description: "## User Story\nAs a user...",
        storyPoints: 5,
      },
      dev: {
        summary: "Implement login endpoint",
        description: "## Overview\nBuild the auth...",
      },
    };

    // Set up mock BEFORE making the request
    // The Anthropic constructor is called inside getAiProvider() during the request
    MockAnthropicClass.mockImplementation(() => ({
      messages: {
        parse: vi.fn().mockResolvedValue({ parsed_output: mockParsedOutput }),
      },
    }));

    const res = await post("/api/ai/draft-tickets", validDraftBody);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      data: {
        assistantMessage: string;
        po: { summary: string; description: string; storyPoints: number | null };
        dev: { summary: string; description: string };
        provider: string;
        model: string;
      };
    };
    expect(body.ok).toBe(true);
    expect(body.data.assistantMessage).toBe("I've drafted your tickets.");
    expect(body.data.po.summary).toBe("Allow users to log in");
    expect(body.data.dev.summary).toBe("Implement login endpoint");
    expect(body.data.provider).toBe("anthropic");
    expect(body.data.model).toBe("claude-opus-4-8");
  });
});

describe("POST /api/ai/enhance-ticket — Anthropic happy path", () => {
  it("returns 200 with enhanced ticket output", async () => {
    process.env["AI_PROVIDER"] = "anthropic";
    process.env["ANTHROPIC_API_KEY"] = "test-key-anthropic";
    resetConfigCache();

    const mockParsedOutput = {
      assistantMessage: "I've enhanced your ticket.",
      summary: "Allow users to authenticate securely",
      description: "## Context\nUsers need to log in...",
    };

    MockAnthropicClass.mockImplementation(() => ({
      messages: {
        parse: vi.fn().mockResolvedValue({ parsed_output: mockParsedOutput }),
      },
    }));

    const res = await post("/api/ai/enhance-ticket", validEnhanceBody);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      data: {
        assistantMessage: string;
        summary: string;
        description: string;
        provider: string;
        model: string;
      };
    };
    expect(body.ok).toBe(true);
    expect(body.data.assistantMessage).toBe("I've enhanced your ticket.");
    expect(body.data.summary).toBe("Allow users to authenticate securely");
    expect(body.data.provider).toBe("anthropic");
  });
});

// ---- Anthropic error mapping ----

describe("Anthropic error mapping", () => {
  beforeEach(() => {
    process.env["AI_PROVIDER"] = "anthropic";
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    resetConfigCache();
  });

  it("maps AuthenticationError to 502 UPSTREAM", async () => {
    const { AuthenticationError } = Anthropic as unknown as {
      AuthenticationError: new () => Error;
    };

    MockAnthropicClass.mockImplementation(() => ({
      messages: {
        parse: vi.fn().mockRejectedValue(new AuthenticationError()),
      },
    }));

    const res = await post("/api/ai/draft-tickets", validDraftBody);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("UPSTREAM");
    expect(body.error.message).toContain("ANTHROPIC_API_KEY");
  });

  it("maps RateLimitError to 502 UPSTREAM", async () => {
    const { RateLimitError } = Anthropic as unknown as {
      RateLimitError: new () => Error;
    };

    MockAnthropicClass.mockImplementation(() => ({
      messages: {
        parse: vi.fn().mockRejectedValue(new RateLimitError()),
      },
    }));

    const res = await post("/api/ai/draft-tickets", validDraftBody);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("UPSTREAM");
    expect(body.error.message).toContain("rate limit");
  });
});

// ---- GitHub happy path ----

// ---- GitHub tests: wrap global fetch so localhost calls pass through ----
// When vi.stubGlobal("fetch", mock) is active, test HTTP calls to the Express
// server also go through the mock.  We route localhost URLs to the real fetch
// and GitHub Models URLs to the controlled mock responses.

type FetchFn = typeof globalThis.fetch;
const realFetch: FetchFn = globalThis.fetch.bind(globalThis);

function makeGithubFetchStub(
  githubResponses: Array<() => Response>
): Mock {
  let ghCallIndex = 0;
  return vi.fn((url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    if (urlStr.startsWith("http://127.0.0.1")) {
      // Pass through to the real Express server
      return realFetch(url, init);
    }
    // GitHub Models outbound call
    const handler = githubResponses[ghCallIndex++];
    if (!handler) return Promise.reject(new Error("No more mock responses"));
    return Promise.resolve(handler());
  });
}

function makeGithubContent(obj: unknown): string {
  return JSON.stringify(obj);
}

function githubChoicesResponse(content: string, status = 200): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }] }),
    { status, headers: { "Content-Type": "application/json" } }
  );
}

describe("POST /api/ai/draft-tickets — GitHub happy path", () => {
  it("returns 200 with draft tickets from GitHub Models", async () => {
    process.env["AI_PROVIDER"] = "github";
    process.env["GITHUB_TOKEN"] = "gh-test-token";
    process.env["GITHUB_MODELS_BASE_URL"] = "https://models.github.ai/inference";
    process.env["GITHUB_MODELS_MODEL"] = "openai/gpt-4o-mini";
    resetConfigCache();

    const mockDraftOutput = makeGithubContent({
      assistantMessage: "Here are your draft tickets.",
      po: {
        summary: "Build login page",
        description: "## User Story\nAs a user...",
        storyPoints: 3,
      },
      dev: {
        summary: "Implement auth backend",
        description: "## Overview\nBuild JWT auth...",
      },
    });

    const stub = makeGithubFetchStub([
      () => githubChoicesResponse(mockDraftOutput),
    ]);
    vi.stubGlobal("fetch", stub);

    const res = await post("/api/ai/draft-tickets", validDraftBody);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      data: { provider: string; po: { summary: string } };
    };
    expect(body.ok).toBe(true);
    expect(body.data.provider).toBe("github");
    expect(body.data.po.summary).toBe("Build login page");
  });
});

describe("GitHub JSON-retry path", () => {
  it("retries with re-ask message on bad JSON and succeeds second try", async () => {
    process.env["AI_PROVIDER"] = "github";
    process.env["GITHUB_TOKEN"] = "gh-test-token";
    resetConfigCache();

    const goodOutput = makeGithubContent({
      assistantMessage: "Retried successfully.",
      po: { summary: "Login", description: "## Overview\nLogin...", storyPoints: null },
      dev: { summary: "Auth", description: "## Overview\nAuth..." },
    });

    let ghCallCount = 0;
    const fetchMock = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : (url as Request).url;
      if (urlStr.startsWith("http://127.0.0.1")) {
        return realFetch(url, init);
      }
      ghCallCount++;
      if (ghCallCount === 1) {
        return Promise.resolve(githubChoicesResponse("not valid json {{{"));
      }
      return Promise.resolve(githubChoicesResponse(goodOutput));
    });

    vi.stubGlobal("fetch", fetchMock);

    const res = await post("/api/ai/draft-tickets", validDraftBody);
    expect(res.status).toBe(200);
    expect(ghCallCount).toBe(2);
    const body = (await res.json()) as { ok: boolean; data: { assistantMessage: string } };
    expect(body.ok).toBe(true);
    expect(body.data.assistantMessage).toBe("Retried successfully.");
  });

  it("returns 502 UPSTREAM when both attempts produce unparseable JSON", async () => {
    process.env["AI_PROVIDER"] = "github";
    process.env["GITHUB_TOKEN"] = "gh-test-token";
    resetConfigCache();

    const stub = makeGithubFetchStub([
      () => githubChoicesResponse("bad json {{{"),
      () => githubChoicesResponse("still bad json {{{"),
    ]);
    vi.stubGlobal("fetch", stub);

    const res = await post("/api/ai/draft-tickets", validDraftBody);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("UPSTREAM");
    expect(body.error.message).toContain("unparseable");
  });
});

describe("GitHub 401 error mapping", () => {
  it("maps 401 to 502 UPSTREAM with auth message", async () => {
    process.env["AI_PROVIDER"] = "github";
    process.env["GITHUB_TOKEN"] = "bad-token";
    resetConfigCache();

    const stub = makeGithubFetchStub([
      () => new Response(JSON.stringify({ message: "Bad credentials" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    ]);
    vi.stubGlobal("fetch", stub);

    const res = await post("/api/ai/draft-tickets", validDraftBody);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("UPSTREAM");
    // v1.44.2: surface GitHub's ACTUAL reason (not a misleading "models:read" hint).
    expect(body.error.message).toContain("rejected the token");
    expect(body.error.message).toContain("Bad credentials"); // the real detail from GitHub
    expect(body.error.message).toContain("GITHUB_MODELS_TOKEN");
  });
});

// ---- AI endpoints not in tool registry ----

describe("AI endpoints not in GET /api/tools", () => {
  it("GET /api/tools does not include draft-tickets or enhance-ticket", async () => {
    const res = await fetch(`${baseUrl}/api/tools`);
    const body = (await res.json()) as { data: { name: string }[] };
    const names = body.data.map((t) => t.name);
    expect(names).not.toContain("draft-tickets");
    expect(names).not.toContain("enhance-ticket");
    expect(names).not.toContain("ai/draft-tickets");
    expect(names).not.toContain("ai/enhance-ticket");
    // v1.11: plan-dev-tickets is bridge-only too
    expect(names).not.toContain("plan-dev-tickets");
  });

  // v1.72 (ADR-083): draft-po-story is bridge-only REST, never an MCP tool (circular for Copilot).
  it("GET /api/tools does not include draft-po-story", async () => {
    const res = await fetch(`${baseUrl}/api/tools`);
    const body = (await res.json()) as { data: { name: string }[] };
    const names = body.data.map((t) => t.name);
    expect(names).not.toContain("draft-po-story");
    expect(names).not.toContain("ai/draft-po-story");
  });
});

// ---- v1.11 (ADR-022): POST /api/ai/plan-dev-tickets ----

const validPlanBody = {
  poStories: [
    { key: "PO-1", summary: "Password reset via email" },
    { key: "PO-2", summary: "Profile avatar upload" },
  ],
};

describe("POST /api/ai/plan-dev-tickets", () => {
  it("returns 503 AI_UNAVAILABLE when AI_PROVIDER is unset", async () => {
    const res = await post("/api/ai/plan-dev-tickets", validPlanBody);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("AI_UNAVAILABLE");
  });

  it("returns 400 VALIDATION when poStories is empty", async () => {
    process.env["AI_PROVIDER"] = "anthropic";
    process.env["ANTHROPIC_API_KEY"] = "test-key-anthropic";
    resetConfigCache();
    const res = await post("/api/ai/plan-dev-tickets", { poStories: [] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION");
  });

  it("Anthropic happy path returns one Dev draft per PO (items)", async () => {
    process.env["AI_PROVIDER"] = "anthropic";
    process.env["ANTHROPIC_API_KEY"] = "test-key-anthropic";
    process.env["ANTHROPIC_MODEL"] = "claude-opus-4-8";
    resetConfigCache();

    const mockParsedOutput = {
      assistantMessage: "Planned 2 dev tasks.",
      items: [
        { poKey: "PO-1", devSummary: "Build reset endpoint", devDescription: "## Overview\n..." },
        { poKey: "PO-2", devSummary: "Add avatar upload", devDescription: "## Overview\n..." },
      ],
    };
    MockAnthropicClass.mockImplementation(() => ({
      messages: { parse: vi.fn().mockResolvedValue({ parsed_output: mockParsedOutput }) },
    }));

    const res = await post("/api/ai/plan-dev-tickets", validPlanBody);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      data: { assistantMessage: string; items: Array<{ poKey: string; devSummary: string }>; provider: string };
    };
    expect(body.ok).toBe(true);
    expect(body.data.items).toHaveLength(2);
    expect(body.data.items[0]!.poKey).toBe("PO-1");
    expect(body.data.items[1]!.devSummary).toBe("Add avatar upload");
    expect(body.data.provider).toBe("anthropic");
  });
});

// ---- v1.72 (ADR-083): POST /api/ai/draft-po-story ----

const validDraftPoStoryBody = {
  devTickets: [
    { key: "DEV-1", summary: "Build reset endpoint", storyPoints: 3 },
    { key: "DEV-2", summary: "Add reset email template", storyPoints: 2 },
  ],
};

describe("POST /api/ai/draft-po-story", () => {
  it("returns 503 AI_UNAVAILABLE when AI_PROVIDER is unset", async () => {
    const res = await post("/api/ai/draft-po-story", validDraftPoStoryBody);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("AI_UNAVAILABLE");
  });

  it("returns 400 VALIDATION on an empty body", async () => {
    process.env["AI_PROVIDER"] = "anthropic";
    process.env["ANTHROPIC_API_KEY"] = "test-key-anthropic";
    resetConfigCache();
    const res = await post("/api/ai/draft-po-story", {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION");
  });

  it("returns 400 VALIDATION when devTickets is empty", async () => {
    process.env["AI_PROVIDER"] = "anthropic";
    process.env["ANTHROPIC_API_KEY"] = "test-key-anthropic";
    resetConfigCache();
    const res = await post("/api/ai/draft-po-story", { devTickets: [] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION");
  });

  it("Anthropic happy path returns the rolled-up PO story draft", async () => {
    process.env["AI_PROVIDER"] = "anthropic";
    process.env["ANTHROPIC_API_KEY"] = "test-key-anthropic";
    process.env["ANTHROPIC_MODEL"] = "claude-opus-4-8";
    resetConfigCache();

    const mockParsedOutput = {
      assistantMessage: "Drafted one umbrella story covering both Dev tasks.",
      summary: "Allow users to reset a forgotten password",
      description: "## User Story\n...\n## Delivered by\n- DEV-1 — Build reset endpoint\n- DEV-2 — Add reset email template",
    };
    MockAnthropicClass.mockImplementation(() => ({
      messages: { parse: vi.fn().mockResolvedValue({ parsed_output: mockParsedOutput }) },
    }));

    const res = await post("/api/ai/draft-po-story", validDraftPoStoryBody);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      data: {
        assistantMessage: string;
        summary: string;
        description: string;
        provider: string;
        model: string;
      };
    };
    expect(body.ok).toBe(true);
    expect(body.data.assistantMessage).toBe("Drafted one umbrella story covering both Dev tasks.");
    expect(body.data.summary).toBe("Allow users to reset a forgotten password");
    expect(body.data.description).toContain("DEV-1");
    expect(body.data.provider).toBe("anthropic");
    expect(body.data.model).toBe("claude-opus-4-8");
  });
});
