// LinkExistingMode tests — Linking mode 2, "Link existing" (v1.72, ADR-083).
// Keyless/offline: useActiveSprint, linkClient, and useAuth are all mocked — no fetch.
// The component takes its board/sprint/project-key context as PROPS (the shell owns the
// hooks), so unlike Linking.test.tsx there is no useBoards/useSprintList to mock here.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { LinkExistingMode } from "./LinkExistingMode";

vi.mock("../../hooks/useJira", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useJira")>();
  return { ...actual, useActiveSprint: vi.fn() };
});
vi.mock("../../lib/linkClient", () => ({
  getLinkedIssues: vi.fn(),
  linkDevToPo: vi.fn(),
  unlinkDevFromPo: vi.fn(),
}));
vi.mock("../../context/AuthContext", () => ({ useAuth: vi.fn() }));

import * as useJiraModule from "../../hooks/useJira";
import * as linkClientModule from "../../lib/linkClient";
import * as authModule from "../../context/AuthContext";

const PO_BOARD_ID = 20;
const DEV_BOARD_ID = 10;
const PO_SPRINT_ID = 200;
const DEV_SPRINT_ID = 300;
const PO_PROJECT_KEY = "VBPO";

const mkIssue = (key: string, summary: string, storyPoints: number | null = 3) => ({
  key, summary, status: "To Do", statusCategory: "todo" as const,
  assignee: null, assigneeAccountId: null, storyPoints, issueType: "Story",
  url: `https://jira/browse/${key}`, blocked: false,
});

const PO_SPRINT_DATA = {
  sprint: { id: PO_SPRINT_ID, name: "PO S", state: "active" as const, startDate: null, endDate: null, goal: null },
  activeSprints: [], futureSprints: [],
  issuesByStatus: { todo: [mkIssue("PO-7", "Password reset"), mkIssue("PO-8", "Other story")], inprogress: [], codereview: [], done: [] },
  totals: { total: 2, todo: 2, inprogress: 0, codereview: 0, done: 0, blocked: 0, storyPointsTotal: 6, storyPointsDone: 0, storyPointsCodeReview: 0 },
};

const DEV_SPRINT_DATA = {
  sprint: { id: DEV_SPRINT_ID, name: "Dev S", state: "active" as const, startDate: null, endDate: null, goal: null },
  activeSprints: [], futureSprints: [],
  issuesByStatus: { todo: [mkIssue("DEV-1", "Fix login bug"), mkIssue("DEV-2", "Add signup flow")], inprogress: [], codereview: [], done: [] },
  totals: { total: 2, todo: 2, inprogress: 0, codereview: 0, done: 0, blocked: 0, storyPointsTotal: 6, storyPointsDone: 0, storyPointsCodeReview: 0 },
};

function setMocks(opts?: { readOnly?: boolean }) {
  vi.mocked(useJiraModule.useActiveSprint).mockImplementation((boardId?: number) =>
    ({ data: boardId === PO_BOARD_ID ? PO_SPRINT_DATA : DEV_SPRINT_DATA, loading: false, error: null, run: vi.fn() } as never)
  );
  vi.mocked(linkClientModule.getLinkedIssues).mockResolvedValue({ links: { "DEV-1": [], "DEV-2": [] } });
  vi.mocked(authModule.useAuth).mockReturnValue({ readOnly: opts?.readOnly ?? false } as never);
}

function renderMode() {
  return render(
    <LinkExistingMode
      poBoardId={PO_BOARD_ID}
      devBoardId={DEV_BOARD_ID}
      poSprintId={PO_SPRINT_ID}
      devSprintId={DEV_SPRINT_ID}
      poProjectKey={PO_PROJECT_KEY}
    />
  );
}

/** Wait for the initial get_linked_issues fetch to settle before interacting. */
async function waitForLinksSettled() {
  await waitFor(() => expect(screen.queryByText(/Checking existing PO links/i)).toBeNull());
}

beforeEach(() => { vi.clearAllMocks(); setMocks(); });
afterEach(() => cleanup());

