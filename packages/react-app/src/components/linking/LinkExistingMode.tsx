// LinkExistingMode — Linking's mode 2, "Link existing" (v1.72, ADR-083). Attaches EXISTING
// Dev tickets to an EXISTING PO story (many Dev -> 1 PO) and removes wrong links.
//
// Workflow: pick a target PO story from the PO sprint (native <select>) -> pick Dev
// candidates from the Dev sprint via the shared DevTicketPicker (checkbox list,
// "unlinked only" toggle, assignee filter) -> "Link N to PO-7" loops link_dev_to_po
// sequentially through the shared bulk-run machine, live status log via BulkStatusLog.
// Each existing PO badge in the picker carries an inline two-click confirm Unlink control
// (unlink_dev_from_po). No phases here (unlike mode 1) — the picker, the Link action, and
// the status log all sit on screen together so a planner can keep linking after a run.
//
// Backend: get_active_sprint (both the PO and Dev tickets), get_linked_issues(devKeys,
// poProjectKey) (CONTRACTS.md §4.17 — the explicit poProjectKey is REQUIRED here: the tool
// defaults to filtering on the Dev project and would return [] for every key), link_dev_to_po
// (§4.31), unlink_dev_from_po (§4.32). a11y: every interactive control's accessible name
// includes the relevant ticket key; the status log is `role="status" aria-live="polite"`
// (BulkStatusLog); per-link unlink errors are `aria-live="polite"`.

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Link2, Unlink2, Loader2, AlertCircle } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { selectCls } from "../SprintSelect";
import { DevTicketPicker } from "./DevTicketPicker";
import { BulkStatusLog } from "../BulkStatusLog";
import { useBulkRun } from "../../hooks/useBulkRun";
import { useActiveSprint } from "../../hooks/useJira";
import { flattenIssues } from "../../lib/issues";
import { getLinkedIssues, linkDevToPo, unlinkDevFromPo } from "../../lib/linkClient";
import { formatPoints } from "../../lib/format";
import { useAuth } from "../../context/AuthContext";
import type { McpError } from "../../lib/mcpClient";
import type { LinkedIssue, LinkDevToPoResult } from "../../lib/types";

export interface LinkExistingModeProps {
  poBoardId?: number;
  devBoardId?: number;
  poSprintId?: number;
  devSprintId?: number;
  /** boards.po[0].projectKey — REQUIRED for the link lookup (CONTRACTS.md §4.17). */
  poProjectKey: string;
}

/** One selected Dev key queued through the shared bulk-run machine. */
interface LinkBulkItem {
  id: string;
  label: string;
  devKey: string;
}

