// NewPoFromDevMode — Linking's mode 3, "New PO from Dev tasks" (v1.72, ADR-083).
// The inverse of CreateDevTasksMode (mode 1): instead of fanning ONE PO story out
// into N Dev tasks, this rolls N EXISTING Dev tickets UP into exactly ONE new PO
// story, then links every selected Dev ticket to it.
//
// Workflow: pick the target Dev sprint (lives in the shell) → multi-select Dev
// tickets via the shared DevTicketPicker (capped at 20 for the AI path) → draft the
// PO story (AI, or the deterministic lib/poRollup.ts fallback) → review/edit title,
// points (seeded with the arithmetic SUM of the selected tickets' points), and
// description → create the PO story, THEN link every selected Dev ticket to it via
// the shared bulk-run machine.
//
// Backend: get_linked_issues (existing PO badges — explicit poProjectKey, §4.17),
// get_issue_descriptions (source context, §4.18), POST /api/ai/draft-po-story
// (§4.9), create_po_ticket (§4.1), link_dev_to_po looped per Dev ticket (§4.31).
// a11y: labeled checkboxes/selects (DevTicketPicker), aria-live status log
// (BulkStatusLog).

import { useState, useEffect, useId, useMemo, useCallback, useRef } from "react";
import { Sparkles, Loader2, ExternalLink, ListChecks, Link2, Lock } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { DevTicketPicker } from "./DevTicketPicker";
import { BulkStatusLog } from "../BulkStatusLog";
import { RefineDraftControl } from "../RefineDraftControl";
import { useActiveSprint, createPoTicket } from "../../hooks/useJira";
import { useBulkRun } from "../../hooks/useBulkRun";
import { getLinkedIssues, getIssueDescriptions, linkDevToPo } from "../../lib/linkClient";
import { aiDraftPoStory } from "../../lib/aiClient";
import { buildPoRollupDraft, capDesc } from "../../lib/poRollup";
import { flattenIssues } from "../../lib/issues";
import { useAuth } from "../../context/AuthContext";
import type { McpError } from "../../lib/mcpClient";
import type {
  AiStatus, LinkedIssue, CreatePoTicketOutput, LinkDevToPoResult,
} from "../../lib/types";

type Phase = "select" | "draft" | "creating";

/** One selected Dev ticket queued to be linked to the newly created PO story. */
interface LinkItem {
  id: string;
  label: string;
  devKey: string;
}

export interface NewPoFromDevModeProps {
  devBoardId?: number;
  devSprintId?: number;
  /** The CREATE TARGET sprint for the new PO story; undefined = backlog. */
  poSprintId?: number;
  /** boards.po[0].projectKey — REQUIRED for the link lookup, see below. */
  poProjectKey: string;
  aiStatus: AiStatus;
}