describe("LinkExistingMode (v1.72, ADR-083)", () => {
  it("badges a linked Dev ticket with its PO story and an unlinked one with 'no PO link'", async () => {
    vi.mocked(linkClientModule.getLinkedIssues).mockResolvedValue({
      links: {
        "DEV-1": [{ key: "PO-7", summary: "Password reset", status: "To Do", url: "u", linkId: "link-1", linkTypeName: "Blocks", direction: "outward" }],
        "DEV-2": [],
      },
    });
    renderMode();
    await waitForLinksSettled();
    // DEV-1 is linked, so the default "unlinked only" filter hides it — turn it off to see both rows at once.
    fireEvent.click(screen.getByRole("checkbox", { name: /Show only Dev tickets with no PO link/i }));

    expect(await screen.findByText(/→ PO-7/)).toBeTruthy();
    expect(screen.getByText(/no PO link/i)).toBeTruthy();
  });

  it("links each selected Dev ticket to the chosen PO story sequentially and logs successes", async () => {
    renderMode();
    await waitForLinksSettled();
    fireEvent.change(screen.getByRole("combobox", { name: /Target PO story/i }), { target: { value: "PO-7" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Select DEV-1/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Select DEV-2/i }));

    vi.mocked(linkClientModule.linkDevToPo).mockImplementation((poKey: string, devKey: string) =>
      Promise.resolve({ poKey, devKey, linkTypeName: "Blocks", created: true, alreadyLinked: false, linkId: null })
    );

    fireEvent.click(screen.getByRole("button", { name: /Link 2 to PO-7/i }));

    await waitFor(() => expect(linkClientModule.linkDevToPo).toHaveBeenCalledTimes(2));
    expect(linkClientModule.linkDevToPo).toHaveBeenNthCalledWith(1, "PO-7", "DEV-1");
    expect(linkClientModule.linkDevToPo).toHaveBeenNthCalledWith(2, "PO-7", "DEV-2");
    expect(await screen.findByText(/2 linked/i)).toBeTruthy();
  });

  it("renders an alreadyLinked result as a muted 'already linked' row, not a failure", async () => {
    renderMode();
    await waitForLinksSettled();
    fireEvent.change(screen.getByRole("combobox", { name: /Target PO story/i }), { target: { value: "PO-7" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Select DEV-1/i }));

    vi.mocked(linkClientModule.linkDevToPo).mockResolvedValue({
      poKey: "PO-7", devKey: "DEV-1", linkTypeName: "Blocks", created: false, alreadyLinked: true, linkId: "link-5",
    });

    fireEvent.click(screen.getByRole("button", { name: /Link 1 to PO-7/i }));

    expect(await screen.findByText(/already linked/i)).toBeTruthy();
    expect(screen.queryByText(/failed/i)).toBeNull();
    expect(await screen.findByText(/1 linked/i)).toBeTruthy();
  });

  it("'Retry failed' re-invokes linkDevToPo only for the failed key", async () => {
    renderMode();
    await waitForLinksSettled();
    fireEvent.change(screen.getByRole("combobox", { name: /Target PO story/i }), { target: { value: "PO-7" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Select DEV-1/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Select DEV-2/i }));

    vi.mocked(linkClientModule.linkDevToPo)
      .mockResolvedValueOnce({ poKey: "PO-7", devKey: "DEV-1", linkTypeName: "Blocks", created: true, alreadyLinked: false, linkId: null })
      .mockRejectedValueOnce({ code: "UPSTREAM", message: "boom" });

    fireEvent.click(screen.getByRole("button", { name: /Link 2 to PO-7/i }));

    expect(await screen.findByText(/1 failed/i)).toBeTruthy();
    const retry = await screen.findByRole("button", { name: /Retry failed \(1\)/i });

    vi.mocked(linkClientModule.linkDevToPo).mockResolvedValueOnce({
      poKey: "PO-7", devKey: "DEV-2", linkTypeName: "Blocks", created: true, alreadyLinked: false, linkId: null,
    });
    fireEvent.click(retry);

    await waitFor(() => expect(linkClientModule.linkDevToPo).toHaveBeenCalledTimes(3));
    expect(linkClientModule.linkDevToPo).toHaveBeenNthCalledWith(3, "PO-7", "DEV-2");
    // DEV-1 (the successful key) was never re-sent.
    const dev1Calls = vi.mocked(linkClientModule.linkDevToPo).mock.calls.filter((c) => c[1] === "DEV-1");
    expect(dev1Calls).toHaveLength(1);
    expect(await screen.findByText(/2 linked/i)).toBeTruthy();
  });

  it("Unlink is a two-click confirm sending { linkId, poKey, devKey }", async () => {
    vi.mocked(linkClientModule.getLinkedIssues).mockResolvedValue({
      links: {
        "DEV-1": [{ key: "PO-7", summary: "Password reset", status: "To Do", url: "u", linkId: "link-99", linkTypeName: "Blocks", direction: "outward" }],
        "DEV-2": [],
      },
    });
    renderMode();
    await waitForLinksSettled();
    fireEvent.click(screen.getByRole("checkbox", { name: /Show only Dev tickets with no PO link/i }));

    const unlinkBtn = await screen.findByRole("button", { name: /^Unlink DEV-1 from PO-7$/i });
    fireEvent.click(unlinkBtn);
    expect(linkClientModule.unlinkDevFromPo).not.toHaveBeenCalled();

    const confirmBtn = screen.getByRole("button", { name: /^Confirm unlink DEV-1 from PO-7$/i });
    vi.mocked(linkClientModule.unlinkDevFromPo).mockResolvedValue({
      linkId: "link-99", deleted: true, alreadyGone: false, poKey: "PO-7", devKey: "DEV-1",
    });
    fireEvent.click(confirmBtn);

    await waitFor(() =>
      expect(linkClientModule.unlinkDevFromPo).toHaveBeenCalledWith({ linkId: "link-99", poKey: "PO-7", devKey: "DEV-1" })
    );
    expect(linkClientModule.unlinkDevFromPo).toHaveBeenCalledTimes(1);
  });

  it("fetches links with the explicit PO project key (§4.17) — not the default", async () => {
    renderMode();
    await waitFor(() => expect(linkClientModule.getLinkedIssues).toHaveBeenCalled());
    expect(linkClientModule.getLinkedIssues).toHaveBeenCalledWith(["DEV-1", "DEV-2"], PO_PROJECT_KEY);
  });

  it("read-only users see linking/unlinking disabled behind a banner", async () => {
    setMocks({ readOnly: true });
    renderMode();
    await waitForLinksSettled();
    expect(screen.getByText(/read-only mode/i)).toBeTruthy();

    fireEvent.change(screen.getByRole("combobox", { name: /Target PO story/i }), { target: { value: "PO-7" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Select DEV-1/i }));
    expect(screen.getByRole("button", { name: /Link 1 to PO-7/i })).toBeDisabled();
  });
});
