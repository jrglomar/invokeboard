// NewPoFromDevMode tests — Linking mode 3, "New PO from Dev tasks" (v1.72, ADR-083).
// Keyless/offline: useActiveSprint/createPoTicket, linkClient, aiClient, and useAuth are
// all mocked — no fetch. `aiStatus` is a PROP here (the shell owns getAiStatus), so unlike
// Linking.test.tsx there is nothing to mock for it.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { NewPoFromDevMode } from "./NewPoFromDevMode";
import type { AiStatus } from "../../lib/types";

vi.mock("../../hooks/useJira", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useJira")>();
  return { ...actual, useActiveSprint: vi.fn(), createPoTicket: vi.fn() };
});
vi.mock("../../lib/linkClient", () => ({
  getLinkedIssues: vi.fn(),
  getIssueDescriptions: vi.fn(),
  linkDevToPo: vi.fn(),
}));
vi.mock("../../lib/aiClient", () => ({ aiDraftPoStory: vi.fn() }));
vi.mock("../../context/AuthContext", () => ({ useAuth: vi.fn() }));

import * as useJiraModule from "../../hooks/useJira";
import * as linkClientModule from "../../lib/linkClient";
import * as aiClientModule from "../../lib/aiClient";
import * as authModule from "../../context/AuthContext";

const DEV_BOARD_ID = 10;
const DEV_SPRINT_ID = 300;
const PO_SPRINT_ID = 200;
const PO_PROJECT_KEY = "VBPO";

const AI_OFF: AiStatus = { enabled: false, provider: null, model: null };
const AI_ON: AiStatus = { enabled: true, provider: "anthropic", model: "claude-x" };

const mkIssue = (key: string, summary: string, storyPoints: number | null) => ({
  key, summary, status: "To Do", statusCategory: "todo" as const,
  assignee: null, assigneeAccountId: null, storyPoints, issueType: "Task",
  url: `https://jira/browse/${key}`, blocked: false,
});

const DEV_SPRINT_DATA = {
  sprint: { id: DEV_SPRINT_ID, name: "Dev S", state: "active" as const, startDate: null, endDate: null, goal: null },
  activeSprints: [], futureSprints: [],
  issuesByStatus: {
    todo: [mkIssue("DEV-1", "Fix login bug", 3), mkIssue("DEV-2", "Add signup flow", 5)],
    inprogress: [], codereview: [], done: [],
  },
  totals: { total: 2, todo: 2, inprogress: 0, codereview: 0, done: 0, blocked: 0, storyPointsTotal: 8, storyPointsDone: 0, storyPointsCodeReview: 0 },
};

function setMocks(opts?: { readOnly?: boolean }) {
  vi.mocked(useJiraModule.useActiveSprint).mockReturnValue({ data: DEV_SPRINT_DATA, loading: false, error: null, run: vi.fn() } as never);
  vi.mocked(linkClientModule.getLinkedIssues).mockResolvedValue({ links: { "DEV-1": [], "DEV-2": [] } });
  vi.mocked(linkClientModule.getIssueDescriptions).mockResolvedValue({ descriptions: { "DEV-1": "login desc", "DEV-2": "" } });
  vi.mocked(authModule.useAuth).mockReturnValue({ readOnly: opts?.readOnly ?? false } as never);
}

function renderMode(aiStatus: AiStatus, poSprintId?: number) {
  return render(
    <NewPoFromDevMode
      devBoardId={DEV_BOARD_ID}
      devSprintId={DEV_SPRINT_ID}
      poSprintId={poSprintId}
      poProjectKey={PO_PROJECT_KEY}
      aiStatus={aiStatus}
    />
  );
}

beforeEach(() => { vi.clearAllMocks(); setMocks(); });
afterEach(() => cleanup());