export function NewPoFromDevMode({
  devBoardId, devSprintId, poSprintId, poProjectKey, aiStatus,
}: NewPoFromDevModeProps) {
  const formId = useId();
  const { readOnly } = useAuth();

  const devTicketsState = useActiveSprint(devBoardId, devSprintId ?? null);
  const issues = useMemo(() => flattenIssues(devTicketsState.data), [devTicketsState.data]);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  // v1.72 (ADR-083): unlike mode 1, an already-linked Dev ticket is a perfectly
  // normal candidate for an ADDITIONAL PO story — default OFF (contrast mode 2).
  const [unlinkedOnly, setUnlinkedOnly] = useState(false);
  const [assigneeFilter, setAssigneeFilter] = useState<string | null>(null);

  const [phase, setPhase] = useState<Phase>("select");

  // Existing PO links per Dev key (badges). Explicit poProjectKey — get_linked_issues
  // otherwise filters to the Dev project and returns [] for everything (§4.17).
  const [linksMap, setLinksMap] = useState<Record<string, LinkedIssue[]>>({});
  const [linksLoading, setLinksLoading] = useState(false);
  const linksReqRef = useRef(0);
  const devKeysKey = useMemo(() => issues.map((i) => i.key).sort().join(","), [issues]);

  useEffect(() => {
    const keys = issues.map((i) => i.key);
    if (keys.length === 0) { setLinksMap({}); return; }
    const myReq = ++linksReqRef.current;
    setLinksLoading(true);
    getLinkedIssues(keys, poProjectKey)
      .then((res) => { if (myReq === linksReqRef.current) { setLinksMap(res.links); setLinksLoading(false); } })
      .catch(() => { if (myReq === linksReqRef.current) { setLinksMap({}); setLinksLoading(false); } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devKeysKey, poProjectKey]);

  // ── Draft state (phase 2, editable) ──────────────────────────────────────────
  const [draftSummary, setDraftSummary] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [draftPoints, setDraftPoints] = useState<number | null>(null);
  const [descMap, setDescMap] = useState<Record<string, string>>({});
  const [aiNote, setAiNote] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  // ── Phase 3 state — the created PO + the bulk link run ───────────────────────
  // `createdPo` (state) drives the render; `createdPoRef` is read by the `perLink`
  // closure below so a stale closure can never see a null PO after creation.
  const [createdPo, setCreatedPo] = useState<CreatePoTicketOutput | null>(null);
  const createdPoRef = useRef<CreatePoTicketOutput | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const perLink = useCallback((item: LinkItem): Promise<LinkDevToPoResult> => {
    const po = createdPoRef.current;
    if (!po) {
      return Promise.reject({ code: "INTERNAL", message: "No PO story to link to yet" } as McpError);
    }
    return linkDevToPo(po.key, item.devKey);
  }, []);
  const bulkRun = useBulkRun<LinkItem, LinkDevToPoResult>(perLink);

  function resetAll() {
    setPhase("select");
    setSelected(new Set());
    setDraftSummary("");
    setDraftDescription("");
    setDraftPoints(null);
    setDescMap({});
    setAiNote(null);
    setCreateError(null);
    setCreatedPo(null);
    createdPoRef.current = null;
    bulkRun.reset();
  }

  // Reset the whole flow whenever the Dev sprint changes.
  useEffect(() => {
    resetAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devSprintId]);

  const toggle = useCallback((key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  function buildDevTicketsInput(descByKey: Record<string, string>) {
    return issues
      .filter((t) => selected.has(t.key))
      .map((t) => {
        const description = capDesc(descByKey[t.key] ?? "");
        return {
          key: t.key,
          summary: t.summary,
          storyPoints: t.storyPoints,
          ...(description ? { description } : {}),
        };
      });
  }

  // ── Draft the PO story (AI, or deterministic rollup fallback) ────────────────
  async function handleDraft() {
    const chosen = issues.filter((t) => selected.has(t.key));
    if (chosen.length === 0 || chosen.length > 20 || readOnly) return;
    setDrafting(true);
    setAiNote(null);

    // v1.18 (ADR-025 pattern): pull each selected Dev ticket's own description so
    // the PO story derives its acceptance criteria from real content. Non-fatal.
    let descByKey: Record<string, string> = {};
    try {
      const res = await getIssueDescriptions(chosen.map((t) => t.key));
      descByKey = res.descriptions;
    } catch {
      descByKey = {};
    }
    setDescMap(descByKey);

    // No storyPoints in the AI output — deliberate (§4.9). The sum is the
    // arithmetic sum of the selected tickets' points; null when none have any.
    const sumPoints = chosen.reduce<number | null>(
      (acc, t) => (t.storyPoints == null ? acc : (acc ?? 0) + t.storyPoints),
      null
    );

    const fallback = () =>
      buildPoRollupDraft(
        chosen.map((t) => ({ key: t.key, summary: t.summary, description: descByKey[t.key] ?? "" }))
      );

    try {
      if (aiStatus.enabled) {
        const res = await aiDraftPoStory({ devTickets: buildDevTicketsInput(descByKey) });
        setDraftSummary(res.summary);
        setDraftDescription(res.description);
        setAiNote(res.assistantMessage);
      } else {
        const d = fallback();
        setDraftSummary(d.summary);
        setDraftDescription(d.description);
        setAiNote("AI is off — drafted from local templates. Edit before creating.");
      }
      setDraftPoints(sumPoints);
      setPhase("draft");
    } catch (err: unknown) {
      // AI error/unavailable → deterministic fallback so the workflow never blocks
      const e = err as McpError;
      const d = fallback();
      setDraftSummary(d.summary);
      setDraftDescription(d.description);
      setDraftPoints(sumPoints);
      setAiNote(
        e.code === "AI_UNAVAILABLE"
          ? "AI is off — drafted from local templates. Edit before creating."
          : `AI error (${e.code ?? "UNKNOWN"}) — drafted from local templates instead.`
      );
      setPhase("draft");
    } finally {
      setDrafting(false);
    }
  }

  // ── Comment & regenerate the draft (v1.12/ADR-023 pattern) ───────────────────
  async function handleRegenerate(comment: string) {
    setRegenerating(true);
    try {
      const instructions =
        `A reviewer left this comment on the current PO story draft: "${comment}". ` +
        `Current draft summary: "${draftSummary}". ` +
        `Current draft description:\n${draftDescription}\n\n` +
        `Rewrite the PO story to address the comment, keeping what still applies.`;
      const res = await aiDraftPoStory({
        devTickets: buildDevTicketsInput(descMap),
        instructions,
      });
      setDraftSummary(res.summary);
      setDraftDescription(res.description);
    } catch {
      // Keep the current draft on failure — non-fatal.
    } finally {
      setRegenerating(false);
    }
  }

  // ── Phase 3: create the PO story, THEN link every selected Dev ticket to it ──
  // CORRECTNESS-CRITICAL: the create step is guarded so it can run at most once.
  // `createdPo !== null` bails out before ever calling create_po_ticket again, and
  // the actual link calls (`perLink` above) read the PO key from `createdPoRef`
  // (a ref, not state) so a stale closure can never see a null PO. "Retry failed"
  // (wired straight to `bulkRun.retryFailed`, below) replays ONLY the `perLink`
  // closure for rows still `"error"` — it never calls this function again, so the
  // PO story cannot be duplicated by retrying. A naive create-then-link handler
  // invoked again on retry would re-run create_po_ticket every time; this does not.
  async function handleCreateAndLink() {
    if (createdPo !== null || creating || readOnly) return;
    setCreating(true);
    setCreateError(null);
    try {
      const po = await createPoTicket({
        summary: draftSummary.trim() || "New PO story",
        description: draftDescription,
        ...(draftPoints != null ? { storyPoints: draftPoints } : {}),
        ...(poSprintId !== undefined ? { sprintId: poSprintId } : {}),
      });
      createdPoRef.current = po;
      setCreatedPo(po);
      setPhase("creating");
      const items: LinkItem[] = [...selected].map((devKey) => ({ id: devKey, label: devKey, devKey }));
      await bulkRun.run(items);
    } catch (err: unknown) {
      // Create failed — STOP. Zero link calls issued: no orphan PO, no orphan links.
      const e = err as McpError;
      setCreateError(e.message ?? String(err));
    } finally {
      setCreating(false);
    }
  }

  const readOnlyBanner = readOnly && (
    <Alert>
      <Lock className="h-4 w-4" aria-hidden="true" />
      <AlertDescription>
        You&apos;re on a shared read-only Jira connection — drafting and creating a PO story is disabled.
      </AlertDescription>
    </Alert>
  );

  return (
    <>
      {/* ── Phase: select ──────────────────────────────────────────────────── */}
      {phase === "select" && (
        <Card className="shadow-sm">
          <CardHeader className="pb-2">
            <h3 className="text-base font-semibold flex items-center gap-2">
              <ListChecks className="h-4 w-4 text-primary" aria-hidden="true" />
              Select Dev tickets {selected.size > 0 && <span className="text-muted-foreground font-normal">({selected.size} selected)</span>}
            </h3>
          </CardHeader>
          <CardContent className="space-y-3">
            {readOnlyBanner}
            <DevTicketPicker
              issues={issues}
              loading={devTicketsState.loading}
              selected={selected}
              onToggle={toggle}
              onSetSelected={setSelected}
              poLinksByDevKey={linksMap}
              linksLoading={linksLoading}
              unlinkedOnly={unlinkedOnly}
              onUnlinkedOnlyChange={setUnlinkedOnly}
              assigneeFilter={assigneeFilter}
              onAssigneeFilterChange={setAssigneeFilter}
              maxSelectable={20}
              placeholderHint={devSprintId === undefined ? "Pick a Dev sprint above to list its tickets." : undefined}
            />
            {devSprintId !== undefined && issues.length > 0 && (
              <div className="flex items-center gap-3">
                <Button
                  type="button"
                  onClick={() => void handleDraft()}
                  disabled={selected.size === 0 || selected.size > 20 || drafting || readOnly}
                >
                  {drafting ? (
                    <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" aria-hidden="true" />Drafting…</>
                  ) : (
                    <><Sparkles className="h-4 w-4 mr-1.5" aria-hidden="true" />{aiStatus.enabled ? "Draft PO story with AI" : "Draft PO story"} ({selected.size})</>
                  )}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Phase: draft (review/edit) ─────────────────────────────────────── */}
      {phase === "draft" && (
        <Card className="shadow-sm">
          <CardHeader className="pb-2">
            <h3 className="text-base font-semibold">New PO story — covers {selected.size} Dev task{selected.size !== 1 ? "s" : ""}</h3>
            {aiNote && <p className="text-xs text-muted-foreground mt-1">{aiNote}</p>}
          </CardHeader>
          <CardContent className="space-y-4">
            {readOnlyBanner}
            <div className="rounded-md border border-border bg-muted/20 p-3 space-y-3">
              <p className="text-xs text-muted-foreground">
                Delivered by{" "}
                <span className="font-mono font-semibold text-foreground">{[...selected].join(", ")}</span>
              </p>
              <div className="flex gap-2 items-end flex-wrap">
                <div className="flex-1 min-w-[220px]">
                  <Label htmlFor={`${formId}-title`} className="text-xs font-semibold mb-1 block">Title</Label>
                  <Input
                    id={`${formId}-title`}
                    value={draftSummary}
                    maxLength={255}
                    onChange={(e) => setDraftSummary(e.target.value)}
                  />
                </div>
                <div className="w-24">
                  <Label htmlFor={`${formId}-points`} className="text-xs font-semibold mb-1 block">Points</Label>
                  <Input
                    id={`${formId}-points`}
                    type="number"
                    min={0}
                    step="any"
                    value={draftPoints ?? ""}
                    onChange={(e) => { const v = e.target.value; setDraftPoints(v === "" ? null : Number(v)); }}
                  />
                </div>
              </div>
              <div>
                <Label htmlFor={`${formId}-desc`} className="text-xs font-semibold mb-1 block">Description</Label>
                <Textarea
                  id={`${formId}-desc`}
                  value={draftDescription}
                  rows={10}
                  className="font-mono text-[0.8125rem]"
                  onChange={(e) => setDraftDescription(e.target.value)}
                />
              </div>
              {aiStatus.enabled && (
                <RefineDraftControl
                  busy={regenerating}
                  onRegenerate={(c) => void handleRegenerate(c)}
                  placeholder="Add a comment to refine the PO story, then regenerate…"
                />
              )}
            </div>

            {createError && (
              <Alert variant="destructive" role="alert">
                <AlertDescription>{createError}</AlertDescription>
              </Alert>
            )}

            <div className="flex items-center gap-3">
              <Button type="button" onClick={() => void handleCreateAndLink()} disabled={creating || readOnly}>
                {creating ? (
                  <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" aria-hidden="true" />Creating…</>
                ) : (
                  <><Link2 className="h-4 w-4 mr-1.5" aria-hidden="true" />Create &amp; link ({selected.size})</>
                )}
              </Button>
              <Button type="button" variant="outline" onClick={() => setPhase("select")}>Back to selection</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Phase: creating / done (created PO + live link status log) ──────── */}
      {phase === "creating" && createdPo && (
        <div className="space-y-4">
          <Card className="shadow-sm">
            <CardContent className="pt-5">
              <p className="text-sm">
                New PO story:{" "}
                <a
                  href={createdPo.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono font-bold text-primary hover:underline inline-flex items-center gap-0.5"
                  aria-label={`Open ${createdPo.key} in Jira`}
                >
                  {createdPo.key}<ExternalLink className="h-3 w-3" aria-hidden="true" />
                </a>
                {createdPo.sprintWarning && (
                  <span className="text-warning-foreground text-xs"> · sprint: {createdPo.sprintWarning}</span>
                )}
              </p>
            </CardContent>
          </Card>

          <BulkStatusLog
            rows={bulkRun.rows}
            running={bulkRun.running}
            title={{ running: `Linking Dev tickets to ${createdPo.key}…`, done: "linked" }}
            renderOk={(row) => {
              const d = row.detail;
              if (!d) return null;
              if (d.alreadyLinked) {
                return (
                  <span className="text-muted-foreground">
                    — already linked{d.reversed ? " (reversed link)" : ""}
                  </span>
                );
              }
              return (
                <>
                  <span className="text-success">— linked to {d.poKey}</span>
                  {d.precheckWarning && <span className="text-warning-foreground"> · {d.precheckWarning}</span>}
                </>
              );
            }}
            onRetry={() => void bulkRun.retryFailed()}
            onReset={resetAll}
          />
        </div>
      )}
    </>
  );
}