export function LinkExistingMode({
  poBoardId,
  devBoardId,
  poSprintId,
  devSprintId,
  poProjectKey,
}: LinkExistingModeProps) {
  const formId = useId();
  const { readOnly } = useAuth();

  // ── Target PO story ──────────────────────────────────────────────────────
  const poState = useActiveSprint(poBoardId, poSprintId ?? null);
  const poTickets = useMemo(() => flattenIssues(poState.data), [poState.data]);
  const [poKey, setPoKey] = useState("");
  const chosenPo = useMemo(() => poTickets.find((t) => t.key === poKey), [poTickets, poKey]);

  // A PO story picked under one sprint means nothing once the sprint changes.
  useEffect(() => {
    setPoKey("");
  }, [poSprintId]);

  // ── Dev candidates ───────────────────────────────────────────────────────
  const devState = useActiveSprint(devBoardId, devSprintId ?? null);
  const devTickets = useMemo(() => flattenIssues(devState.data), [devState.data]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [unlinkedOnly, setUnlinkedOnly] = useState(true);
  const [assigneeFilter, setAssigneeFilter] = useState<string | null>(null);

  useEffect(() => {
    setSelected(new Set());
  }, [devSprintId]);

  const toggle = useCallback((key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // ── Existing PO<->Dev links, keyed by Dev key ───────────────────────────
  // get_linked_issues(devKeys, poProjectKey) — poProjectKey MUST be sent explicitly
  // (CONTRACTS.md §4.17): the default filters on the Dev project and would return []
  // for every key here. Cancellation flag + request guard (same pattern as
  // useIssuePullRequests/useLinkedIssues in hooks/useJira.ts) so an out-of-order
  // response from a stale Dev-sprint selection can't clobber newer state. The PO
  // story card's "current Dev links" is derived from this SAME map (reverse-indexed
  // by poKey below) so one refetch keeps both the picker's badges and the PO card in
  // sync after a write.
  const [linksByDevKey, setLinksByDevKey] = useState<Record<string, LinkedIssue[]>>({});
  const [linksLoading, setLinksLoading] = useState(false);
  const reqId = useRef(0);
  const devKeysKey = useMemo(() => [...devTickets.map((t) => t.key)].sort().join(","), [devTickets]);

  const refetchLinks = useCallback(() => {
    const keys = devKeysKey ? devKeysKey.split(",") : [];
    if (keys.length === 0) {
      setLinksByDevKey({});
      return;
    }
    const myReq = ++reqId.current;
    setLinksLoading(true);
    getLinkedIssues(keys, poProjectKey)
      .then((res) => {
        if (myReq !== reqId.current) return;
        setLinksByDevKey(res.links);
        setLinksLoading(false);
      })
      .catch(() => {
        if (myReq !== reqId.current) return;
        setLinksByDevKey({});
        setLinksLoading(false);
      });
  }, [devKeysKey, poProjectKey]);

  useEffect(() => {
    refetchLinks();
  }, [refetchLinks]);

  // The chosen PO story's own current Dev links — a reverse lookup over the same map
  // (scoped to the currently loaded Dev sprint's candidates, same scope as the picker).
  const poCurrentLinks = useMemo(() => {
    if (!poKey) return [];
    const out: Array<{ devKey: string; link: LinkedIssue }> = [];
    for (const [devKey, links] of Object.entries(linksByDevKey)) {
      const link = links.find((l) => l.key === poKey);
      if (link) out.push({ devKey, link });
    }
    return out;
  }, [linksByDevKey, poKey]);

  // ── Link N to PO-7 (sequential bulk-run, shared with modes 1/3) ─────────
  const bulk = useBulkRun<LinkBulkItem, LinkDevToPoResult>((item) => linkDevToPo(poKey, item.devKey));

  async function handleLink() {
    const items: LinkBulkItem[] = [...selected].map((devKey) => ({ id: devKey, label: devKey, devKey }));
    if (items.length === 0) return;
    await bulk.run(items);
    // One refetch after the run refreshes every row's badge + link id (CONTRACTS §4.31).
    refetchLinks();
  }

  async function handleRetry() {
    await bulk.retryFailed();
    refetchLinks();
  }

  return (
    <div className="space-y-4">
      {readOnly && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" aria-hidden="true" />
          <AlertDescription>
            You're using shared credentials in read-only mode — linking and unlinking are
            disabled here. Connect your own Jira account to make changes.
          </AlertDescription>
        </Alert>
      )}

      {/* ── Target PO story ─────────────────────────────────────────────── */}
      <Card className="shadow-sm">
        <CardHeader className="pb-2">
          <h3 className="text-base font-semibold flex items-center gap-2">
            <Link2 className="h-4 w-4 text-primary" aria-hidden="true" /> Target PO story
          </h3>
        </CardHeader>
        <CardContent className="space-y-3">
          {poSprintId === undefined ? (
            <p className="text-sm text-muted-foreground">
              Pick a PO sprint above to choose a target story.
            </p>
          ) : poState.loading ? (
            <Skeleton className="h-9 w-64" />
          ) : (
            <>
              <div className="space-y-1">
                <Label htmlFor={`${formId}-po-story`} className="text-xs font-semibold">
                  Target PO story
                </Label>
                <select
                  id={`${formId}-po-story`}
                  className={selectCls}
                  value={poKey}
                  onChange={(e) => setPoKey(e.target.value)}
                  aria-label="Target PO story"
                >
                  <option value="">Select a PO story…</option>
                  {poTickets.map((t) => (
                    <option key={t.key} value={t.key}>
                      {t.key} — {t.summary}
                    </option>
                  ))}
                </select>
              </div>

              {chosenPo && (
                <div className="rounded-md border border-border bg-muted/20 p-3 text-sm space-y-1.5">
                  <p className="flex items-center gap-2">
                    <span className="font-mono font-semibold">{chosenPo.key}</span>
                    {chosenPo.storyPoints != null && (
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {formatPoints(chosenPo.storyPoints)} pts
                      </span>
                    )}
                  </p>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs text-muted-foreground">Current Dev links:</span>
                    {devSprintId === undefined ? (
                      <span className="text-xs text-muted-foreground">
                        pick a Dev sprint to see existing links
                      </span>
                    ) : linksLoading ? (
                      <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" aria-hidden="true" />
                    ) : poCurrentLinks.length === 0 ? (
                      <span className="text-xs text-muted-foreground">none</span>
                    ) : (
                      poCurrentLinks.map(({ devKey, link }) => (
                        <Badge
                          key={link.linkId ?? devKey}
                          variant="outline"
                          className="text-[0.625rem] border-success-border text-success bg-success-bg"
                        >
                          → {devKey}
                        </Badge>
                      ))
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* ── Dev candidates ───────────────────────────────────────────────── */}
      <Card className="shadow-sm">
        <CardHeader className="pb-2">
          <h3 className="text-base font-semibold">Dev candidates</h3>
        </CardHeader>
        <CardContent>
          <DevTicketPicker
            issues={devTickets}
            loading={devState.loading}
            selected={selected}
            onToggle={toggle}
            onSetSelected={setSelected}
            poLinksByDevKey={linksByDevKey}
            linksLoading={linksLoading}
            unlinkedOnly={unlinkedOnly}
            onUnlinkedOnlyChange={setUnlinkedOnly}
            assigneeFilter={assigneeFilter}
            onAssigneeFilterChange={setAssigneeFilter}
            placeholderHint={
              devSprintId === undefined ? "Pick a Dev sprint above to list its tickets." : undefined
            }
            renderLinkAction={(devKey, link) => (
              <UnlinkControl devKey={devKey} link={link} readOnly={readOnly} onUnlinked={refetchLinks} />
            )}
          />

          <div className="mt-4 flex items-center gap-3">
            <Button
              type="button"
              onClick={() => void handleLink()}
              disabled={!poKey || selected.size === 0 || bulk.running || readOnly}
            >
              Link {selected.size} to {poKey || "…"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ── Live status log ──────────────────────────────────────────────── */}
      {bulk.rows.length > 0 && (
        <BulkStatusLog
          rows={bulk.rows}
          running={bulk.running}
          title={{ running: `Linking to ${poKey}…`, done: "linked" }}
          renderOk={(row) => {
            const d = row.detail;
            if (!d) return <span className="text-success">linked</span>;
            if (d.alreadyLinked) {
              return (
                <span className="text-muted-foreground">
                  already linked{d.reversed ? " (reversed link)" : ""}
                  {d.precheckWarning && (
                    <span className="text-warning-foreground"> · {d.precheckWarning}</span>
                  )}
                </span>
              );
            }
            return (
              <span className="text-success">
                linked → {d.poKey}
                {d.precheckWarning && (
                  <span className="text-warning-foreground"> · {d.precheckWarning}</span>
                )}
              </span>
            );
          }}
          onRetry={() => void handleRetry()}
          onReset={() => {
            bulk.reset();
            setSelected(new Set());
          }}
        />
      )}
    </div>
  );
}

// ── UnlinkControl — inline two-click confirm (no modal; ConfirmActionDialog is bound to a
// different type and there's no ui/alert-dialog) ────────────────────────────────────────
interface UnlinkControlProps {
  devKey: string;
  link: LinkedIssue;
  readOnly: boolean;
  /** Called once the DELETE succeeds — the caller refetches links. */
  onUnlinked: () => void;
}

const ARM_TIMEOUT_MS = 4000;

function UnlinkControl({ devKey, link, readOnly, onUnlinked }: UnlinkControlProps) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const disarm = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setArmed(false);
  }, []);

  // Clean up the auto-disarm timer on unmount (e.g. the row disappears after a refetch).
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  async function handleClick() {
    if (!armed) {
      setArmed(true);
      timerRef.current = setTimeout(disarm, ARM_TIMEOUT_MS);
      return;
    }
    disarm();
    if (!link.linkId) return; // guarded by `disabled` below; never issue a DELETE without an id
    setBusy(true);
    setError(null);
    try {
      await unlinkDevFromPo({ linkId: link.linkId, poKey: link.key, devKey });
      onUnlinked();
    } catch (err: unknown) {
      const e = err as McpError;
      setError(e.message ?? String(err));
    } finally {
      // Clear busy even on success: the refetch normally unmounts this row, but if the
      // link is still listed (e.g. an alreadyGone result) a stuck spinner would be a lie.
      setBusy(false);
    }
  }

  const disabled = readOnly || !link.linkId || busy;

  return (
    <span className="inline-flex items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={`h-5 px-1 gap-0.5 text-[0.625rem] ${armed ? "text-destructive hover:text-destructive" : "text-muted-foreground"}`}
        disabled={disabled}
        onClick={() => void handleClick()}
        onBlur={disarm}
        title={
          !link.linkId
            ? "This link's id isn't loaded yet — refresh the page to unlink."
            : undefined
        }
        aria-label={armed ? `Confirm unlink ${devKey} from ${link.key}` : `Unlink ${devKey} from ${link.key}`}
      >
        {busy ? (
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
        ) : (
          <Unlink2 className="h-3 w-3" aria-hidden="true" />
        )}
        {armed && !busy && "confirm?"}
      </Button>
      {error && (
        <span aria-live="polite" className="text-[0.625rem] text-destructive">
          {error}
        </span>
      )}
    </span>
  );
}
