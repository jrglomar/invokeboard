// Linking page tests — v1.11, ADR-022. Keyless/offline (all clients/hooks mocked).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { Linking } from "./Linking";

vi.mock("../hooks/useJira", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks/useJira")>();
  return {
    ...actual,
    useSprintList: vi.fn(),
    useActiveSprint: vi.fn(),
    useTeamMembers: vi.fn(),        // v1.36 (ADR-046): Dev-board roster for the assignee picker
    createLinkedDevTicket: vi.fn(),
    // v1.59 (ADR-071): idle/empty shape (anti-drift parity — see Reports.test.tsx's comment).
    useMultiSprintReport: vi.fn().mockReturnValue({ data: null, loading: false, error: null, run: vi.fn() }),
  };
});
vi.mock("../lib/boards", () => ({ useBoards: vi.fn() }));
// v1.72 (ADR-083): linkDevToPo/unlinkDevFromPo (modes 2/3) and aiDraftPoStory (mode 3)
// must be in these factories too — without them, entering a new mode throws
// "<fn> is not a function" even though this file's own 10 tests never call them.
vi.mock("../lib/linkClient", () => ({
  getLinkedIssues: vi.fn(),
  getIssueDescriptions: vi.fn(),
  linkDevToPo: vi.fn(),
  unlinkDevFromPo: vi.fn(),
}));
vi.mock("../lib/aiClient", () => ({ getAiStatus: vi.fn(), aiPlanDevTickets: vi.fn(), aiDraftPoStory: vi.fn() }));

import * as useJiraModule from "../hooks/useJira";
import * as boardsModule from "../lib/boards";
import * as linkClientModule from "../lib/linkClient";
import * as aiClientModule from "../lib/aiClient";

const BOARDS = { dev: [{ id: 10, projectKey: "VRDB" }], po: [{ id: 20, projectKey: "VBPO" }] };
const PO_SPRINTS = { active: [{ id: 200, name: "PO S", state: "active" as const, startDate: null, endDate: null, goal: null }], future: [], closed: [] };
const DEV_SPRINTS = { active: [{ id: 300, name: "Dev S", state: "active" as const, startDate: null, endDate: null, goal: null }], future: [], closed: [] };

const mkIssue = (key: string, summary: string) => ({
  key, summary, status: "To Do", statusCategory: "todo" as const,
  assignee: null, assigneeAccountId: null, storyPoints: 3, issueType: "Story",
  url: `https://jira/browse/${key}`, blocked: false,
});

const SPRINT_DATA = {
  sprint: { id: 200, name: "PO S", state: "active" as const, startDate: null, endDate: null, goal: null },
  activeSprints: [], futureSprints: [],
  issuesByStatus: { todo: [mkIssue("PO-1", "Already linked story"), mkIssue("PO-2", "Needs a dev task")], inprogress: [], codereview: [], done: [] },
  totals: { total: 2, todo: 2, inprogress: 0, codereview: 0, done: 0, blocked: 0, storyPointsTotal: 6, storyPointsDone: 0, storyPointsCodeReview: 0 },
};

function setMocks() {
  vi.mocked(boardsModule.useBoards).mockReturnValue({ boards: BOARDS, loading: false, error: null } as never);
  vi.mocked(useJiraModule.useSprintList).mockImplementation((_s: unknown, boardId?: number) =>
    ({ data: boardId === 20 ? PO_SPRINTS : DEV_SPRINTS, loading: false, error: null, run: vi.fn() } as never));
  vi.mocked(useJiraModule.useActiveSprint).mockReturnValue({ data: SPRINT_DATA, loading: false, error: null, run: vi.fn() } as never);
  vi.mocked(useJiraModule.useTeamMembers).mockReturnValue({
    data: [{ accountId: "u1", displayName: "Alice" }, { accountId: "u2", displayName: "Bob" }],
    loading: false, error: null, run: vi.fn(), save: vi.fn(),
  } as never);
  // PO-1 already has DEV-5; PO-2 has none
  vi.mocked(linkClientModule.getLinkedIssues).mockResolvedValue({
    links: { "PO-1": [{ key: "DEV-5", summary: "x", status: "Done", url: "u" }], "PO-2": [] },
  });
  // v1.14: PO descriptions fed into the plan (PO-2 is the auto-selected, link-less one).
  vi.mocked(linkClientModule.getIssueDescriptions).mockResolvedValue({
    descriptions: { "PO-1": "PO-1 details", "PO-2": "As a user I want password reset\n\nAC: link expires in 1h" },
  });
  vi.mocked(aiClientModule.getAiStatus).mockResolvedValue({ enabled: false, provider: null, model: null });
}

