// App.tsx tests — v1.7 (ADR-018)
// Verify the tab nav change: Dashboard · Planning · Reports.
// "Ticket Generator" tab is removed.
// Keyless/offline — all page components mocked.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import type { ReactNode } from "react";
import { App } from "./App";

// ── Mocks — stub all pages to avoid pulling in their full dependency trees ────

// v1.45 (ADR-055): bypass the app-wide login/connections gate so these nav tests exercise the
// shell directly (the gate itself is tested separately). The AuthProvider still mounts harmlessly.
vi.mock("./components/AppGate", () => ({
  AppGate: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("./pages/Dashboard", () => ({
  Dashboard: () => <div data-testid="page-dashboard">Dashboard</div>,
}));

vi.mock("./pages/Planning", () => ({
  Planning: () => <div data-testid="page-planning">Planning</div>,
}));

vi.mock("./pages/Reports", () => ({
  Reports: () => <div data-testid="page-reports">Reports</div>,
}));

vi.mock("./pages/Guide", () => ({
  Guide: () => <div data-testid="page-guide">Guide</div>,
}));

// v1.73 (ADR-084) — the team pill reads useAuth().team, which the real AuthProvider resolves from
// getMe() + getMyContext(). Mock the same way AppGate.test.tsx does, so the pill can be driven
// deterministically without a network call; the default (getMe rejects) matches the OLD unmocked
// behavior of this file, so every pre-existing test below is unaffected.
vi.mock("./lib/authClient", () => ({
  getMe: vi.fn(),
  login: vi.fn(),
  signup: vi.fn(),
  logout: vi.fn(),
  isAuthApiError: (v: unknown) => typeof v === "object" && v !== null && "code" in v,
}));
vi.mock("./lib/connectionsClient", () => ({
  getMyContext: vi.fn(),
}));

import * as authClient from "./lib/authClient";
import * as connectionsClient from "./lib/connectionsClient";

const auth = authClient as unknown as Record<"getMe", ReturnType<typeof vi.fn>>;
const conns = connectionsClient as unknown as Record<"getMyContext", ReturnType<typeof vi.fn>>;

// ── Setup/teardown ────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Default: signed out (matches this file's pre-v1.73 unmocked behavior — a real fetch failure
  // was caught the same way) so the Admin tab / team pill stay absent unless a test opts in.
  auth.getMe.mockRejectedValue({ code: "UNAUTHENTICATED", message: "Sign in" });
});

afterEach(() => {
  cleanup();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("App — tab nav (v1.7, ADR-018)", () => {
  it("renders Dashboard, Planning, and Reports tabs", () => {
    render(<App />);
    expect(screen.getByRole("tab", { name: "Huddle" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Planning" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Reports" })).toBeTruthy();
  });

  it("does NOT render a 'Ticket Generator' tab (removed in v1.7)", () => {
    render(<App />);
    expect(screen.queryByRole("tab", { name: /ticket generator/i })).toBeNull();
  });

  it("shows Dashboard page by default", () => {
    render(<App />);
    expect(screen.getByTestId("page-dashboard")).toBeTruthy();
    expect(screen.queryByTestId("page-planning")).toBeNull();
    expect(screen.queryByTestId("page-reports")).toBeNull();
  });

  it("Dashboard tab has aria-pressed=true and aria-selected=true by default", () => {
    render(<App />);
    const dashTab = screen.getByRole("tab", { name: "Huddle" });
    expect(dashTab.getAttribute("aria-pressed")).toBe("true");
    expect(dashTab.getAttribute("aria-selected")).toBe("true");
    expect(dashTab.getAttribute("aria-current")).toBe("page");
  });

  it("Planning tab has aria-pressed=false by default", () => {
    render(<App />);
    const planningTab = screen.getByRole("tab", { name: "Planning" });
    expect(planningTab.getAttribute("aria-pressed")).toBe("false");
    expect(planningTab.getAttribute("aria-selected")).toBe("false");
  });

  it("clicking Planning tab shows the Planning page", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("tab", { name: "Planning" }));
    await waitFor(() => {
      expect(screen.getByTestId("page-planning")).toBeTruthy();
    });
    // Other pages are unmounted
    expect(screen.queryByTestId("page-dashboard")).toBeNull();
    expect(screen.queryByTestId("page-reports")).toBeNull();
  });

  it("clicking Reports tab shows the Reports page", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("tab", { name: "Reports" }));
    await waitFor(() => {
      expect(screen.getByTestId("page-reports")).toBeTruthy();
    });
    expect(screen.queryByTestId("page-dashboard")).toBeNull();
    expect(screen.queryByTestId("page-planning")).toBeNull();
  });

  it("Planning tab becomes aria-pressed=true after clicking it", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("tab", { name: "Planning" }));
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "Planning" }).getAttribute("aria-pressed")).toBe("true");
    });
    expect(screen.getByRole("tab", { name: "Huddle" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("tab", { name: "Reports" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("nav has accessible label 'Main navigation'", () => {
    render(<App />);
    expect(screen.getByRole("navigation", { name: /main navigation/i })).toBeTruthy();
  });

  // v1.49 (ADR-060): the guide is opened from a header button, not a tab.
  it("opens the Guide page from the header button (and it's not a tab)", () => {
    render(<App />);
    expect(screen.queryByRole("tab", { name: /guide/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /user guide/i }));
    expect(screen.getByTestId("page-guide")).toBeTruthy();
    expect(screen.queryByTestId("page-dashboard")).toBeNull();
  });
});

// v1.73 (ADR-084) — the header team pill: tells a member which team's shared board they're on.
describe("App — team pill (v1.73, ADR-084)", () => {
  it("does not render a team pill when the signed-in user has no team", async () => {
    auth.getMe.mockResolvedValue({ email: "solo@team.com" });
    conns.getMyContext.mockResolvedValue({
      ready: true,
      connections: { jira: null, github: null, ai: null },
      boards: { dev: [], po: [] },
      role: "user",
      team: null,
    });
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("page-dashboard")).toBeTruthy());
    expect(screen.queryByText(/^Team:/)).toBeNull();
  });

  it("renders a team pill naming the team once the user's context resolves one", async () => {
    auth.getMe.mockResolvedValue({ email: "member@team.com" });
    conns.getMyContext.mockResolvedValue({
      ready: true,
      connections: { jira: null, github: null, ai: null },
      boards: { dev: [], po: [] },
      role: "user",
      team: { id: "team1", name: "Platform squad" },
    });
    render(<App />);
    await waitFor(() => expect(screen.getByText("Team: Platform squad")).toBeTruthy());
  });
});
