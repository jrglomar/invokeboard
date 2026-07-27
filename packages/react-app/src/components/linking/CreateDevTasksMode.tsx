// CreateDevTasksMode — Linking's mode 1, "Create Dev tasks" (v1.11, ADR-022; extracted
// verbatim from pages/Linking.tsx into its own component in v1.72, ADR-083, when Linking
// became a 3-mode shell). Unchanged behaviour: bulk-create Dev tasks for existing PO
// stories.
//
// Workflow: pick a PO sprint + a target Dev sprint (both live in the shell) → multi-select
// PO tickets (each showing its existing linked Dev ticket, "one or none") → generate an AI
// plan (one Dev draft per PO) → review/edit → "Create all" with a live status log.
//
// Backend: get_linked_issues (existing links), POST /api/ai/plan-dev-tickets (the
// plan), create_dev_ticket (looped client-side for per-item ✓/✗). a11y: labeled
// checkboxes/selects, aria-live status log.

import { useState, useEffect, useId, useMemo, useCallback } from "react";
import {
  Sparkles, Loader2, CheckCircle2, XCircle, ExternalLink, ListChecks, AlertCircle,
  Plus, Trash2,
} from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { selectCls } from "../SprintSelect";
import { useActiveSprint, useTeamMembers, createLinkedDevTicket } from "../../hooks/useJira";
import { getLinkedIssues, getIssueDescriptions } from "../../lib/linkClient";
import { aiPlanDevTickets } from "../../lib/aiClient";
import { RefineDraftControl } from "../RefineDraftControl";
import { buildDraftPair } from "../../lib/ticketTemplates";
import { suggestBreakdown } from "../../lib/points";
import { formatPoints } from "../../lib/format";
import { flattenIssues } from "../../lib/issues";
import { capDesc } from "../../lib/poRollup";
import type { McpError } from "../../lib/mcpClient";
import type {
  LinkedIssue, PlanDevTicketItem, PlanRow, AiStatus,
} from "../../lib/types";

type Phase = "select" | "plan" | "creating" | "done";

interface RowResult {
  id: string;
  poKey: string;
  status: "pending" | "ok" | "error";
  devKey?: string;
  devUrl?: string;
  linkedTo?: string;
  linkWarning?: string;
  sprintWarning?: string;
  assignWarning?: string;
  error?: string;
}

// v1.36 (ADR-046): a stable row id — a PO story may expand into up to two Dev-task
// rows, so poKey is no longer unique. Monotonic across the session.
let _rowSeq = 0;
const newRowId = (poKey: string): string => `${poKey}#${(++_rowSeq).toString(36)}`;

/**
 * How a PO story's points break into Dev-task estimates (v1.36, ADR-046):
 * unestimated / ≤ 0 → one unestimated task; else the point-scale breakdown
 * (a single allowed value stays one task; 4→[2,2], 6→[3,3], 8→[3,5], …).
 */
function breakdownFor(points: number | null | undefined): (number | null)[] {
  if (points == null || points <= 0) return [null];
  const parts = suggestBreakdown(points);
  return parts.length > 0 ? parts : [points];
}

export interface CreateDevTasksModeProps {
  poBoardId?: number;
  devBoardId?: number;
  poSprintId?: number;
  devSprintId?: number;
  devSprintName?: string;
  aiStatus: AiStatus;
}

