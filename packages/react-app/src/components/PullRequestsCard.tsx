// PullRequestsCard — Huddle code-review PR list.
// Auto (v1.22, ADR-034): PRs linked to the current sprint's tickets, read from Jira's Development
//   panel via get_issue_pull_requests — MULTI-REPO, ALL states (open/merged/closed), with approval
//   status; still-open sorted first, merged/closed labelled. (Supersedes the v1.20 single-repo
//   GitHub source.) Manual: a per-sprint list of PR links (usePullRequests).
// By person (v1.73, ADR-084): an opt-in "By Status / By Person" toggle — mirrors HuddleDigest's
//   ViewToggle markup/a11y. Groups auto-linked PRs by the Jira ASSIGNEE of the ticket each PR is
//   linked to (never the GitHub author — see prsByPerson.ts header). Default view is unchanged
//   (by status); the toggle only renders when the caller passes a non-empty `issues` list.

import { useState, useMemo } from "react";
import { GitPullRequest, Plus, X, ExternalLink, Sparkles, CheckCircle2, XCircle, Clock } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { usePullRequests, useIssuePullRequests } from "../hooks/useJira";
import { useCollapse } from "../hooks/useCollapse";
import { CollapseToggle } from "./CollapseToggle";
import { groupPrsByAssignee, STATUS_RANK, type PrPersonGroup } from "../lib/prsByPerson";
import type { PullRequestInput } from "../lib/prsClient";
import type { IssueSummary, LinkedPr } from "../lib/types";

