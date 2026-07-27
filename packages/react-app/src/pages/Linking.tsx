// Linking — the PO↔Dev link surface, a 3-mode shell (v1.72, ADR-083; original
// single-mode flow shipped v1.11, ADR-022).
//
// This file is a SHELL only: it owns the boards/sprint-list/AI-status hooks, the
// poSprintId/devSprintId/mode state, the shared sprint-context card (two SprintSelects
// whose accessible names stay "PO board sprint"/"Dev board sprint" in EVERY mode — only
// the visible label text and each select's groups/placeholder vary by mode, per
// CONTRACTS.md §6), the 3-way mode toggle, the bridge-offline alert, and a 3-way render
// switch. NO flow logic lives here — each mode is its own component under
// src/components/linking/:
//   - "create-dev"    → CreateDevTasksMode (the original v1.11 flow, unchanged)
//   - "link-existing" → LinkExistingMode (CONTRACTS.md §6 mode 2)
//   - "new-po"        → NewPoFromDevMode (CONTRACTS.md §6 mode 3)
//
// Backend/behaviour details: see CONTRACTS.md §6 "Linking (page, v1.11 — ADR-022;
// 3 modes since v1.72 — ADR-083)".

import { useState, useEffect, useId } from "react";
import { Link2, AlertCircle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useBoards } from "../lib/boards";
import { useSprintList } from "../hooks/useJira";
import { getAiStatus } from "../lib/aiClient";
import { SprintSelect } from "../components/SprintSelect";
import { LinkingModeToggle, type LinkingMode } from "../components/linking/LinkingModeToggle";
import { CreateDevTasksMode } from "../components/linking/CreateDevTasksMode";
import { NewPoFromDevMode } from "../components/linking/NewPoFromDevMode";
import { LinkExistingMode } from "../components/linking/LinkExistingMode";
import type { AiStatus } from "../lib/types";

type SprintGroup = "active" | "future" | "closed";
interface SelectConfig {
  groups: readonly SprintGroup[];
  placeholder: string;
  label: string;
}

// Mode-dependent sprint-select semantics (CONTRACTS.md §6 table). Accessible names never
// change across modes — only the visible label, offered sprint-state groups, and the
// placeholder do.
const PO_SELECT_CONFIG: Record<LinkingMode, SelectConfig> = {
  "create-dev": { groups: ["active", "future", "closed"], placeholder: "Select a PO sprint…", label: "PO board sprint (source)" },
  "link-existing": { groups: ["active", "future", "closed"], placeholder: "Select a PO sprint…", label: "PO board sprint (source)" },
  "new-po": { groups: ["active", "future"], placeholder: "Backlog / no sprint", label: "PO board sprint (target)" },
};
const DEV_SELECT_CONFIG: Record<LinkingMode, SelectConfig> = {
  "create-dev": { groups: ["active", "future"], placeholder: "Backlog / no sprint", label: "Dev board sprint (target)" },
  "link-existing": { groups: ["active", "future"], placeholder: "Select a Dev sprint…", label: "Dev board sprint (source)" },
  "new-po": { groups: ["active", "future"], placeholder: "Select a Dev sprint…", label: "Dev board sprint (source)" },
};

export function Linking() {
  const formId = useId();
  const { boards, loading: boardsLoading } = useBoards();

  // v1.25 (ADR-037): Linking is dual-board; uses each side's default project (element 0).
  const poSprintList = useSprintList("all", boards?.po[0]?.id);
  const devSprintList = useSprintList("all", boards?.dev[0]?.id);

  const [poSprintId, setPoSprintId] = useState<number | undefined>(undefined);
  const [devSprintId, setDevSprintId] = useState<number | undefined>(undefined);
  const [mode, setMode] = useState<LinkingMode>("create-dev");

  const [aiStatus, setAiStatus] = useState<AiStatus>({ enabled: false, provider: null, model: null });
  useEffect(() => {
    getAiStatus().then(setAiStatus).catch(() => setAiStatus({ enabled: false, provider: null, model: null }));
  }, []);

  const devSprintName = devSprintList.data
    ? [...devSprintList.data.active, ...devSprintList.data.future, ...devSprintList.data.closed]
        .find((s) => s.id === devSprintId)?.name
    : undefined;

  const poCfg = PO_SELECT_CONFIG[mode];
  const devCfg = DEV_SELECT_CONFIG[mode];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Link2 className="h-5 w-5 text-primary" aria-hidden="true" />
        <h2 className="text-lg font-semibold">Linking — bulk Dev tickets from PO stories</h2>
      </div>

      {/* ── Sprint context (shared by all 3 modes) ─────────────────────────── */}
      <Card className="shadow-sm">
        <CardContent className="pt-5">
          <div className="flex flex-wrap items-end gap-4">
            <SprintSelect
              id={`${formId}-po`}
              label={poCfg.label}
              ariaLabel="PO board sprint"
              value={poSprintId}
              onChange={setPoSprintId}
              data={poSprintList.data}
              groups={poCfg.groups}
              placeholder={poCfg.placeholder}
              loading={boardsLoading}
              disabled={poSprintList.loading}
            />
            <SprintSelect
              id={`${formId}-dev`}
              label={devCfg.label}
              ariaLabel="Dev board sprint"
              value={devSprintId}
              onChange={setDevSprintId}
              data={devSprintList.data}
              groups={devCfg.groups}
              placeholder={devCfg.placeholder}
              loading={boardsLoading}
              disabled={devSprintList.loading}
            />
            {aiStatus.enabled && (
              <Badge variant="outline" className="text-[0.6875rem] font-bold border-primary text-primary bg-primary/10 mb-1">
                AI: {aiStatus.provider} · {aiStatus.model}
              </Badge>
            )}
          </div>
        </CardContent>
      </Card>

      <LinkingModeToggle mode={mode} onChange={setMode} />

      {/* ── Mode render switch ──────────────────────────────────────────────── */}
      {mode === "create-dev" && (
        <CreateDevTasksMode
          poBoardId={boards?.po[0]?.id}
          devBoardId={boards?.dev[0]?.id}
          poSprintId={poSprintId}
          devSprintId={devSprintId}
          devSprintName={devSprintName}
          aiStatus={aiStatus}
        />
      )}

      {mode === "link-existing" && (
        <LinkExistingMode
          poBoardId={boards?.po[0]?.id}
          devBoardId={boards?.dev[0]?.id}
          poSprintId={poSprintId}
          devSprintId={devSprintId}
          poProjectKey={boards?.po[0]?.projectKey ?? ""}
        />
      )}

      {mode === "new-po" && (
        <NewPoFromDevMode
          devBoardId={boards?.dev[0]?.id}
          devSprintId={devSprintId}
          poSprintId={poSprintId}
          poProjectKey={boards?.po[0]?.projectKey ?? ""}
          aiStatus={aiStatus}
        />
      )}

      {boards === null && !boardsLoading && (
        <Alert variant="destructive" role="alert">
          <AlertDescription className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4" aria-hidden="true" /> Jira bridge is offline — start it with <code className="font-mono">npm run dev:jira:http</code>.
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