export function CreateDevTasksMode({
  poBoardId, devBoardId, poSprintId, devSprintId, devSprintName, aiStatus,
}: CreateDevTasksModeProps) {
  const formId = useId();
  // v1.36 (ADR-046): Dev-board roster powers the per-task assignee picker.
  const devTeam = useTeamMembers(devBoardId ?? null);

  const poTicketsState = useActiveSprint(poBoardId, poSprintId ?? null);
  const poTickets = useMemo(() => flattenIssues(poTicketsState.data), [poTicketsState.data]);

  // Existing PO→Dev links (badged in the list)
  const [linksMap, setLinksMap] = useState<Record<string, LinkedIssue[]>>({});
  const [linksLoading, setLinksLoading] = useState(false);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [phase, setPhase] = useState<Phase>("select");
  const [plan, setPlan] = useState<PlanRow[]>([]);
  // v1.14: fetched PO descriptions (by key), reused by Generate + per-draft Regenerate.
  const [descMap, setDescMap] = useState<Record<string, string>>({});
  const [aiNote, setAiNote] = useState<string | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [results, setResults] = useState<RowResult[]>([]);

  function reset() {
    setPhase("select");
    setPlan([]);
    setDescMap({});
    setResults([]);
    setAiNote(null);
    setPlanError(null);
  }

  // v1.72 (ADR-083): the shell no longer owns flow state — this mode resets its own
  // phase/plan/results whenever the PO sprint changes (unchanged behaviour: changing
  // the Dev sprint does NOT reset the flow).
  useEffect(() => {
    reset();
  }, [poSprintId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch existing Dev links for the PO sprint's tickets; default-select the
  // tickets WITHOUT a Dev link (the natural bulk-create candidates).
  useEffect(() => {
    if (poSprintId == null || poTickets.length === 0) {
      setLinksMap({});
      setSelected(new Set());
      return;
    }
    const keys = poTickets.map((t) => t.key);
    let cancelled = false;
    setLinksLoading(true);
    getLinkedIssues(keys)
      .then((res) => {
        if (cancelled) return;
        setLinksMap(res.links);
        const withoutLink = keys.filter((k) => (res.links[k] ?? []).length === 0);
        setSelected(new Set(withoutLink));
      })
      .catch(() => {
        if (!cancelled) { setLinksMap({}); setSelected(new Set(keys)); }
      })
      .finally(() => { if (!cancelled) setLinksLoading(false); });
    return () => { cancelled = true; };
  }, [poSprintId, poTickets]);

  const toggle = useCallback((key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  const linklessKeys = useMemo(
    () => poTickets.filter((t) => (linksMap[t.key] ?? []).length === 0).map((t) => t.key),
    [poTickets, linksMap]
  );

  // ── Generate the plan (AI, or deterministic template fallback) ───────────────
  async function handleGenerate() {
    const chosen = poTickets.filter((t) => selected.has(t.key));
    if (chosen.length === 0) return;
    setGenerating(true);
    setPlanError(null);
    setAiNote(null);

    // v1.14 (ADR-025): pull each selected PO's own description so the Dev task is drafted
    // from real acceptance criteria/scope, not just the one-line summary. Non-fatal.
    let descByKey: Record<string, string> = {};
    try {
      const res = await getIssueDescriptions(chosen.map((t) => t.key));
      descByKey = res.descriptions;
    } catch {
      descByKey = {};
    }
    setDescMap(descByKey);
    const descOf = (key: string) => capDesc(descByKey[key] ?? "");

    // v1.30 (ADR-042): the Dev task KEEPS the PO story's title (the AI only enhances the
    // description). v1.36 (ADR-046): each PO expands into 1–2 Dev-task ROWS by its point
    // breakdown, each row carrying its own editable points (and, later, assignee).
    const expand = (items: PlanDevTicketItem[]): PlanRow[] =>
      items.flatMap((it) => {
        const po = chosen.find((t) => t.key === it.poKey);
        const summary = po?.summary ?? it.devSummary;
        const parts = breakdownFor(po?.storyPoints ?? null);
        const n = parts.length;
        return parts.map((pts, idx) => ({
          id: newRowId(it.poKey),
          poKey: it.poKey,
          devSummary: summary,
          devDescription:
            n > 1 ? `${it.devDescription}\n\n_(Part ${idx + 1} of ${n})_` : it.devDescription,
          storyPoints: pts,
        }));
      });

    const fallback = (): PlanDevTicketItem[] =>
      chosen.map((t) => {
        const d = buildDraftPair(t.summary).dev;
        const src = descOf(t.key);
        const devDescription = src
          ? `## Source PO story (${t.key})\n\n${src}\n\n${d.description}`
          : d.description;
        return { poKey: t.key, devSummary: d.summary, devDescription };
      });

    try {
      if (aiStatus.enabled) {
        const res = await aiPlanDevTickets({
          poStories: chosen.map((t) => {
            const description = descOf(t.key);
            return description
              ? { key: t.key, summary: t.summary, description }
              : { key: t.key, summary: t.summary };
          }),
        });
        // Reconcile to the selection by poKey; fall back per-PO for any omission.
        const byKey = new Map(res.items.map((i) => [i.poKey, i]));
        const items: PlanDevTicketItem[] = chosen.map((t) => {
          const it = byKey.get(t.key);
          if (it) return it;
          const d = buildDraftPair(t.summary).dev;
          return { poKey: t.key, devSummary: d.summary, devDescription: d.description };
        });
        setPlan(expand(items));
        setAiNote(res.assistantMessage);
      } else {
        setPlan(expand(fallback()));
        setAiNote("AI is off — drafted from local templates. Edit each task before creating.");
      }
      setPhase("plan");
    } catch (err: unknown) {
      // AI error/unavailable → deterministic fallback so the workflow never blocks
      const e = err as McpError;
      setPlan(expand(fallback()));
      setAiNote(
        e.code === "AI_UNAVAILABLE"
          ? "AI is off — drafted from local templates. Edit each task before creating."
          : `AI error (${e.code ?? "UNKNOWN"}) — drafted from local templates instead.`
      );
      setPhase("plan");
    } finally {
      setGenerating(false);
    }
  }

  function editRow(id: string, patch: Partial<PlanRow>) {
    setPlan((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }

  // v1.36 (ADR-046): manually add / remove a Dev-task row within a PO group.
  function addRow(poKey: string) {
    setPlan((prev) => {
      const sibling = prev.find((p) => p.poKey === poKey);
      const row: PlanRow = {
        id: newRowId(poKey),
        poKey,
        devSummary: sibling?.devSummary ?? poKey,
        devDescription: sibling?.devDescription ?? "",
        storyPoints: null,
      };
      const lastIdx = prev.map((p) => p.poKey).lastIndexOf(poKey);
      return lastIdx === -1
        ? [...prev, row]
        : [...prev.slice(0, lastIdx + 1), row, ...prev.slice(lastIdx + 1)];
    });
  }

  function removeRow(id: string) {
    setPlan((prev) => {
      const row = prev.find((p) => p.id === id);
      if (!row) return prev;
      // keep at least one Dev task per PO story
      if (prev.filter((p) => p.poKey === row.poKey).length <= 1) return prev;
      return prev.filter((p) => p.id !== id);
    });
  }

  // ── Regenerate one plan item from a reviewer comment (v1.12, ADR-023) ────────
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null);
  async function regenerateRow(id: string, comment: string) {
    const current = plan.find((p) => p.id === id);
    const po = current ? poTickets.find((t) => t.key === current.poKey) : undefined;
    if (!po || !current) return;
    setRegeneratingId(id);
    try {
      const instructions =
        `A reviewer left this comment on the current Dev task draft: "${comment}". ` +
        `Current draft summary: "${current.devSummary}". ` +
        `Current draft description:\n${current.devDescription}\n\n` +
        `Rewrite the Dev task to address the comment, keeping what still applies.`;
      const description = capDesc(descMap[po.key] ?? "");
      const res = await aiPlanDevTickets({
        poStories: [
          description
            ? { key: po.key, summary: po.summary, description }
            : { key: po.key, summary: po.summary },
        ],
        instructions,
      });
      const item = res.items.find((i) => i.poKey === po.key) ?? res.items[0];
      // v1.30 (ADR-042): keep the PO title — regenerate only refreshes the description.
      if (item) editRow(id, { devDescription: item.devDescription });
    } catch {
      // Keep the current draft on failure — non-fatal.
    } finally {
      setRegeneratingId(null);
    }
  }

  // ── Bulk create (sequential so the log streams + we don't hammer Jira) ────────
  async function handleCreateAll() {
    setPhase("creating");
    setResults(plan.map((p) => ({ id: p.id, poKey: p.poKey, status: "pending" as const })));
    for (const item of plan) {
      try {
        const dev = await createLinkedDevTicket({
          summary: item.devSummary.trim() || item.poKey,
          description: item.devDescription,
          linkedPoTicketKey: item.poKey,
          storyPoints: item.storyPoints ?? undefined,
          ...(item.assigneeAccountId ? { assigneeAccountId: item.assigneeAccountId } : {}),
          ...(devSprintId !== undefined ? { sprintId: devSprintId } : {}),
        });
        setResults((prev) => prev.map((r) => r.id === item.id ? {
          id: item.id, poKey: item.poKey, status: "ok", devKey: dev.key, devUrl: dev.url,
          linkedTo: dev.linkedTo, linkWarning: dev.linkWarning, sprintWarning: dev.sprintWarning,
          assignWarning: dev.assignWarning,
        } : r));
      } catch (err: unknown) {
        const e = err as McpError;
        setResults((prev) => prev.map((r) => r.id === item.id ? {
          id: item.id, poKey: item.poKey, status: "error", error: e.message ?? String(err),
        } : r));
      }
    }
    setPhase("done");
  }

  // v1.13 P0: re-run ONLY the rows that failed (by poKey), leaving successes alone.
  async function handleRetryFailed() {
    const failed = new Set(results.filter((r) => r.status === "error").map((r) => r.id));
    if (failed.size === 0) return;
    setPhase("creating");
    setResults((prev) => prev.map((r) => failed.has(r.id) ? { ...r, status: "pending" } : r));
    for (const item of plan) {
      if (!failed.has(item.id)) continue;
      try {
        const dev = await createLinkedDevTicket({
          summary: item.devSummary.trim() || item.poKey,
          description: item.devDescription,
          linkedPoTicketKey: item.poKey,
          storyPoints: item.storyPoints ?? undefined,
          ...(item.assigneeAccountId ? { assigneeAccountId: item.assigneeAccountId } : {}),
          ...(devSprintId !== undefined ? { sprintId: devSprintId } : {}),
        });
        setResults((prev) => prev.map((r) => r.id === item.id ? {
          id: item.id, poKey: item.poKey, status: "ok", devKey: dev.key, devUrl: dev.url,
          linkedTo: dev.linkedTo, linkWarning: dev.linkWarning, sprintWarning: dev.sprintWarning,
          assignWarning: dev.assignWarning,
        } : r));
      } catch (err: unknown) {
        const e = err as McpError;
        setResults((prev) => prev.map((r) => r.id === item.id ? {
          id: item.id, poKey: item.poKey, status: "error", error: e.message ?? String(err),
        } : r));
      }
    }
    setPhase("done");
  }

  // ── Render helpers ────────────────────────────────────────────────────────────
  const okCount = results.filter((r) => r.status === "ok").length;
  const errCount = results.filter((r) => r.status === "error").length;

  // v1.36 (ADR-046): group plan rows by their source PO story for the grouped render.
  const planByPo = useMemo(() => {
    const groups: { poKey: string; rows: PlanRow[] }[] = [];
    for (const row of plan) {
      let g = groups.find((x) => x.poKey === row.poKey);
      if (!g) { g = { poKey: row.poKey, rows: [] }; groups.push(g); }
      g.rows.push(row);
    }
    return groups;
  }, [plan]);

  return (
    <>
      {/* ── Phase: select ──────────────────────────────────────────────────── */}
      {phase === "select" && (
        <Card className="shadow-sm">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <h3 className="text-base font-semibold flex items-center gap-2">
                <ListChecks className="h-4 w-4 text-primary" aria-hidden="true" />
                Select PO stories {selected.size > 0 && <span className="text-muted-foreground font-normal">({selected.size} selected)</span>}
              </h3>
              {poSprintId !== undefined && poTickets.length > 0 && (
                <div className="flex gap-2">
                  <Button type="button" variant="outline" size="sm" className="h-7 text-xs"
                    onClick={() => setSelected(new Set(linklessKeys))}
                    aria-label="Select all PO stories without a Dev link">
                    Select link-less ({linklessKeys.length})
                  </Button>
                  <Button type="button" variant="ghost" size="sm" className="h-7 text-xs"
                    onClick={() => setSelected(new Set())}>Clear</Button>
                </div>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {poSprintId === undefined ? (
              <p className="text-sm text-muted-foreground">Pick a PO sprint above to list its stories.</p>
            ) : poTicketsState.loading ? (
              <div className="space-y-2">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-9 w-full" />)}</div>
            ) : poTickets.length === 0 ? (
              <p className="text-sm text-muted-foreground">No tickets in this PO sprint.</p>
            ) : (
              <>
                {linksLoading && (
                  <p className="text-xs text-muted-foreground mb-2 flex items-center gap-1.5">
                    <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> Checking existing Dev links…
                  </p>
                )}
                <ul role="list" className="divide-y divide-border/50">
                  {poTickets.map((t) => {
                    const links = linksMap[t.key] ?? [];
                    const checked = selected.has(t.key);
                    return (
                      <li key={t.key} className="flex items-start gap-3 py-2">
                        <input
                          type="checkbox" checked={checked} onChange={() => toggle(t.key)}
                          id={`${formId}-cb-${t.key}`} className="mt-1 h-4 w-4 cursor-pointer accent-[hsl(var(--primary))]"
                          aria-label={`Select ${t.key} ${t.summary}`}
                        />
                        <label htmlFor={`${formId}-cb-${t.key}`} className="flex-1 min-w-0 cursor-pointer">
                          <span className="flex items-center gap-2 flex-wrap">
                            <a href={t.url} target="_blank" rel="noopener noreferrer"
                              className="font-mono text-xs font-bold text-primary hover:underline" onClick={(e) => e.stopPropagation()}
                              aria-label={`Open ${t.key} in Jira`}>{t.key}</a>
                            {t.storyPoints != null && <span className="text-[0.6875rem] text-muted-foreground tabular-nums">{formatPoints(t.storyPoints)} pts</span>}
                            {links.length > 0 ? (
                              <Badge variant="outline" className="text-[0.625rem] border-success-border text-success bg-success-bg">
                                → {links.map((l) => l.key).join(", ")}
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="text-[0.625rem] text-muted-foreground">no Dev link</Badge>
                            )}
                          </span>
                          <span className="block text-sm text-foreground truncate">{t.summary}</span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
                <div className="mt-4 flex items-center gap-3">
                  <Button type="button" onClick={() => void handleGenerate()} disabled={selected.size === 0 || generating}>
                    {generating ? <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" aria-hidden="true" />Planning…</>
                      : <><Sparkles className="h-4 w-4 mr-1.5" aria-hidden="true" />{aiStatus.enabled ? "Generate plan with AI" : "Build plan"} ({selected.size})</>}
                  </Button>
                  {planError && <span className="text-xs text-destructive">{planError}</span>}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Phase: plan (review/edit) ──────────────────────────────────────── */}
      {phase === "plan" && (
        <Card className="shadow-sm">
          <CardHeader className="pb-2">
            <h3 className="text-base font-semibold">Plan — {plan.length} Dev task{plan.length !== 1 ? "s" : ""} to create</h3>
            {aiNote && <p className="text-xs text-muted-foreground mt-1">{aiNote}</p>}
          </CardHeader>
          <CardContent className="space-y-4">
            {planByPo.map((group) => {
              const hasDesc = (descMap[group.poKey] ?? "").trim().length > 0;
              return (
                <div key={group.poKey} className="rounded-md border border-border bg-muted/20 p-3 space-y-3">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <p className="text-xs text-muted-foreground">
                      PO story <span className="font-mono font-semibold text-foreground">{group.poKey}</span>
                      {" → "}<span className="font-semibold text-foreground">{group.rows.length}</span> Dev task{group.rows.length !== 1 ? "s" : ""}
                    </p>
                    {hasDesc ? (
                      <Badge variant="outline" className="text-[0.625rem] border-success-border text-success bg-success-bg">
                        drafted from PO description
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-[0.625rem] text-warning-foreground border-warning-border gap-1">
                        <AlertCircle className="h-3 w-3" aria-hidden="true" /> PO has no description — drafted from title
                      </Badge>
                    )}
                  </div>

                  {group.rows.map((item, idx) => (
                    <div key={item.id} className="rounded border border-border/70 bg-background p-3 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
                          Dev task {idx + 1} of {group.rows.length}
                        </span>
                        {group.rows.length > 1 && (
                          <Button type="button" variant="ghost" size="sm"
                            className="h-6 px-1.5 text-xs text-destructive hover:text-destructive"
                            onClick={() => removeRow(item.id)}
                            aria-label={`Remove Dev task ${idx + 1} for ${group.poKey}`}>
                            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                          </Button>
                        )}
                      </div>
                      <div className="flex gap-2 items-end flex-wrap">
                        <div className="flex-1 min-w-[180px]">
                          <Label htmlFor={`${formId}-ps-${item.id}`} className="text-xs font-semibold mb-1 block">Title <span className="font-normal text-muted-foreground">(kept from PO)</span></Label>
                          <Input id={`${formId}-ps-${item.id}`} value={item.devSummary} maxLength={255}
                            onChange={(e) => editRow(item.id, { devSummary: e.target.value })} />
                        </div>
                        {/* v1.36 (ADR-046): per-task points — auto-broken-down from the PO, free numeric */}
                        <div className="w-20">
                          <Label htmlFor={`${formId}-pp-${item.id}`} className="text-xs font-semibold mb-1 block">Points</Label>
                          <Input
                            id={`${formId}-pp-${item.id}`}
                            type="number" min={0} step="any"
                            value={item.storyPoints ?? ""}
                            onChange={(e) => { const v = e.target.value; editRow(item.id, { storyPoints: v === "" ? null : Number(v) }); }}
                            aria-label={`Story points for Dev task ${idx + 1} of ${group.poKey}`}
                          />
                        </div>
                        {/* v1.36 (ADR-046): per-task assignee — the two Dev tasks can go to two developers */}
                        <div className="w-44">
                          <Label htmlFor={`${formId}-pa-${item.id}`} className="text-xs font-semibold mb-1 block">Assignee</Label>
                          <select
                            id={`${formId}-pa-${item.id}`} className={selectCls}
                            value={item.assigneeAccountId ?? ""}
                            onChange={(e) => editRow(item.id, { assigneeAccountId: e.target.value || undefined })}
                            aria-label={`Assignee for Dev task ${idx + 1} of ${group.poKey}`}
                          >
                            <option value="">Unassigned</option>
                            {(devTeam.data ?? []).map((m) => (
                              <option key={m.accountId} value={m.accountId}>{m.displayName}</option>
                            ))}
                          </select>
                        </div>
                      </div>
                      <div>
                        <Label htmlFor={`${formId}-pd-${item.id}`} className="text-xs font-semibold mb-1 block">Description</Label>
                        <Textarea id={`${formId}-pd-${item.id}`} value={item.devDescription} rows={6}
                          className="font-mono text-[0.8125rem]"
                          onChange={(e) => editRow(item.id, { devDescription: e.target.value })} />
                      </div>
                      {aiStatus.enabled && (
                        <RefineDraftControl
                          busy={regeneratingId === item.id}
                          labelFor={item.id}
                          onRegenerate={(c) => void regenerateRow(item.id, c)}
                        />
                      )}
                    </div>
                  ))}

                  <Button type="button" variant="outline" size="sm" className="h-7 text-xs"
                    onClick={() => addRow(group.poKey)}
                    aria-label={`Add another Dev task for ${group.poKey}`}>
                    <Plus className="h-3.5 w-3.5 mr-1" aria-hidden="true" /> Add Dev task
                  </Button>
                </div>
              );
            })}
            <div className="flex items-center gap-3">
              <Button type="button" onClick={() => void handleCreateAll()} disabled={plan.length === 0}>
                Create all ({plan.length}){devSprintName ? ` → ${devSprintName}` : ""}
              </Button>
              <Button type="button" variant="outline" onClick={() => setPhase("select")}>Back to selection</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Phase: creating / done (status log) ────────────────────────────── */}
      {(phase === "creating" || phase === "done") && (
        <Card className="shadow-sm">
          <CardHeader className="pb-2">
            <h3 className="text-base font-semibold flex items-center gap-2">
              {phase === "creating" ? <><Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden="true" />Creating Dev tickets…</>
                : <>Done — <span className="text-success">{okCount} created</span>{errCount > 0 && <span className="text-destructive">, {errCount} failed</span>}</>}
            </h3>
          </CardHeader>
          <CardContent>
            <ul role="status" aria-live="polite" className="space-y-1.5">
              {results.map((r) => (
                <li key={r.id} className="flex items-start gap-2 text-sm">
                  {r.status === "pending" && <Loader2 className="h-4 w-4 mt-0.5 animate-spin text-muted-foreground flex-shrink-0" aria-hidden="true" />}
                  {r.status === "ok" && <CheckCircle2 className="h-4 w-4 mt-0.5 text-success flex-shrink-0" aria-hidden="true" />}
                  {r.status === "error" && <XCircle className="h-4 w-4 mt-0.5 text-destructive flex-shrink-0" aria-hidden="true" />}
                  <span className="min-w-0">
                    <span className="font-mono font-semibold">{r.poKey}</span>{" "}
                    {r.status === "pending" && <span className="text-muted-foreground">queued…</span>}
                    {r.status === "ok" && (
                      <>→{" "}
                        <a href={r.devUrl} target="_blank" rel="noopener noreferrer"
                          className="font-mono font-bold text-primary hover:underline inline-flex items-center gap-0.5"
                          aria-label={`Open ${r.devKey} in Jira`}>{r.devKey}<ExternalLink className="h-3 w-3" aria-hidden="true" /></a>
                        {r.linkedTo ? <span className="text-muted-foreground"> · linked</span> : r.linkWarning ? <span className="text-warning-foreground"> · link: {r.linkWarning}</span> : null}
                        {r.sprintWarning && <span className="text-warning-foreground"> · sprint: {r.sprintWarning}</span>}
                        {r.assignWarning && <span className="text-warning-foreground"> · assign: {r.assignWarning}</span>}
                      </>
                    )}
                    {r.status === "error" && <span className="text-destructive">failed — {r.error}</span>}
                  </span>
                </li>
              ))}
            </ul>
            {phase === "done" && (
              <div className="mt-4 flex gap-2">
                {errCount > 0 && (
                  <Button type="button" onClick={() => void handleRetryFailed()}>
                    Retry failed ({errCount})
                  </Button>
                )}
                <Button type="button" variant="outline" onClick={reset}>Start over</Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </>
  );
}