/** Small approval-status badge for a linked PR (v1.21/v1.22). */
function ReviewBadge({ status }: { status: Pick<LinkedPr, "decision" | "approvals" | "reviewers"> | undefined }) {
  if (!status) return null;
  if (status.decision === "approved") {
    return (
      <span className="inline-flex items-center gap-0.5 text-[0.6875rem] font-medium text-success flex-shrink-0"
        title={status.reviewers.length ? `Approved by ${status.reviewers.join(", ")}` : "Approved"}>
        <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
        Approved{status.approvals > 1 ? ` ·${status.approvals}` : ""}
      </span>
    );
  }
  if (status.decision === "changes_requested") {
    return (
      <span className="inline-flex items-center gap-0.5 text-[0.6875rem] font-medium text-destructive flex-shrink-0"
        title="Changes requested">
        <XCircle className="h-3 w-3" aria-hidden="true" />
        Changes
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-0.5 text-[0.6875rem] font-medium text-warning flex-shrink-0"
      title="Review required">
      <Clock className="h-3 w-3" aria-hidden="true" />
      Review
    </span>
  );
}

/** Right-side status for a linked PR: approval badge while open, else a Merged/Closed pill. */
function StatusIndicator({ pr }: { pr: LinkedPr }) {
  if (pr.status === "merged") {
    return (
      <span className="inline-flex items-center text-[0.6875rem] font-medium px-1 rounded bg-muted text-muted-foreground flex-shrink-0" title="Merged">
        Merged
      </span>
    );
  }
  if (pr.status === "declined") {
    return (
      <span className="inline-flex items-center text-[0.6875rem] font-medium px-1 rounded bg-muted text-muted-foreground flex-shrink-0" title="Closed without merging">
        Closed
      </span>
    );
  }
  // open / unknown → show the approval status
  return <ReviewBadge status={pr} />;
}

/** Best-effort short label for a PR URL (…/owner/repo/pull/123 → repo#123). */
function prLabel(url: string): string {
  const m = url.match(/github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/i);
  if (m) return `${m[1]}#${m[2]}`;
  try { return new URL(url).pathname.replace(/^\//, "") || url; } catch { return url; }
}

/**
 * One auto-linked PR row — shared by the flat "By status" list and each person's group in
 * "By person" (v1.73). Do NOT fork this markup a second time.
 */
function LinkedPrRow({ pr }: { pr: LinkedPr }) {
  return (
    <li className="flex items-center gap-1.5 text-sm">
      <Sparkles className="h-3 w-3 text-primary flex-shrink-0" aria-label="Linked to a sprint ticket" />
      <a
        href={pr.url}
        target="_blank"
        rel="noopener noreferrer"
        className="flex-1 min-w-0 truncate text-primary hover:underline inline-flex items-center gap-1"
        title={pr.repo ? `${pr.repo} — ${pr.title}` : pr.title}
      >
        <span className="truncate">{pr.title}</span>
        <ExternalLink className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
      </a>
      <StatusIndicator pr={pr} />
      {pr.repo && (
        <span className="font-mono text-[0.6875rem] text-muted-foreground flex-shrink-0 truncate max-w-[80px]" title={pr.repo}>
          {pr.repo.split("/").pop()}
        </span>
      )}
    </li>
  );
}

// ── By person view (v1.73, ADR-084) ──────────────────────────────────────────

type PrView = "by_status" | "by_person";

/** By Status / By Person segmented toggle — mirrors HuddleDigest's ViewToggle markup/a11y. */
function PrViewToggle({ view, onChange }: { view: PrView; onChange: (v: PrView) => void }) {
  return (
    // a11y: role="group" with label; each button uses aria-pressed
    <div
      role="group"
      aria-label="Pull request grouping"
      className="flex rounded-md border border-border overflow-hidden text-xs"
    >
      <button
        type="button"
        role="tab"
        aria-pressed={view === "by_status"}
        aria-selected={view === "by_status"}
        onClick={() => onChange("by_status")}
        className={cn(
          "px-2.5 py-1 font-semibold transition-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
          view === "by_status"
            ? "bg-primary text-primary-foreground"
            : "bg-background text-muted-foreground hover:text-foreground hover:bg-muted/50"
        )}
      >
        By Status
      </button>
      <button
        type="button"
        role="tab"
        aria-pressed={view === "by_person"}
        aria-selected={view === "by_person"}
        onClick={() => onChange("by_person")}
        className={cn(
          "px-2.5 py-1 font-semibold transition-card border-l border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
          view === "by_person"
            ? "bg-primary text-primary-foreground"
            : "bg-background text-muted-foreground hover:text-foreground hover:bg-muted/50"
        )}
      >
        By Person
      </button>
    </div>
  );
}

/** One assignee's group of linked PRs — initials chip + name + count, then their PR rows. */
function PrPersonGroupSection({ group }: { group: PrPersonGroup }) {
  return (
    <section className="mb-2">
      <div className="flex items-center gap-1.5 mb-1 pb-0.5 border-b border-border">
        <span
          className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-primary/10 text-primary text-[0.625rem] font-bold flex-shrink-0"
          aria-hidden="true"
        >
          {group.initials}
        </span>
        <h4 className="text-xs font-semibold text-foreground uppercase tracking-wide flex-1 min-w-0 truncate">
          {group.person}
        </h4>
        <span className="text-[0.6875rem] text-muted-foreground flex-shrink-0">({group.prs.length})</span>
      </div>
      <ul className="space-y-1" role="list" aria-label={`${group.person} pull requests`}>
        {group.prs.map(({ pr }) => (
          <LinkedPrRow key={pr.url} pr={pr} />
        ))}
      </ul>
    </section>
  );
}

export function PullRequestsCard({
  sprintId,
  sprintKeys,
  issuePrs: issuePrsProp,
  issues,
}: {
  sprintId: number | null;
  /** Current sprint's ticket keys — auto-PRs are filtered to these (v1.20). */
  sprintKeys?: string[];
  /** v1.27 (ADR-039): linked PRs lifted by the parent (Dashboard) to skip a duplicate fetch. */
  issuePrs?: Record<string, LinkedPr[]>;
  /**
   * v1.73 (ADR-084): the current sprint's issues — enables the "By Person" view, which
   * attributes each auto-linked PR to the Jira ASSIGNEE of the ticket it's linked to. Absent
   * or empty → the By Status / By Person toggle doesn't render (by-status stays the only view).
   */
  issues?: IssueSummary[];
}) {
  const { data, loading, error, save } = usePullRequests(sprintId);
  // v1.22 (ADR-034): linked PRs across ALL repos, from Jira's Development panel.
  // v1.27: when the parent supplies the map, don't fetch again (pass [] to the hook).
  const hookPrs = useIssuePullRequests(issuePrsProp ? [] : (sprintKeys ?? []));
  const issuePrs = issuePrsProp ?? hookPrs.data;
  const [url, setUrl] = useState("");
  const [ticketKey, setTicketKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [collapsed, toggleCollapsed] = useCollapse("codeReview");
  // v1.73: default view is unchanged (by status) — by-person is opt-in.
  const [view, setView] = useState<PrView>("by_status");

  const items = data ?? [];

  // Auto-PRs: flatten linked PRs across the sprint's tickets (ALL states — open, merged, closed),
  // dedupe by URL, drop any already tracked manually, and sort still-open ones first.
  const autoPrs = useMemo(() => {
    const manualUrls = new Set(items.map((p) => p.url));
    const seen = new Set<string>();
    const out: LinkedPr[] = [];
    for (const list of Object.values(issuePrs)) {
      for (const pr of list) {
        if (manualUrls.has(pr.url) || seen.has(pr.url)) continue;
        seen.add(pr.url);
        out.push(pr);
      }
    }
    return out.sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status]);
  }, [issuePrs, items]);

  // v1.73 (ADR-084): the same auto-PRs (manual ones excluded, same as autoPrs above), grouped by
  // the Jira assignee of the linked ticket instead of flattened by status.
  const showPersonToggle = !!issues && issues.length > 0;
  const personGroups = useMemo(() => {
    if (!showPersonToggle) return [] as PrPersonGroup[];
    const manualUrls = new Set(items.map((p) => p.url));
    const filtered: Record<string, LinkedPr[]> = {};
    for (const [key, prs] of Object.entries(issuePrs)) {
      const kept = prs.filter((pr) => !manualUrls.has(pr.url));
      if (kept.length > 0) filtered[key] = kept;
    }
    return groupPrsByAssignee(issues!, filtered);
  }, [showPersonToggle, issues, issuePrs, items]);

  const totalCount = autoPrs.length + items.length;

  async function persist(next: PullRequestInput[]) {
    setBusy(true);
    try { await save(next); } catch { /* hook reverts on error */ } finally { setBusy(false); }
  }

  async function add() {
    const u = url.trim();
    if (!u || sprintId === null) return;
    const next: PullRequestInput[] = [
      ...items,
      { url: u, ...(ticketKey.trim() ? { ticketKey: ticketKey.trim() } : {}) },
    ];
    setUrl("");
    setTicketKey("");
    await persist(next);
  }

  const remove = (id: string) => void persist(items.filter((p) => p.id !== id));

  return (
    <Card className="shadow-sm">
      <CardHeader className="px-3 pt-3 pb-1.5">
        <h3 className="text-sm font-semibold text-foreground">
          <CollapseToggle collapsed={collapsed} onToggle={toggleCollapsed} className="w-full">
            <GitPullRequest className="h-3.5 w-3.5 text-primary shrink-0" aria-hidden="true" />
            Code review
            {totalCount > 0 && (
              <span className="text-xs font-normal text-muted-foreground">({totalCount})</span>
            )}
          </CollapseToggle>
        </h3>
      </CardHeader>
      {!collapsed && (
      <CardContent className="px-3 pb-3 space-y-2">
        {sprintId === null ? (
          <p className="text-sm text-muted-foreground">Select a sprint to track pending PRs.</p>
        ) : (
          <>
            {/* v1.73 (ADR-084): By Status / By Person toggle — only when the caller has issues to group by */}
            {showPersonToggle && (
              <div className="flex justify-end">
                <PrViewToggle view={view} onChange={setView} />
              </div>
            )}

            {view === "by_status" ? (
              /* Auto-linked PRs (current sprint, multi-repo via Jira Development panel) */
              autoPrs.length > 0 && (
                <ul className="space-y-1" role="list" aria-label="Linked pull requests">
                  {autoPrs.map((pr) => (
                    <LinkedPrRow key={pr.url} pr={pr} />
                  ))}
                </ul>
              )
            ) : (
              /* By Person (v1.73, ADR-084) */
              personGroups.length > 0 && (
                <div aria-label="Pull requests by person">
                  {personGroups.map((group) => (
                    <PrPersonGroupSection key={group.person} group={group} />
                  ))}
                </div>
              )
            )}

            {/* Add form (manual) */}
            <div className="flex items-center gap-1.5 flex-wrap">
              <div className="flex-1 min-w-[140px]">
                <label htmlFor="pr-url" className="sr-only">Pull request URL</label>
                <Input
                  id="pr-url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void add(); }}
                  placeholder="Paste a PR link…"
                  className="h-8"
                  aria-label="Pull request URL"
                />
              </div>
              <div className="w-20">
                <label htmlFor="pr-key" className="sr-only">Related ticket key</label>
                <Input
                  id="pr-key"
                  value={ticketKey}
                  onChange={(e) => setTicketKey(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void add(); }}
                  placeholder="KEY?"
                  className="h-8"
                  aria-label="Related ticket key (optional)"
                />
              </div>
              <Button type="button" size="sm" className="h-8" onClick={() => void add()} disabled={busy || !url.trim()}>
                <Plus className="h-4 w-4" aria-hidden="true" />
                <span className="sr-only">Add pull request</span>
              </Button>
            </div>

            {error && <p className="text-xs text-destructive" role="alert">{error.message}</p>}
            {loading && items.length === 0 && <p className="text-xs text-muted-foreground">Loading…</p>}

            {/* Manual list */}
            {items.length > 0 && (
              <ul className="space-y-1" role="list" aria-label="Manual pull requests">
                {items.map((pr) => (
                  <li key={pr.id} className="flex items-center gap-1.5 text-sm">
                    <a
                      href={pr.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex-1 min-w-0 truncate text-primary hover:underline inline-flex items-center gap-1"
                      aria-label={`Open pull request ${prLabel(pr.url)} in a new tab`}
                      title={pr.url}
                    >
                      <span className="font-mono text-xs truncate">{pr.title ?? prLabel(pr.url)}</span>
                      <ExternalLink className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
                    </a>
                    {pr.ticketKey && (
                      <span className="font-mono text-[0.6875rem] text-muted-foreground flex-shrink-0">{pr.ticketKey}</span>
                    )}
                    <button
                      type="button"
                      onClick={() => remove(pr.id)}
                      className="text-muted-foreground hover:text-destructive focus:outline-none focus:ring-1 focus:ring-ring rounded flex-shrink-0"
                      aria-label={`Remove PR ${prLabel(pr.url)}`}
                    >
                      <X className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {totalCount === 0 && !loading && (
              <p className="text-sm text-muted-foreground">No linked PRs for this sprint.</p>
            )}
          </>
        )}
      </CardContent>
      )}
    </Card>
  );
}
