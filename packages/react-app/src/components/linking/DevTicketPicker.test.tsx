// DevTicketPicker tests — the shared Dev-ticket candidate list used by the "Link
// existing" and "New PO from Dev tasks" Linking modes (v1.72, ADR-083). Fully
// controlled/presentational — no module mocks needed.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { DevTicketPicker } from "./DevTicketPicker";
import type { IssueSummary, LinkedIssue } from "../../lib/types";

afterEach(() => cleanup());

const mkIssue = (key: string, summary: string, assignee: string | null = null): IssueSummary => ({
  key,
  summary,
  status: "To Do",
  statusCategory: "todo",
  assignee,
  assigneeAccountId: null,
  storyPoints: 3,
  issueType: "Story",
  url: `https://jira/browse/${key}`,
  blocked: false,
});

const mkLink = (key: string): LinkedIssue => ({
  key,
  summary: "linked summary",
  status: "To Do",
  url: `https://jira/browse/${key}`,
});

/** Common defaults so each test only overrides what it's exercising. */
function baseProps() {
  return {
    loading: false,
    selected: new Set<string>(),
    onToggle: vi.fn(),
    onSetSelected: vi.fn(),
    poLinksByDevKey: {} as Record<string, LinkedIssue[]>,
    linksLoading: false,
    unlinkedOnly: false,
    onUnlinkedOnlyChange: vi.fn(),
    assigneeFilter: null as string | null,
    onAssigneeFilterChange: vi.fn(),
  };
}

describe("DevTicketPicker — unlinkedOnly", () => {
  it("hides rows that already have a PO link when unlinkedOnly is true", () => {
    const issues = [mkIssue("DEV-1", "Has a PO link"), mkIssue("DEV-2", "No PO link")];
    const links = { "DEV-1": [mkLink("PO-1")] };

    const { rerender } = render(
      <DevTicketPicker {...baseProps()} issues={issues} poLinksByDevKey={links} unlinkedOnly={false} />
    );
    expect(screen.getByRole("checkbox", { name: /Select DEV-1/i })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /Select DEV-2/i })).toBeTruthy();

    rerender(
      <DevTicketPicker {...baseProps()} issues={issues} poLinksByDevKey={links} unlinkedOnly={true} />
    );
    expect(screen.queryByRole("checkbox", { name: /Select DEV-1/i })).toBeNull();
    expect(screen.getByRole("checkbox", { name: /Select DEV-2/i })).toBeTruthy();
  });
});

describe("DevTicketPicker — assignee filter", () => {
  it("narrows the list to the chosen assignee, and the __unassigned__ sentinel selects null-assignee rows", () => {
    const issues = [
      mkIssue("DEV-1", "Alice's ticket", "Alice"),
      mkIssue("DEV-2", "Bob's ticket", "Bob"),
      mkIssue("DEV-3", "Nobody's ticket", null),
    ];

    const { rerender } = render(
      <DevTicketPicker {...baseProps()} issues={issues} assigneeFilter="Alice" />
    );
    expect(screen.getByRole("checkbox", { name: /Select DEV-1/i })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: /Select DEV-2/i })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /Select DEV-3/i })).toBeNull();

    rerender(<DevTicketPicker {...baseProps()} issues={issues} assigneeFilter="__unassigned__" />);
    expect(screen.queryByRole("checkbox", { name: /Select DEV-1/i })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /Select DEV-2/i })).toBeNull();
    expect(screen.getByRole("checkbox", { name: /Select DEV-3/i })).toBeTruthy();
  });
});

describe("DevTicketPicker — select all", () => {
  it("calls onSetSelected with every VISIBLE key (respecting the active filter)", () => {
    const onSetSelected = vi.fn();
    const issues = [mkIssue("DEV-1", "Alice's ticket", "Alice"), mkIssue("DEV-2", "Bob's ticket", "Bob")];

    render(
      <DevTicketPicker
        {...baseProps()}
        issues={issues}
        assigneeFilter="Alice"
        onSetSelected={onSetSelected}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Select all/i }));

    expect(onSetSelected).toHaveBeenCalledWith(new Set(["DEV-1"]));
  });
});

describe("DevTicketPicker — PO-link badges", () => {
  it("renders a '→ PO-x' badge + renderLinkAction for a linked row, and 'no PO link' for an unlinked one", () => {
    const issues = [mkIssue("DEV-1", "Linked ticket"), mkIssue("DEV-2", "Unlinked ticket")];
    const links = { "DEV-1": [mkLink("PO-9")] };

    render(
      <DevTicketPicker
        {...baseProps()}
        issues={issues}
        poLinksByDevKey={links}
        renderLinkAction={(devKey, link) => <button>{`Unlink ${devKey} from ${link.key}`}</button>}
      />
    );

    expect(screen.getByText(/→ PO-9/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Unlink DEV-1 from PO-9" })).toBeTruthy();
    expect(screen.getByText("no PO link")).toBeTruthy();
  });
});
