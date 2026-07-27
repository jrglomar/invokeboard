// DevTicketPicker — the shared Dev-ticket candidate list for the Linking page's two
// v1.72 modes (ADR-083): "Link existing" (mode 2) and "New PO from Dev tasks" (mode 3).
//
// Both modes need the same thing: the chosen Dev sprint's tickets as a multi-select
// checkbox list, each row badged with the PO stories it already links to, plus an
// "unlinked only" toggle and an assignee filter (native selects — ADR-009; there is no
// free-text search anywhere in this app).
//
// The two modes differ only in what they do with an existing link, so mode 2 passes
// `renderLinkAction` to hang its Unlink control off each PO badge and mode 3 passes
// nothing. Selection state is owned by the parent (each mode resets it on its own
// schedule), which is why this component is fully controlled.

import { useId, useMemo } from "react";
import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { selectCls } from "../SprintSelect";
import { formatPoints } from "../../lib/format";
import type { IssueSummary, LinkedIssue } from "../../lib/types";

/** Sentinel for the "no assignee" filter option — same convention as AssignmentList. */
const UNASSIGNED = "__unassigned__";

export interface DevTicketPickerProps {
  issues: IssueSummary[];
  loading: boolean;
  selected: Set<string>;
  onToggle: (key: string) => void;
  /** Bulk selection replace — powers select-all / clear. */
  onSetSelected: (keys: Set<string>) => void;
  /** PO stories each Dev key already links to, from get_linked_issues(devKeys, poProjectKey). */
  poLinksByDevKey: Record<string, LinkedIssue[]>;
  linksLoading: boolean;
  unlinkedOnly: boolean;
  onUnlinkedOnlyChange: (v: boolean) => void;
  /** Display name, the UNASSIGNED sentinel, or null for "All". */
  assigneeFilter: string | null;
  onAssigneeFilterChange: (v: string | null) => void;
  /** Rendered beside each existing PO badge — mode 2 passes its Unlink control. */
  renderLinkAction?: (devKey: string, link: LinkedIssue) => React.ReactNode;
  /** Caps how many rows may be selected at once (mode 3's AI path allows 20). */
  maxSelectable?: number;
  /** Shown when there is no Dev sprint chosen yet. */
  placeholderHint?: string;
}

