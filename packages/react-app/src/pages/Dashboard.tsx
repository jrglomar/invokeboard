import { useState, useEffect, useMemo } from "react";
import { Target } from "lucide-react";
import { SprintBoard } from "../components/SprintBoard";
import { HuddleDigest } from "../components/HuddleDigest";
import { BoardToggle } from "../components/BoardToggle";
import { ImpedimentsCard } from "../components/ImpedimentsCard";
import { LeaveStatusCard } from "../components/LeaveStatusCard";
import { PullRequestsCard } from "../components/PullRequestsCard";
import { MeetingGoalCard } from "../components/MeetingGoalCard";
import { AgingCard } from "../components/AgingCard";
import { MeetingNotesCard } from "../components/MeetingNotesCard";
import { FlyInCard, selectFlyIns, matchFlyIn } from "../components/FlyInCard";
import {
  useActiveSprint,
  useDailyHuddle,
  useIssuePullRequests,
  useLinkedIssues,
} from "../hooks/useJira";
import { useBoards, useAgingPolicy } from "../lib/boards";
import type { BoardKey, SharedSprintProps, LinkedIssue } from "../lib/types";

// a11y: main landmark is provided by the App shell; Dashboard uses the slot.
// v1.13 (ADR-024): controlled by App's shared board+sprint when props are present;
// uncontrolled (own state) when rendered standalone (e.g. in tests).
export function Dashboard({
  boardKey: boardKeyProp,
  sprintId: sprintIdProp,
  onBoardChange,
  onSprintChange,
  projectIdx,
}: SharedSprintProps = {}) {
  // v1.6: Board context — load once from health (ADR-017)
  const { boards, loading: boardsLoading } = useBoards();
  const agingPolicy = useAgingPolicy(); // v1.58 (ADR-070) — per-user; drives the Aging card + chips

  // v1.6/v1.13: Selected board key (default = "dev"); shared when controlled.
  const [localBoardKey, setLocalBoardKey] = useState<BoardKey>("dev");
  const selectedBoardKey = boardKeyProp ?? localBoardKey;

  // v1.25 (ADR-037): the active project index for this side (0 = default).
  const activeProjectIdx = projectIdx ?? 0;

  // The numeric board id passed to hooks. Null = not yet loaded → tools use server default (dev)
  const selectedBoardId: number | undefined = boards
    ? boards[selectedBoardKey][activeProjectIdx]?.id
    : undefined;

  // v1.1/v1.13: selected sprint. Dashboard's per-ceremony default IS null (the hook
  // then fetches the active sprint), so the shared null works directly.
  const [localSprintId, setLocalSprintId] = useState<number | null>(null);
  const selectedSprintId = onSprintChange
    ? (sprintIdProp ?? null)
    : localSprintId;

  // Unified setter — controlled writes to App (numbers only); else local.
  const setSprintSelection = (id: number | null) => {
    if (onSprintChange) {
      if (id !== null) onSprintChange(id);
    } else setLocalSprintId(id);
  };

  // v1.2: Dashboard owns assigneeFilter (ADR-008); null = All
  const [assigneeFilter, setAssigneeFilter] = useState<string | null>(null);

  // v1.58 (ADR-070): the Huddle is the only caller that needs Work Item Age, so it alone pays
  // for the changelog enrichment (withAging). The opposite-board fly-in fetch below does not.
  const sprint = useActiveSprint(selectedBoardId, selectedSprintId, true);
  const huddle = useDailyHuddle(selectedBoardId, selectedSprintId);

  // v1.40 (ADR-050): freshness stamp — records when sprint data last arrived.
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  useEffect(() => {
    if (sprint.data) setLastUpdated(new Date());
  }, [sprint.data]);

  // v1.27 (ADR-040): the OPPOSITE board's active sprint feeds the dual fly-in tracker
  // (default project on that side). One extra read; no-op when that board has no sprint.
  const otherBoardKey: BoardKey = selectedBoardKey === "dev" ? "po" : "dev";
  const otherBoardId: number | undefined = boards
    ? boards[otherBoardKey][0]?.id
    : undefined;
  const otherSprint = useActiveSprint(otherBoardId, null);

  // If the loaded data's active+future sprints no longer contain the selection, reset to null
  useEffect(() => {
    if (selectedSprintId !== null && sprint.data !== null) {
      const allSelectable = [
        ...sprint.data.activeSprints,
        ...sprint.data.futureSprints,
      ];
      if (!allSelectable.some((s) => s.id === selectedSprintId)) {
        // controlled-null is a no-op (App clears on board change); local resets.
        setSprintSelection(null);
      }
    }
  }, [sprint.data, selectedSprintId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSelectSprint = (id: number) => {
    // v1.2: reset assignee filter when sprint changes (ADR-008)
    setAssigneeFilter(null);
    setSprintSelection(id);
  };

  // v1.6: Board switch — reset sprint + filter, then refetch
  const handleBoardChange = (key: BoardKey) => {
    if (onBoardChange) onBoardChange(key);
    else setLocalBoardKey(key);
    setSprintSelection(null); // controlled: App also clears; uncontrolled: clears local
    setAssigneeFilter(null);
    // sprint + huddle auto-refetch when boardId changes (via the hooks' useEffect)
  };

  // v1.6: No-sprint empty state — map UPSTREAM "No active or future sprint" to friendly message
  // (A PO Kanban board returns this error; show empty state, not red error.)
  const isNoSprintError =
    sprint.error !== null &&
    (sprint.error.code === "UPSTREAM" ||
      sprint.error.message
        ?.toLowerCase()
        .includes("no active or future sprint"));

  const boardLabel = selectedBoardKey === "po" ? "PO" : "Dev";

  // v1.16: the impediments + PR cards key off a concrete sprint id. When no explicit
  // pick, fall back to the loaded active sprint's id (null until data arrives).
  const effectiveSprintId = selectedSprintId ?? sprint.data?.sprint.id ?? null;

  // v1.20 (ADR-031): the current sprint's ticket keys — auto-PRs are filtered to these.
  // v1.23 (ADR-035): also the flat issue list, reused for the Fly-in tracker.
  const sprintIssues = useMemo(() => {
    if (!sprint.data) return [];
    const b = sprint.data.issuesByStatus;
    return [...b.todo, ...b.inprogress, ...b.codereview, ...b.done];
  }, [sprint.data]);
  const sprintKeys = useMemo(
    () => sprintIssues.map((i) => i.key),
    [sprintIssues],
  );

  // v1.61 (ADR-073, item 173): AgingCard receives ONLY the inprogress bucket — code review
  // counts as done per the ADR-014 DoD, so get_active_sprint no longer enriches it with
  // inProgressSince (it would show as an unaged, un-clocked entry there anyway).
  const inProgressIssues = useMemo(
    () => sprint.data?.issuesByStatus.inprogress ?? [],
    [sprint.data]
  );

  // v1.27 (ADR-039): lift linked-PR data ONCE for the whole page — feeds both the
  // board's per-card "has PR" badge and the code-review card (avoids a double fetch).
  const issuePrs = useIssuePullRequests(sprintKeys);

  // v1.27 (ADR-040): DUAL fly-in tracking — Dev fly-ins + PO fly-ins side by side.
  // The selected board's issues come from `sprint`; the opposite board's from `otherSprint`.
  const otherIssues = useMemo(() => {
    if (!otherSprint.data) return [];
    const b = otherSprint.data.issuesByStatus;
    return [...b.todo, ...b.inprogress, ...b.codereview, ...b.done];
  }, [otherSprint.data]);
  const devIssues = selectedBoardKey === "dev" ? sprintIssues : otherIssues;
  const poIssues = selectedBoardKey === "po" ? sprintIssues : otherIssues;
  const devFlyIns = useMemo(() => selectFlyIns(devIssues), [devIssues]);
  const poFlyIns = useMemo(() => selectFlyIns(poIssues), [poIssues]);

  // Alignment: a PO fly-in is "aligned" when one of its linked Dev issues is itself a fly-in.
  const poFlyInKeys = useMemo(() => poFlyIns.map((i) => i.key), [poFlyIns]);
  const linkedForPo = useLinkedIssues(poFlyInKeys);
  const poAlignment = useMemo(() => {
    const out: Record<string, LinkedIssue | null> = {};
    for (const k of poFlyInKeys) {
      const links = linkedForPo.data[k] ?? [];
      out[k] = links.find((li) => matchFlyIn(li.summary)) ?? null;
    }
    return out;
  }, [poFlyInKeys, linkedForPo.data]);

  return (
    <div className="space-y-4">
      {/* v1.40 (ADR-050): freshness stamp — last time data arrived */}
      {lastUpdated && (
        <p className="text-[0.6875rem] text-muted-foreground text-right -mb-3" aria-live="polite">
          Updated{" "}
          {lastUpdated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </p>
      )}
      {/* Two-column layout: board (flex-1) | sidebar (360px) at lg+; stacked below */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-5 items-start">
        {/* Sprint board — left / full-width on mobile */}
        <section aria-label="Sprint board" className="min-w-0">
          {/* v1.6: Board toggle header. v1.24: when CONTROLLED by the App shell (onBoardChange
            present), the board selector lives in the shell top-bar — only render the in-page
            toggle in standalone use (e.g. tests). */}
          {!onBoardChange && (
            <div className="flex items-center gap-3 mb-3 flex-wrap">
              {!boardsLoading && boards !== null && (
                <BoardToggle
                  selectedKey={selectedBoardKey}
                  onChange={handleBoardChange}
                />
              )}
            </div>
          )}
          {/* v1.24: Fly-in tracking — full-width strip above the board (status + wide visibility).
          v1.27 (ADR-040): dual Dev + PO groups, with PO→Dev alignment. */}
          {(devFlyIns.length > 0 || poFlyIns.length > 0) && (
            <div className="items-center gap-3 mb-3 flex-wrap">
              <section aria-label="Fly-in tickets">
                <FlyInCard
                  devFlyIns={devFlyIns}
                  poFlyIns={poFlyIns}
                  poAlignment={poAlignment}
                />
              </section>
            </div>
          )}

          {/* v1.13 (ADR-024): Sprint-goal banner — goal + % points done + days left */}
          {sprint.data &&
            !isNoSprintError &&
            (() => {
              const s = sprint.data.sprint;
              const t = sprint.data.totals;
              const total = t.storyPointsTotal;
              const done = t.storyPointsDone + t.storyPointsCodeReview;
              const pct = total > 0 ? Math.round((done / total) * 100) : 0;
              let daysLeft: number | null = null;
              if (s.endDate) {
                daysLeft = Math.ceil(
                  (new Date(s.endDate).getTime() - Date.now()) / 86_400_000,
                );
              }
              return (
                <div
                  className="mb-3 rounded-lg border border-border bg-card p-3"
                  aria-label="Sprint goal"
                >
                  <div className="flex items-start gap-2.5">
                    <Target
                      className="h-4 w-4 text-primary mt-0.5 flex-shrink-0"
                      aria-hidden="true"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-[0.6875rem] font-semibold text-muted-foreground uppercase tracking-wide">
                        Sprint goal
                      </p>
                      {s.goal ? (
                        <p className="text-sm font-medium text-foreground">
                          {s.goal}
                        </p>
                      ) : (
                        <p className="text-sm text-muted-foreground italic">
                          No goal set — add one in Planning.
                        </p>
                      )}
                    </div>
                    <div className="text-right text-xs text-muted-foreground whitespace-nowrap">
                      <p>
                        <span className="font-semibold text-foreground tabular-nums">
                          {pct}%
                        </span>{" "}
                        pts done
                      </p>
                      {daysLeft !== null && s.state === "active" && (
                        <p>
                          {daysLeft >= 0
                            ? `${daysLeft} day${daysLeft !== 1 ? "s" : ""} left`
                            : "overdue"}
                        </p>
                      )}
                    </div>
                  </div>
                  {total > 0 && (
                    <div
                      className="mt-2 h-1.5 w-full rounded-full bg-muted overflow-hidden"
                      role="progressbar"
                      aria-valuenow={pct}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-label="Sprint goal progress"
                    >
                      <div
                        className="h-full bg-primary rounded-full transition-all"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  )}
                </div>
              );
            })()}

          {/* v1.6: No-sprint empty state (PO Kanban or board with no sprints) */}
          {isNoSprintError ? (
            <div className="rounded-lg border border-border bg-muted/40 p-8 text-center">
              <p className="text-base font-medium text-foreground mb-1">
                No sprints on the {boardLabel} board
              </p>
              <p className="text-sm text-muted-foreground">
                Switch to the Dev board to view an active sprint, or create a
                new sprint on this board.
              </p>
            </div>
          ) : (
            /* v1.7 (ADR-018): New Sprint button REMOVED from Dashboard — it now lives on the Planning page */
            <SprintBoard
              data={sprint.data}
              loading={sprint.loading}
              error={sprint.error}
              onRefresh={sprint.run}
              onSelectSprint={handleSelectSprint}
              assigneeFilter={assigneeFilter}
              onAssigneeFilterChange={setAssigneeFilter}
              prsByKey={issuePrs.data}
            />
          )}
        </section>

        {/* Sidebar: compact daily-standup widgets + Huddle Digest.
          The AI assistant is now a global floating widget (AssistantWidget). */}
        <div className="flex flex-col gap-3 min-w-0">
          {/* v1.20 (ADR-031): today's meeting focus, above the daily widgets */}
          <section aria-label="Meeting goal">
            <MeetingGoalCard sprintId={effectiveSprintId} />
          </section>
          {/* v1.31 (ADR-043): who's on leave today + in the coming days */}
          <section aria-label="On leave">
            <LeaveStatusCard />
          </section>
          {/* v1.41 (ADR-051): rich meeting notes — deployment notes, links (WYSIWYG) */}
          <section aria-label="Meeting notes">
            <MeetingNotesCard sprintId={effectiveSprintId} />
          </section>
          {/* v1.58 (ADR-070): Work Item Age — how long in-flight tickets have sat, vs a
              points-scaled expectation. Rides the already-fetched sprint data; no extra call.
              v1.61 (ADR-073, items 173-174): scoped to the inprogress bucket only, clamped to
              the selected sprint's start date. */}
          <section aria-label="Ticket aging">
            <AgingCard
              issues={inProgressIssues}
              policy={agingPolicy}
              sprintStartDate={sprint.data?.sprint.startDate}
            />
          </section>
          <section aria-label="Code review pull requests">
            <PullRequestsCard
              sprintId={effectiveSprintId}
              sprintKeys={sprintKeys}
              issuePrs={issuePrs.data}
              issues={sprintIssues}
            />
          </section>
          {/* v1.16 (ADR-027): impediments log + pending-PR list for daily visibility.
            v1.20: code review auto-lists PRs linked to the current sprint. */}
          <section aria-label="Impediments">
            <ImpedimentsCard sprintId={effectiveSprintId} />
          </section>
          {/* v1.20 (ADR-031): per-person post-scrum tracking */}
          {/* <section aria-label="Post-scrum notes">
          <PostScrumCard sprintId={effectiveSprintId} boardId={selectedBoardId} />
        </section> */}

          {/* Huddle Digest — NOT filtered (ADR-008) */}
          <section aria-label="Daily huddle">
            <HuddleDigest
              data={huddle.data}
              loading={huddle.loading}
              error={huddle.error}
              onRefresh={huddle.run}
            />
          </section>
        </div>
      </div>
    </div>
  );
}