describe("NewPoFromDevMode (v1.72, ADR-083)", () => {
  it("AI off: 'Draft PO story' prefills from the deterministic rollup and never calls the AI", async () => {
    renderMode(AI_OFF);
    fireEvent.click(screen.getByRole("checkbox", { name: /Select DEV-1/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Select DEV-2/i }));
    fireEvent.click(screen.getByRole("button", { name: /Draft PO story \(2\)/i }));

    expect(await screen.findByText(/AI is off/i)).toBeTruthy();
    const title = screen.getByLabelText("Title") as HTMLInputElement;
    const desc = screen.getByLabelText("Description") as HTMLTextAreaElement;
    expect(title.value).not.toBe("");
    expect(desc.value).not.toBe("");
    expect(desc.value).toContain("Delivered by");
    expect(aiClientModule.aiDraftPoStory).not.toHaveBeenCalled();
  });

  it("AI on: aiDraftPoStory is called with the selected tickets and populates the editable fields", async () => {
    vi.mocked(aiClientModule.aiDraftPoStory).mockResolvedValue({
      assistantMessage: "Drafted from the Dev tasks", summary: "Password reset epic",
      description: "## User Story\ncovers DEV-1, DEV-2", provider: "anthropic", model: "claude-x",
    });

    renderMode(AI_ON);
    fireEvent.click(screen.getByRole("checkbox", { name: /Select DEV-1/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Select DEV-2/i }));
    fireEvent.click(screen.getByRole("button", { name: /Draft PO story with AI \(2\)/i }));

    await waitFor(() => expect(aiClientModule.aiDraftPoStory).toHaveBeenCalledTimes(1));
    const call = vi.mocked(aiClientModule.aiDraftPoStory).mock.calls[0]![0];
    expect(call.devTickets.map((t) => t.key)).toEqual(["DEV-1", "DEV-2"]);

    expect(await screen.findByDisplayValue("Password reset epic")).toBeTruthy();
    expect((screen.getByLabelText("Description") as HTMLTextAreaElement).value).toContain("## User Story");
  });

  it("seeds the points field with the arithmetic sum of the selected tickets' points (3 + 5 = 8) and stays editable", async () => {
    renderMode(AI_OFF);
    fireEvent.click(screen.getByRole("checkbox", { name: /Select DEV-1/i })); // 3 pts
    fireEvent.click(screen.getByRole("checkbox", { name: /Select DEV-2/i })); // 5 pts
    fireEvent.click(screen.getByRole("button", { name: /Draft PO story \(2\)/i }));

    const points = (await screen.findByLabelText("Points")) as HTMLInputElement;
    expect(points.value).toBe("8");

    fireEvent.change(points, { target: { value: "13" } });
    expect((screen.getByLabelText("Points") as HTMLInputElement).value).toBe("13");
  });

  it("Create & link calls createPoTicket once (with sprintId), then linkDevToPo per Dev ticket with the new PO key, in order", async () => {
    vi.mocked(useJiraModule.createPoTicket).mockResolvedValue({
      key: "PO-99", url: "https://jira/browse/PO-99", board: "PO", sprintId: PO_SPRINT_ID,
    } as never);
    vi.mocked(linkClientModule.linkDevToPo).mockImplementation((poKey: string, devKey: string) =>
      Promise.resolve({ poKey, devKey, linkTypeName: "Blocks", created: true, alreadyLinked: false, linkId: null })
    );

    renderMode(AI_OFF, PO_SPRINT_ID);
    fireEvent.click(screen.getByRole("checkbox", { name: /Select DEV-1/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Select DEV-2/i }));
    fireEvent.click(screen.getByRole("button", { name: /Draft PO story \(2\)/i }));
    await screen.findByLabelText("Title");

    fireEvent.click(screen.getByRole("button", { name: /Create & link \(2\)/i }));

    await waitFor(() => expect(useJiraModule.createPoTicket).toHaveBeenCalledTimes(1));
    expect(useJiraModule.createPoTicket).toHaveBeenCalledWith(
      expect.objectContaining({ storyPoints: 8, sprintId: PO_SPRINT_ID })
    );

    await waitFor(() => expect(linkClientModule.linkDevToPo).toHaveBeenCalledTimes(2));
    expect(linkClientModule.linkDevToPo).toHaveBeenNthCalledWith(1, "PO-99", "DEV-1");
    expect(linkClientModule.linkDevToPo).toHaveBeenNthCalledWith(2, "PO-99", "DEV-2");
    expect(await screen.findByRole("link", { name: /Open PO-99 in Jira/i })).toBeTruthy();
  });

  it("createPoTicket rejecting issues ZERO linkDevToPo calls and shows an error (no orphan links)", async () => {
    vi.mocked(useJiraModule.createPoTicket).mockRejectedValue({ code: "UPSTREAM", message: "jira is down" });

    renderMode(AI_OFF);
    fireEvent.click(screen.getByRole("checkbox", { name: /Select DEV-1/i }));
    fireEvent.click(screen.getByRole("button", { name: /Draft PO story \(1\)/i }));
    await screen.findByLabelText("Title");

    fireEvent.click(screen.getByRole("button", { name: /Create & link \(1\)/i }));

    expect(await screen.findByText(/jira is down/i)).toBeTruthy();
    expect(linkClientModule.linkDevToPo).not.toHaveBeenCalled();
  });

  it("a partial link failure retries only the failed link and NEVER re-creates the PO story", async () => {
    vi.mocked(useJiraModule.createPoTicket).mockResolvedValue({
      key: "PO-100", url: "https://jira/browse/PO-100", board: "PO",
    } as never);
    vi.mocked(linkClientModule.linkDevToPo)
      .mockResolvedValueOnce({ poKey: "PO-100", devKey: "DEV-1", linkTypeName: "Blocks", created: true, alreadyLinked: false, linkId: null })
      .mockRejectedValueOnce({ code: "UPSTREAM", message: "boom" });

    renderMode(AI_OFF);
    fireEvent.click(screen.getByRole("checkbox", { name: /Select DEV-1/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Select DEV-2/i }));
    fireEvent.click(screen.getByRole("button", { name: /Draft PO story \(2\)/i }));
    await screen.findByLabelText("Title");

    fireEvent.click(screen.getByRole("button", { name: /Create & link \(2\)/i }));

    expect(await screen.findByText(/1 failed/i)).toBeTruthy();
    expect(useJiraModule.createPoTicket).toHaveBeenCalledTimes(1);

    vi.mocked(linkClientModule.linkDevToPo).mockResolvedValueOnce({
      poKey: "PO-100", devKey: "DEV-2", linkTypeName: "Blocks", created: true, alreadyLinked: false, linkId: null,
    });
    fireEvent.click(await screen.findByRole("button", { name: /Retry failed \(1\)/i }));

    await waitFor(() => expect(linkClientModule.linkDevToPo).toHaveBeenCalledTimes(3));
    expect(linkClientModule.linkDevToPo).toHaveBeenNthCalledWith(3, "PO-100", "DEV-2");
    // The highest-consequence assertion: create_po_ticket was NOT called again by the retry.
    expect(useJiraModule.createPoTicket).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/2 linked/i)).toBeTruthy();
  });

  it("RefineDraftControl regenerates: submitting a comment re-calls aiDraftPoStory with instructions and replaces the draft", async () => {
    vi.mocked(aiClientModule.aiDraftPoStory)
      .mockResolvedValueOnce({ assistantMessage: "v1", summary: "Password reset epic", description: "d1", provider: "anthropic", model: "m" })
      .mockResolvedValueOnce({ assistantMessage: "v2", summary: "Password reset epic, refined", description: "d2", provider: "anthropic", model: "m" });

    renderMode(AI_ON);
    fireEvent.click(screen.getByRole("checkbox", { name: /Select DEV-1/i }));
    fireEvent.click(screen.getByRole("button", { name: /Draft PO story with AI \(1\)/i }));
    expect(await screen.findByDisplayValue("Password reset epic")).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/Comment to refine the draft/i), { target: { value: "focus on security" } });
    fireEvent.click(screen.getByRole("button", { name: /Regenerate/i }));

    await waitFor(() => expect(aiClientModule.aiDraftPoStory).toHaveBeenCalledTimes(2));
    const secondCall = vi.mocked(aiClientModule.aiDraftPoStory).mock.calls[1]![0];
    expect(secondCall.instructions).toContain("focus on security");

    expect(await screen.findByDisplayValue("Password reset epic, refined")).toBeTruthy();
  });

  it("read-only users see the draft flow disabled behind a banner", () => {
    setMocks({ readOnly: true });
    renderMode(AI_OFF);
    expect(screen.getByText(/shared read-only Jira connection/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("checkbox", { name: /Select DEV-1/i }));
    expect(screen.getByRole("button", { name: /Draft PO story \(1\)/i })).toBeDisabled();
  });
});