export function DevTicketPicker({
  issues,
  loading,
  selected,
  onToggle,
  onSetSelected,
  poLinksByDevKey,
  linksLoading,
  unlinkedOnly,
  onUnlinkedOnlyChange,
  assigneeFilter,
  onAssigneeFilterChange,
  renderLinkAction,
  maxSelectable,
  placeholderHint,
}: DevTicketPickerProps) {
  const formId = useId();

  const assigneeOpts = useMemo(() => {
    const names = new Set<string>();
    let hasUnassigned = false;
    for (const i of issues) {
      if (i.assignee) names.add(i.assignee);
      else hasUnassigned = true;
    }
    return { list: [...names].sort(), hasUnassigned };
  }, [issues]);

  const visible = useMemo(() => {
    return issues.filter((i) => {
      if (unlinkedOnly && (poLinksByDevKey[i.key] ?? []).length > 0) return false;
      if (assigneeFilter === null) return true;
      if (assigneeFilter === UNASSIGNED) return i.assignee === null;
      return i.assignee === assigneeFilter;
    });
  }, [issues, unlinkedOnly, poLinksByDevKey, assigneeFilter]);

  const allVisibleSelected =
    visible.length > 0 && visible.every((i) => selected.has(i.key));

  // A cap only bites when it would ADD rows — already-selected rows stay toggleable off.
  const atCap = maxSelectable !== undefined && selected.size >= maxSelectable;

  if (placeholderHint !== undefined) {
    return <p className="text-sm text-muted-foreground">{placeholderHint}</p>;
  }

  if (loading) {
    return (
      <div className="space-y-2">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </div>
    );
  }

  if (issues.length === 0) {
    return <p className="text-sm text-muted-foreground">No tickets in this Dev sprint.</p>;
  }

  return (
    <div className="space-y-3">
      {/* ── Filters ──────────────────────────────────────────────────────────── */}
      <div className="flex items-end gap-3 flex-wrap">
        <div className="flex flex-col gap-0.5">
          <label
            htmlFor={`${formId}-assignee`}
            className="text-xs font-semibold text-muted-foreground"
          >
            Assignee
          </label>
          <select
            id={`${formId}-assignee`}
            className={selectCls + " max-w-[180px]"}
            value={assigneeFilter ?? ""}
            onChange={(e) =>
              onAssigneeFilterChange(e.target.value === "" ? null : e.target.value)
            }
            aria-label="Filter Dev tickets by assignee"
          >
            <option value="">All</option>
            {assigneeOpts.list.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
            {assigneeOpts.hasUnassigned && <option value={UNASSIGNED}>Unassigned</option>}
          </select>
        </div>

        <label className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground self-end mb-2 cursor-pointer">
          <input
            type="checkbox"
            checked={unlinkedOnly}
            onChange={(e) => onUnlinkedOnlyChange(e.target.checked)}
            className="h-4 w-4 cursor-pointer accent-[hsl(var(--primary))]"
            aria-label="Show only Dev tickets with no PO link"
          />
          Unlinked only
        </label>

        <span
          className="text-xs text-muted-foreground self-end mb-2 whitespace-nowrap"
          aria-live="polite"
        >
          {visible.length === issues.length
            ? `${issues.length}`
            : `${visible.length} of ${issues.length}`}{" "}
          ticket{issues.length !== 1 ? "s" : ""}
          {selected.size > 0 && (
            <>
              {" · "}
              <span className="font-semibold text-foreground">{selected.size} selected</span>
            </>
          )}
        </span>

        <div className="flex gap-2 self-end mb-1 ml-auto">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            disabled={visible.length === 0}
            onClick={() =>
              onSetSelected(allVisibleSelected ? new Set() : new Set(visible.map((i) => i.key)))
            }
            aria-label={
              allVisibleSelected
                ? "Deselect all visible Dev tickets"
                : "Select all visible Dev tickets"
            }
          >
            {allVisibleSelected ? "Deselect all" : `Select all (${visible.length})`}
          </Button>
          {selected.size > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => onSetSelected(new Set())}
            >
              Clear
            </Button>
          )}
        </div>
      </div>

      {linksLoading && (
        <p className="text-xs text-muted-foreground flex items-center gap-1.5">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> Checking existing PO
          links…
        </p>
      )}

      {maxSelectable !== undefined && selected.size > maxSelectable && (
        <p className="text-xs text-warning-foreground">
          {selected.size} selected — at most {maxSelectable} can be drafted at once.
        </p>
      )}

      {/* ── Candidate list ───────────────────────────────────────────────────── */}
      {visible.length === 0 ? (
        <p className="text-sm text-muted-foreground">No Dev tickets match this filter.</p>
      ) : (
        <ul role="list" className="divide-y divide-border/50">
          {visible.map((t) => {
            const links = poLinksByDevKey[t.key] ?? [];
            const checked = selected.has(t.key);
            // Block only NEW selections once the cap is reached.
            const capBlocked = atCap && !checked;
            return (
              <li key={t.key} className="flex items-start gap-3 py-2">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={capBlocked}
                  onChange={() => onToggle(t.key)}
                  id={`${formId}-cb-${t.key}`}
                  className="mt-1 h-4 w-4 cursor-pointer accent-[hsl(var(--primary))] disabled:cursor-not-allowed disabled:opacity-50"
                  aria-label={`Select ${t.key} ${t.summary}`}
                />
                <label
                  htmlFor={`${formId}-cb-${t.key}`}
                  className="flex-1 min-w-0 cursor-pointer"
                >
                  <span className="flex items-center gap-2 flex-wrap">
                    <a
                      href={t.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono text-xs font-bold text-primary hover:underline"
                      onClick={(e) => e.stopPropagation()}
                      aria-label={`Open ${t.key} in Jira`}
                    >
                      {t.key}
                    </a>
                    {t.storyPoints != null && (
                      <span className="text-[0.6875rem] text-muted-foreground tabular-nums">
                        {formatPoints(t.storyPoints)} pts
                      </span>
                    )}
                    {t.assignee && (
                      <span className="text-[0.6875rem] text-muted-foreground">{t.assignee}</span>
                    )}
                    {links.length > 0 ? (
                      links.map((l) => (
                        <span key={l.linkId ?? l.key} className="inline-flex items-center gap-0.5">
                          <Badge
                            variant="outline"
                            className="text-[0.625rem] border-success-border text-success bg-success-bg"
                          >
                            → {l.key}
                          </Badge>
                          {renderLinkAction?.(t.key, l)}
                        </span>
                      ))
                    ) : (
                      <Badge variant="outline" className="text-[0.625rem] text-muted-foreground">
                        no PO link
                      </Badge>
                    )}
                  </span>
                  <span className="block text-sm text-foreground truncate">{t.summary}</span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