beforeEach(() => { vi.clearAllMocks(); setMocks(); });
afterEach(() => cleanup());

describe("Linking page (v1.11)", () => {
  it("renders the PO + Dev sprint selectors", () => {
    render(<Linking />);
    expect(screen.getByRole("combobox", { name: /PO board sprint/i })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: /Dev board sprint/i })).toBeTruthy();
  });

  it("lists PO tickets with existing-link badges and auto-selects link-less ones", async () => {
    render(<Linking />);
    fireEvent.change(screen.getByRole("combobox", { name: /PO board sprint/i }), { target: { value: "200" } });

    // PO-1 badged with its existing Dev link; PO-2 badged "no Dev link"
    expect(await screen.findByText(/→ DEV-5/)).toBeTruthy();
    // After links load, PO-2 (link-less) is auto-selected, PO-1 is not
    await waitFor(() => {
      const cbPo2 = screen.getByRole("checkbox", { name: /Select PO-2/i }) as HTMLInputElement;
      expect(cbPo2.checked).toBe(true);
    });
    expect((screen.getByRole("checkbox", { name: /Select PO-1/i }) as HTMLInputElement).checked).toBe(false);
  });

  it("plan (AI off) → Create all loops create_dev_ticket and logs the created Dev ticket", async () => {
    vi.mocked(useJiraModule.createLinkedDevTicket).mockResolvedValue({
      key: "DEV-99", url: "https://jira/browse/DEV-99", board: "DEV", linkedTo: "PO-2", sprintId: 300,
    } as never);

    render(<Linking />);
    fireEvent.change(screen.getByRole("combobox", { name: /PO board sprint/i }), { target: { value: "200" } });
    fireEvent.change(screen.getByRole("combobox", { name: /Dev board sprint/i }), { target: { value: "300" } });
    await screen.findByText(/→ DEV-5/);
    await waitFor(() => expect((screen.getByRole("checkbox", { name: /Select PO-2/i }) as HTMLInputElement).checked).toBe(true));

    // AI off → "Build plan (1)"
    fireEvent.click(screen.getByRole("button", { name: /Build plan/i }));

    // Plan phase: one editable item for PO-2
    expect(await screen.findByText(/Plan — 1 Dev task/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Create all/i }));

    await waitFor(() => {
      expect(vi.mocked(useJiraModule.createLinkedDevTicket)).toHaveBeenCalledWith(
        expect.objectContaining({ linkedPoTicketKey: "PO-2", sprintId: 300 })
      );
    });
    // Status log shows the created Dev ticket + summary
    expect(await screen.findByRole("link", { name: /Open DEV-99 in Jira/i })).toBeTruthy();
    expect(await screen.findByText(/1 created/i)).toBeTruthy();
  });

  it("v1.12: a plan item has a Regenerate control that re-plans that PO from a comment", async () => {
    vi.mocked(aiClientModule.getAiStatus).mockResolvedValue({ enabled: true, provider: "github", model: "m" });
    vi.mocked(aiClientModule.aiPlanDevTickets)
      .mockResolvedValueOnce({ assistantMessage: "plan", items: [{ poKey: "PO-2", devSummary: "v1 dev", devDescription: "d1" }], provider: "github", model: "m" })
      .mockResolvedValueOnce({ assistantMessage: "refined", items: [{ poKey: "PO-2", devSummary: "v2 dev refined", devDescription: "d2" }], provider: "github", model: "m" });

    render(<Linking />);
    fireEvent.change(screen.getByRole("combobox", { name: /PO board sprint/i }), { target: { value: "200" } });
    await screen.findByText(/→ DEV-5/);
    await waitFor(() => expect((screen.getByRole("checkbox", { name: /Select PO-2/i }) as HTMLInputElement).checked).toBe(true));

    // AI on → "Generate plan with AI"
    fireEvent.click(screen.getByRole("button", { name: /Generate plan with AI/i }));
    // v1.30 (ADR-042): the title is KEPT from the PO; the AI only drives the description.
    expect(await screen.findByDisplayValue("d1")).toBeTruthy();
    expect(screen.getByDisplayValue("Needs a dev task")).toBeTruthy(); // PO title retained

    // Comment + Regenerate that item
    fireEvent.change(screen.getByLabelText(/Comment to refine the draft for PO-2/i), { target: { value: "focus on the API layer" } });
    fireEvent.click(screen.getByRole("button", { name: /Regenerate/i }));

    await waitFor(() => {
      const calls = vi.mocked(aiClientModule.aiPlanDevTickets).mock.calls;
      const last = calls[calls.length - 1]![0];
      expect(last.poStories).toHaveLength(1);
      expect(last.poStories[0]!.key).toBe("PO-2");
      expect(last.instructions).toContain("focus on the API layer");
    });
    // Description refreshed to v2; title still the PO's.
    expect(await screen.findByDisplayValue("d2")).toBeTruthy();
    expect(screen.getByDisplayValue("Needs a dev task")).toBeTruthy();
  });

  it("v1.14: Generate fetches the PO description and passes it to the AI plan", async () => {
    vi.mocked(aiClientModule.getAiStatus).mockResolvedValue({ enabled: true, provider: "github", model: "m" });
    vi.mocked(aiClientModule.aiPlanDevTickets).mockResolvedValue({
      assistantMessage: "planned", items: [{ poKey: "PO-2", devSummary: "dev", devDescription: "d" }],
      provider: "github", model: "m",
    });

    render(<Linking />);
    fireEvent.change(screen.getByRole("combobox", { name: /PO board sprint/i }), { target: { value: "200" } });
    await screen.findByText(/→ DEV-5/);
    await waitFor(() => expect((screen.getByRole("checkbox", { name: /Select PO-2/i }) as HTMLInputElement).checked).toBe(true));

    fireEvent.click(screen.getByRole("button", { name: /Generate plan with AI/i }));

    await waitFor(() => {
      // descriptions were requested for the selected PO(s)
      expect(vi.mocked(linkClientModule.getIssueDescriptions)).toHaveBeenCalledWith(["PO-2"]);
      // and the PO description flowed into the AI plan's poStories
      const calls = vi.mocked(aiClientModule.aiPlanDevTickets).mock.calls;
      const sent = calls[calls.length - 1]![0].poStories;
      expect(sent).toEqual([
        expect.objectContaining({ key: "PO-2", summary: "Needs a dev task", description: expect.stringContaining("password reset") }),
      ]);
    });
  });

  it("v1.14.1: flags a PO that has no description in Jira (drafted from title only)", async () => {
    // PO-2 (the auto-selected, link-less one) comes back with an empty description.
    vi.mocked(linkClientModule.getIssueDescriptions).mockResolvedValue({
      descriptions: { "PO-1": "PO-1 details", "PO-2": "" },
    });

    render(<Linking />);
    fireEvent.change(screen.getByRole("combobox", { name: /PO board sprint/i }), { target: { value: "200" } });
    await screen.findByText(/→ DEV-5/);
    await waitFor(() => expect((screen.getByRole("checkbox", { name: /Select PO-2/i }) as HTMLInputElement).checked).toBe(true));

    fireEvent.click(screen.getByRole("button", { name: /Build plan/i }));
    await screen.findByText(/Plan — 1 Dev task/i);

    // The plan surfaces that this PO has no description (so the user isn't confused).
    expect(await screen.findByText(/PO has no description/i)).toBeTruthy();
  });

  it("v1.13 P0: 'Retry failed' re-runs only the failed rows", async () => {
    vi.mocked(useJiraModule.createLinkedDevTicket)
      .mockRejectedValueOnce({ code: "UPSTREAM", message: "boom" })
      .mockResolvedValueOnce({ key: "DEV-77", url: "https://jira/browse/DEV-77", board: "DEV", linkedTo: "PO-2", sprintId: 300 } as never);

    render(<Linking />);
    fireEvent.change(screen.getByRole("combobox", { name: /PO board sprint/i }), { target: { value: "200" } });
    await screen.findByText(/→ DEV-5/);
    await waitFor(() => expect((screen.getByRole("checkbox", { name: /Select PO-2/i }) as HTMLInputElement).checked).toBe(true));

    fireEvent.click(screen.getByRole("button", { name: /Build plan/i }));
    await screen.findByText(/Plan — 1 Dev task/i);
    fireEvent.click(screen.getByRole("button", { name: /Create all/i }));

    // First attempt fails → "1 failed" + a Retry button
    expect(await screen.findByText(/1 failed/i)).toBeTruthy();
    const retry = await screen.findByRole("button", { name: /Retry failed \(1\)/i });

    fireEvent.click(retry);

    // Retry succeeds → the created Dev ticket appears, no more failures
    expect(await screen.findByRole("link", { name: /Open DEV-77 in Jira/i })).toBeTruthy();
    expect(await screen.findByText(/1 created/i)).toBeTruthy();
    expect(vi.mocked(useJiraModule.createLinkedDevTicket)).toHaveBeenCalledTimes(2);
  });

  it("v1.30 (ADR-042): keeps the PO title and carries the PO points onto the created Dev task", async () => {
    vi.mocked(useJiraModule.createLinkedDevTicket).mockResolvedValue({
      key: "DEV-99", url: "https://jira/browse/DEV-99", board: "DEV", linkedTo: "PO-2", sprintId: 300,
    } as never);

    render(<Linking />);
    fireEvent.change(screen.getByRole("combobox", { name: /PO board sprint/i }), { target: { value: "200" } });
    fireEvent.change(screen.getByRole("combobox", { name: /Dev board sprint/i }), { target: { value: "300" } });
    await screen.findByText(/→ DEV-5/);
    await waitFor(() => expect((screen.getByRole("checkbox", { name: /Select PO-2/i }) as HTMLInputElement).checked).toBe(true));

    fireEvent.click(screen.getByRole("button", { name: /Build plan/i }));
    await screen.findByText(/Plan — 1 Dev task/i);

    // Title field is prefilled with the PO story's title (not an AI/template title).
    expect(screen.getByDisplayValue("Needs a dev task")).toBeTruthy();
    // Points field is drafted from the PO (mkIssue → 3, a single allowed value → one Dev task)
    // and is editable. v1.36: the label is now per-task ("Dev task 1 of PO-2").
    const pts = screen.getByLabelText(/Story points for Dev task 1 of PO-2/i) as HTMLInputElement;
    expect(pts.value).toBe("3");
    // Override the drafted points before creating.
    fireEvent.change(pts, { target: { value: "5" } });

    fireEvent.click(screen.getByRole("button", { name: /Create all/i }));

    await waitFor(() => {
      // create_dev_ticket gets the PO title AND the EDITED points (5, not the PO's 3).
      expect(vi.mocked(useJiraModule.createLinkedDevTicket)).toHaveBeenCalledWith(
        expect.objectContaining({ linkedPoTicketKey: "PO-2", summary: "Needs a dev task", storyPoints: 5 })
      );
    });
  });

  // ── v1.36 (ADR-046): point-driven breakdown into up to two Dev tasks ──────────
  const PO4 = {
    sprint: { id: 200, name: "PO S", state: "active" as const, startDate: null, endDate: null, goal: null },
    activeSprints: [], futureSprints: [],
    issuesByStatus: { todo: [{ ...mkIssue("PO-9", "Password reset"), storyPoints: 4 }], inprogress: [], codereview: [], done: [] },
    totals: { total: 1, todo: 1, inprogress: 0, codereview: 0, done: 0, blocked: 0, storyPointsTotal: 4, storyPointsDone: 0, storyPointsCodeReview: 0 },
  };
  function setup4ptPo() {
    vi.mocked(useJiraModule.useActiveSprint).mockReturnValue({ data: PO4, loading: false, error: null, run: vi.fn() } as never);
    vi.mocked(linkClientModule.getLinkedIssues).mockResolvedValue({ links: { "PO-9": [] } });
    vi.mocked(linkClientModule.getIssueDescriptions).mockResolvedValue({ descriptions: { "PO-9": "reset flow" } });
  }

  describe("point-driven breakdown (v1.36)", () => {
    it("splits a 4-point PO into two 2-point Dev tasks, each independently assignable", async () => {
      setup4ptPo();
      vi.mocked(useJiraModule.createLinkedDevTicket).mockResolvedValue({ key: "DEV-1", url: "https://jira/browse/DEV-1", board: "DEV", linkedTo: "PO-9" } as never);

      render(<Linking />);
      fireEvent.change(screen.getByRole("combobox", { name: /PO board sprint/i }), { target: { value: "200" } });
      fireEvent.click(await screen.findByRole("button", { name: /Build plan \(1\)/i }));

      await screen.findByText("Dev task 1 of 2");
      expect(screen.getByText("Dev task 2 of 2")).toBeTruthy();

      // Both rows seeded with the breakdown estimate: 2 + 2.
      const points = screen.getAllByLabelText(/Story points for Dev task/i) as HTMLInputElement[];
      expect(points.map((p) => p.value)).toEqual(["2", "2"]);

      // Route the two tasks to two different developers.
      const assignees = screen.getAllByLabelText(/Assignee for Dev task/i) as HTMLSelectElement[];
      fireEvent.change(assignees[0]!, { target: { value: "u1" } });
      fireEvent.change(assignees[1]!, { target: { value: "u2" } });

      fireEvent.click(screen.getByRole("button", { name: /Create all/i }));
      await waitFor(() => expect(vi.mocked(useJiraModule.createLinkedDevTicket)).toHaveBeenCalledTimes(2));

      const calls = vi.mocked(useJiraModule.createLinkedDevTicket).mock.calls;
      expect(calls[0]![0]).toMatchObject({ linkedPoTicketKey: "PO-9", storyPoints: 2, assigneeAccountId: "u1" });
      expect(calls[1]![0]).toMatchObject({ linkedPoTicketKey: "PO-9", storyPoints: 2, assigneeAccountId: "u2" });
    });

    it("lets a planner add and remove Dev-task rows within a PO group", async () => {
      setup4ptPo();

      render(<Linking />);
      fireEvent.change(screen.getByRole("combobox", { name: /PO board sprint/i }), { target: { value: "200" } });
      fireEvent.click(await screen.findByRole("button", { name: /Build plan \(1\)/i }));
      await screen.findByText("Dev task 1 of 2");

      fireEvent.click(screen.getByRole("button", { name: /Add another Dev task for PO-9/i }));
      await screen.findByText("Dev task 3 of 3");
      expect(screen.getAllByLabelText(/Story points for Dev task/i)).toHaveLength(3);

      const removeButtons = screen.getAllByRole("button", { name: /Remove Dev task/i });
      fireEvent.click(removeButtons[removeButtons.length - 1]!);
      await waitFor(() => expect(screen.queryByText("Dev task 3 of 3")).toBeNull());
      expect(screen.getAllByLabelText(/Story points for Dev task/i)).toHaveLength(2);
    });
  });
});
