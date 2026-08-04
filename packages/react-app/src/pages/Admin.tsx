// Admin console (v1.45/v1.46, ADR-055/056) — the super-admin's supervision + config surface.
// Admin-only (the tab is gated on role in App.tsx; the API is gated by requireAdmin server-side).
//
//  - Add user: create an account, optionally on SHARED credentials — a teammate with no Jira/AI
//    tokens of their own who borrows another user's, getting the same board point-of-view.
//  - Users: role, connection status, shared-credential source, write access, disable, delete,
//    and per-user board/env overrides.
//  - Global defaults: the board/env config applied to everyone (per-user overrides win).
//
// Only NON-secret config is settable here — Jira/GitHub/AI tokens stay each user's own encrypted
// connection and are never shown.

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  ShieldCheck, User as UserIcon, Loader2, AlertCircle, CheckCircle2, Settings2, RefreshCw,
  UserPlus, Trash2, Ban, Undo2, Share2, Layers, Plus, Users,
} from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { isAuthApiError } from "../lib/authClient";
import {
  getAdminUsers, putGlobalConfig, putUserConfig, putUserRole,
  createUser, updateUser, deleteUser,
  getTemplates, createTemplate, deleteTemplate, applyTemplateToUser, applyTemplateToGlobal,
  listTeams, createTeam, updateTeam, deleteTeam, setUserTeam, adoptIntoTeam,
  type AdminConfig, type AdminUser, type AdminUsersResponse, type ConfigTemplate, type ProviderStatus,
  type TeamView,
} from "../lib/adminClient";

// v1.67 (ADR-078) — the three providers eligible for granular sharing, in the fixed order used to
// build/compare `sharedProviders` payloads (so a round-tripped array compares equal via JSON.stringify).
const SHAREABLE_PROVIDERS = ["jira", "github", "ai"] as const;
type ShareableProvider = (typeof SHAREABLE_PROVIDERS)[number];

/** Checked-box state → the payload value: `null` when all three are shared (legacy share-all). */
function collectSharedProviders(checked: Record<ShareableProvider, boolean>): ShareableProvider[] | null {
  const list = SHAREABLE_PROVIDERS.filter((p) => checked[p]);
  return list.length === SHAREABLE_PROVIDERS.length ? null : list;
}

/** `sharedProviders` (null = share-all) → the three checkboxes' initial checked state. */
function sharedProvidersToChecked(shared: ShareableProvider[] | null): Record<ShareableProvider, boolean> {
  if (shared === null) return { jira: true, github: true, ai: true };
  return { jira: shared.includes("jira"), github: shared.includes("github"), ai: shared.includes("ai") };
}

const SHARE_LABELS: { key: ShareableProvider; label: string }[] = [
  { key: "jira", label: "Share Jira" },
  { key: "github", label: "Share GitHub" },
  { key: "ai", label: "Share AI" },
];

/**
 * v1.67 (ADR-078) — three checkboxes, each defaulting to CHECKED (preserves the legacy all-or-nothing
 * default). Shown alongside the "allow writes" checkbox wherever a credential source is picked.
 */
function ShareCheckboxes({
  checked, onChange,
}: {
  checked: Record<ShareableProvider, boolean>;
  onChange: (next: Record<ShareableProvider, boolean>) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      {SHARE_LABELS.map(({ key, label }) => (
        <label key={key} className="flex items-center gap-1.5 text-xs text-foreground">
          <input type="checkbox" checked={checked[key]} onChange={(e) => onChange({ ...checked, [key]: e.target.checked })} />
          {label}
        </label>
      ))}
    </div>
  );
}

function errMsg(err: unknown): string {
  return isAuthApiError(err) ? err.message : "Something went wrong";
}

// The admin-settable fields, grouped for a legible form. Order/labels mirror adminConfigSchema.
type FieldDef = { key: keyof AdminConfig; label: string; placeholder?: string; numeric?: boolean };
const FIELD_GROUPS: { title: string; hint?: string; fields: FieldDef[] }[] = [
  {
    title: "Connection defaults",
    fields: [
      { key: "JIRA_BASE_URL", label: "Jira base URL", placeholder: "https://you.atlassian.net" },
      { key: "JIRA_EMAIL", label: "Jira email", placeholder: "you@company.com" },
    ],
  },
  {
    title: "Boards & projects",
    // The board *ID* is what selects which board's data loads (getProjects keys off it, ADR-062);
    // the project key is only a display label. Spell this out — changing the key alone is a no-op.
    hint: "The board ID selects which board loads — set this to switch boards. The project key is only a label.",
    fields: [
      { key: "JIRA_PO_BOARD_ID", label: "PO board ID (switches board)", placeholder: "10001" },
      { key: "JIRA_DEV_BOARD_ID", label: "Dev board ID (switches board)", placeholder: "10002" },
      { key: "JIRA_PO_PROJECT_KEY", label: "PO project key (label only)", placeholder: "PO" },
      { key: "JIRA_DEV_PROJECT_KEY", label: "Dev project key (label only)", placeholder: "DEV" },
      { key: "JIRA_PO_PROJECTS", label: "PO projects (KEY:boardId,…)" },
      { key: "JIRA_DEV_PROJECTS", label: "Dev projects (KEY:boardId,…)" },
    ],
  },
  {
    title: "Fields & statuses",
    fields: [
      { key: "JIRA_STORY_POINTS_FIELD", label: "Story-points field", placeholder: "customfield_10016" },
      { key: "JIRA_LINK_TYPE", label: "Link type", placeholder: "Depends on" },
      { key: "JIRA_FLAGGED_FIELD", label: "Flagged field" },
      { key: "JIRA_CODE_REVIEW_STATUSES", label: "Code-review statuses (comma-sep)" },
      { key: "JIRA_DEV_STATUS_APP_TYPE", label: "Dev-status app type" },
    ],
  },
  {
    title: "Velocity & offset",
    fields: [
      { key: "JIRA_VELOCITY_SPRINTS", label: "Velocity sprints", placeholder: "6", numeric: true },
      { key: "JIRA_REQUIRED_POINTS", label: "Required points", placeholder: "8", numeric: true },
      { key: "JIRA_OFFSET_THRESHOLD", label: "Offset threshold", placeholder: "2", numeric: true },
    ],
  },
  {
    title: "Ticket aging",
    // v1.58 (ADR-070) — drives the Huddle's Aging card + the per-card age chips.
    hint: "Expected days in a status = base + (days per point × story points). Unpointed tickets use the base only.",
    fields: [
      { key: "JIRA_AGING_BASE_DAYS", label: "Base days", placeholder: "1", numeric: true },
      { key: "JIRA_AGING_DAYS_PER_POINT", label: "Days per point", placeholder: "1", numeric: true },
    ],
  },
];

function toStringMap(cfg: AdminConfig): Record<string, string> {
  const out: Record<string, string> = {};
  for (const group of FIELD_GROUPS) {
    for (const f of group.fields) {
      const v = cfg[f.key];
      out[f.key] = v === undefined || v === null ? "" : String(v);
    }
  }
  return out;
}

/** Collect the config form's string map into an AdminConfig — empty fields OMITTED (clears the override). */
function collectConfig(values: Record<string, string>): AdminConfig {
  const out: Record<string, string | number> = {};
  for (const group of FIELD_GROUPS) {
    for (const f of group.fields) {
      const raw = (values[f.key] ?? "").trim();
      if (raw === "") continue; // omit → the server drops this override
      out[f.key] = f.numeric ? Number(raw) : raw;
    }
  }
  return out as AdminConfig;
}

/** True when the config a form currently holds differs from the user/global's saved config. */
function configDiffers(values: Record<string, string>, saved: AdminConfig): boolean {
  return JSON.stringify(collectConfig(values)) !== JSON.stringify(collectConfig(toStringMap(saved)));
}

/**
 * The grouped config fields (shared by the global-defaults form and the per-user setup form).
 * A group may carry a `hint` — used to spell out that the board ID (not the key) switches boards.
 */
function ConfigFields({
  values, set, idPrefix,
}: {
  values: Record<string, string>;
  set: (k: string, v: string) => void;
  idPrefix: string;
}) {
  return (
    <>
      {FIELD_GROUPS.map((group) => (
        <div key={group.title}>
          <p className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground mb-0.5">
            {group.title}
          </p>
          {group.hint && <p className="text-xs text-muted-foreground mb-1.5">{group.hint}</p>}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {group.fields.map((f) => (
              <div key={f.key}>
                <Label htmlFor={`${idPrefix}-${f.key}`} className="text-xs font-medium">{f.label}</Label>
                <Input
                  id={`${idPrefix}-${f.key}`}
                  inputMode={f.numeric ? "numeric" : undefined}
                  placeholder={f.placeholder}
                  value={values[f.key] ?? ""}
                  onChange={(e) => set(f.key, e.target.value)}
                />
              </div>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

/**
 * A reusable form over the admin-settable config (used for the GLOBAL defaults + template creation).
 * Per-user config is edited via UserSetupForm, which folds this together with access in one save.
 * Empty fields are OMITTED (clears the override). `idPrefix` keeps DOM ids unique across instances.
 */
function ConfigForm({
  initial, saving, submitLabel, onSave, idPrefix = "cfg",
}: {
  initial: AdminConfig;
  saving: boolean;
  submitLabel: string;
  onSave: (cfg: AdminConfig) => void;
  idPrefix?: string;
}) {
  const [values, setValues] = useState<Record<string, string>>(() => toStringMap(initial));
  const set = (k: string, v: string) => setValues((prev) => ({ ...prev, [k]: v }));

  function submit(e: FormEvent) {
    e.preventDefault();
    onSave(collectConfig(values));
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <ConfigFields values={values} set={set} idPrefix={idPrefix} />
      <Button type="submit" size="sm" disabled={saving}>
        {saving ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" aria-hidden="true" /> : null}
        {submitLabel}
      </Button>
    </form>
  );
}

/** How many fields a template actually sets — the useful at-a-glance summary. */
function fieldCount(cfg: AdminConfig): number {
  return Object.values(cfg).filter((v) => v !== undefined && v !== "").length;
}

/**
 * Apply a saved template into a config form (v1.47). "Apply" replaces the target's config with the
 * template's; "Merge" layers the template over whatever is already set.
 */
function TemplatePicker({
  templates, busy, id, scope, onApply,
}: {
  templates: ConfigTemplate[];
  busy: boolean;
  /** Unique DOM id fragment — several pickers can be open at once. */
  id: string;
  /** Human name of what's being changed, e.g. "global defaults" or a user's email. */
  scope: string;
  onApply: (templateId: string, merge: boolean) => void;
}) {
  const [selected, setSelected] = useState("");
  if (templates.length === 0) return null;
  return (
    <div className="flex flex-wrap items-end gap-2 mb-3 pb-3 border-b border-border">
      <div className="min-w-[200px]">
        <Label htmlFor={`tpl-pick-${id}`} className="text-xs font-medium">Apply a template</Label>
        <select
          id={`tpl-pick-${id}`}
          className="flex h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
        >
          <option value="">Choose a template…</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>{t.name} ({fieldCount(t.config)} fields)</option>
          ))}
        </select>
      </div>
      {/* a11y: several pickers coexist, so the action names must say WHAT they change. */}
      <Button type="button" size="sm" variant="outline" disabled={!selected || busy}
        aria-label={`Replace ${scope} config with the selected template`}
        onClick={() => onApply(selected, false)}>
        Replace with template
      </Button>
      <Button type="button" size="sm" variant="ghost" disabled={!selected || busy}
        aria-label={`Merge the selected template on top of ${scope} config`}
        onClick={() => onApply(selected, true)}>
        Merge on top
      </Button>
    </div>
  );
}

/** Create / list / delete reusable config templates (v1.47, ADR-057). */
function TemplatesCard({
  templates, busy, creating, onCreate, onDelete,
}: {
  templates: ConfigTemplate[];
  busy: string | null;
  creating: boolean;
  onCreate: (name: string, config: AdminConfig) => void;
  onDelete: (t: ConfigTemplate) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);

  return (
    <Card className="shadow-sm">
      <CardHeader className="px-4 pt-4 pb-2">
        <h2 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
          <Layers className="h-4 w-4 text-primary" aria-hidden="true" /> Config templates
          {templates.length > 0 && <span className="text-muted-foreground font-normal">({templates.length})</span>}
          <Button type="button" size="sm" variant={open ? "ghost" : "outline"} className="ml-auto"
            onClick={() => setOpen((o) => !o)}>
            {open ? "Cancel" : <><Plus className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" /> New template</>}
          </Button>
        </h2>
        <p className="text-xs text-muted-foreground">
          Save a board/env setup once, then reuse it on any user's overrides or the global defaults.
        </p>
      </CardHeader>
      <CardContent className="px-4 pb-4 space-y-3">
        {templates.length > 0 ? (
          <ul className="space-y-1.5">
            {templates.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-2 border border-border rounded-md px-3 py-1.5">
                <span className="text-sm font-medium text-foreground truncate flex-1 min-w-0">{t.name}</span>
                <span className="text-[0.625rem] font-medium px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
                  {fieldCount(t.config)} fields
                </span>
                {confirmId === t.id ? (
                  <>
                    <Button type="button" size="sm" variant="destructive" disabled={busy === t.id}
                      onClick={() => { onDelete(t); setConfirmId(null); }}>
                      Confirm delete
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmId(null)}>Cancel</Button>
                  </>
                ) : (
                  <Button type="button" size="sm" variant="outline" disabled={busy === t.id}
                    aria-label={`Delete template ${t.name}`} onClick={() => setConfirmId(t.id)}>
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          !open && <p className="text-sm text-muted-foreground">No templates yet.</p>
        )}

        {open && (
          <div className="border-t border-border pt-3 space-y-3">
            <div className="max-w-sm">
              <Label htmlFor="tpl-name" className="text-xs font-medium">Template name</Label>
              <Input id="tpl-name" value={name} onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Team A — Dev board" maxLength={80} />
            </div>
            <ConfigForm
              idPrefix="tpl"
              initial={{}}
              saving={creating}
              submitLabel="Create template"
              onSave={(cfg) => {
                if (!name.trim()) return;
                onCreate(name.trim(), cfg);
                setName("");
                setOpen(false);
              }}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Teams (v1.73, ADR-084) ──────────────────────────────────────────────────
// A team is a SHARED storage scope: every member reads/writes the SAME leaves, retro, meeting
// notes, PRs, impediments, offset and draft plan, while each keeps their own Jira/GitHub/AI login.

/** Create / list / rename / delete teams, and seed a new team from a member's existing documents. */
function TeamsCard({
  teams, users, creating, busy, onCreate, onRename, onDelete, onAdopt,
}: {
  teams: TeamView[];
  /** Every user, for the "Adopt data from…" source picker (any user may have docs worth seeding). */
  users: AdminUser[];
  creating: boolean;
  /** The team currently mid-action (rename/delete/adopt), or null. */
  busy: string | null;
  onCreate: (name: string) => void;
  onRename: (team: TeamView, name: string) => void;
  onDelete: (team: TeamView) => void;
  onAdopt: (teamId: string, fromUserId: string) => void;
}) {
  const [name, setName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [adoptFrom, setAdoptFrom] = useState<Record<string, string>>({});

  function submitCreate(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    onCreate(name.trim());
    setName("");
  }

  function submitRename(t: TeamView) {
    const next = renameValue.trim();
    if (next && next !== t.name) onRename(t, next);
    setRenamingId(null);
  }

  return (
    <Card className="shadow-sm">
      <CardHeader className="px-4 pt-4 pb-2">
        <h2 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
          <Users className="h-4 w-4 text-primary" aria-hidden="true" /> Teams
          {teams.length > 0 && <span className="text-muted-foreground font-normal">({teams.length})</span>}
        </h2>
        <p className="text-xs text-muted-foreground">
          A team is a SHARED scope — every member reads and writes the same leaves, retro, meeting
          notes, PRs and draft plan, while each still signs in with their own Jira/GitHub/AI account.
        </p>
      </CardHeader>
      <CardContent className="px-4 pb-4 space-y-3">
        <form onSubmit={submitCreate} className="flex flex-wrap items-end gap-2 pb-3 border-b border-border">
          <div className="min-w-[220px]">
            <Label htmlFor="team-name" className="text-xs font-medium">New team name</Label>
            <Input id="team-name" value={name} onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Platform squad" maxLength={80} />
          </div>
          <Button type="submit" size="sm" disabled={creating || !name.trim()}>
            {creating ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" aria-hidden="true" /> : <Plus className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" />}
            Create team
          </Button>
        </form>

        {teams.length === 0 ? (
          <p className="text-sm text-muted-foreground">No teams yet.</p>
        ) : (
          <ul className="space-y-2">
            {teams.map((t) => (
              <li key={t.id} className="border border-border rounded-md px-3 py-2 space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  {renamingId === t.id ? (
                    <>
                      <Input
                        aria-label={`Rename team ${t.name}`}
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        className="h-8 max-w-[220px]"
                        maxLength={80}
                        autoFocus
                      />
                      <Button type="button" size="sm" disabled={busy === t.id} onClick={() => submitRename(t)}>
                        Save
                      </Button>
                      <Button type="button" size="sm" variant="ghost" onClick={() => setRenamingId(null)}>Cancel</Button>
                    </>
                  ) : (
                    <>
                      <span className="text-sm font-medium text-foreground truncate">{t.name}</span>
                      <span className="text-[0.625rem] font-medium px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground whitespace-nowrap">
                        {t.memberCount} member{t.memberCount === 1 ? "" : "s"}
                      </span>
                      <Button type="button" size="sm" variant="ghost" disabled={busy === t.id}
                        aria-label={`Rename team ${t.name}`}
                        onClick={() => { setRenamingId(t.id); setRenameValue(t.name); }}>
                        Rename
                      </Button>
                    </>
                  )}
                  <div className="ml-auto flex items-center gap-1.5">
                    {confirmId === t.id ? (
                      <>
                        <Button type="button" size="sm" variant="destructive" disabled={busy === t.id}
                          onClick={() => { onDelete(t); setConfirmId(null); }}>
                          Confirm delete
                        </Button>
                        <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmId(null)}>Cancel</Button>
                      </>
                    ) : (
                      <Button type="button" size="sm" variant="outline" disabled={busy === t.id}
                        aria-label={`Delete team ${t.name}`} onClick={() => setConfirmId(t.id)}>
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      </Button>
                    )}
                  </div>
                </div>
                {/* "Members: " prefix keeps this text distinct from the bare email spans elsewhere on
                    the page (the Users list, other pickers) — a plain email here would otherwise be
                    ambiguous for anything querying by that user's email address. */}
                <p className="text-xs text-muted-foreground">
                  {t.members.length > 0 ? `Members: ${t.members.map((m) => m.email).join(", ")}` : "No members yet."}
                </p>
                <div className="flex flex-wrap items-end gap-2 pt-1.5 border-t border-border">
                  <div className="min-w-[200px]">
                    <Label htmlFor={`adopt-${t.id}`} className="text-xs font-medium">Adopt data from…</Label>
                    <select
                      id={`adopt-${t.id}`}
                      value={adoptFrom[t.id] ?? ""}
                      onChange={(e) => setAdoptFrom((prev) => ({ ...prev, [t.id]: e.target.value }))}
                      className="flex h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                    >
                      <option value="">Choose a user…</option>
                      {users.map((u) => (
                        <option key={u.id} value={u.id}>{`Adopt from ${u.email}`}</option>
                      ))}
                    </select>
                  </div>
                  <Button type="button" size="sm" variant="outline" disabled={busy === t.id || !adoptFrom[t.id]}
                    onClick={() => { const from = adoptFrom[t.id]; if (from) onAdopt(t.id, from); }}>
                    {busy === t.id ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" aria-hidden="true" /> : null}
                    Adopt
                  </Button>
                  <p className="text-xs text-muted-foreground basis-full">
                    One-time seed — copies that user's existing leaves/retro/meeting notes/etc. into this
                    team. Never overwrites a document the team already has; safe to run more than once.
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * v1.67 (ADR-078) — a 3-state connection indicator: OWN (green, as before), INHERITED (amber, "via
 * <email>" — a borrowed token, distinct from a genuinely absent one), or NONE (muted, as before).
 * Same visual language as the old on/off badge — just one more state, driven by `effective`.
 */
function ConnBadge({ label, status }: { label: string; status: ProviderStatus }) {
  const tone =
    status.status === "own"
      ? "bg-success/15 text-success"
      : status.status === "inherited"
        ? "bg-amber-500/15 text-amber-800 dark:text-amber-300"
        : "bg-muted text-muted-foreground";
  const title =
    status.status === "own"
      ? `${label} connected`
      : status.status === "inherited"
        ? `${label} via ${status.via}`
        : `${label} not connected`;
  return (
    <span className={cn("text-[0.625rem] font-medium px-1.5 py-0.5 rounded-full whitespace-nowrap", tone)} title={title}>
      {label}{status.status === "inherited" ? ` via ${status.via}` : ""}
    </span>
  );
}

function Pill({ children, tone }: { children: React.ReactNode; tone: "primary" | "muted" | "warn" | "danger" }) {
  const tones = {
    primary: "bg-primary/10 text-primary",
    muted: "bg-muted text-muted-foreground",
    warn: "bg-amber-500/15 text-amber-800 dark:text-amber-300",
    danger: "bg-destructive/10 text-destructive",
  } as const;
  return (
    <span className={cn("text-[0.625rem] font-semibold px-1.5 py-0.5 rounded-full whitespace-nowrap", tones[tone])}>
      {children}
    </span>
  );
}

// ── Add-user form ─────────────────────────────────────────────────────────────

function AddUserCard({
  sources, busy, onCreate,
}: {
  sources: AdminUser[];
  busy: boolean;
  onCreate: (input: {
    email: string; password: string; role?: "admin" | "user";
    credentialSourceUserId?: string; allowWrites?: boolean; sharedProviders?: ShareableProvider[];
  }) => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"admin" | "user">("user");
  const [sourceId, setSourceId] = useState("");
  const [allowWrites, setAllowWrites] = useState(false);
  // v1.67 (ADR-078) — all three default CHECKED, preserving today's share-everything default.
  const [shared, setShared] = useState<Record<ShareableProvider, boolean>>({ jira: true, github: true, ai: true });

  function submit(e: FormEvent) {
    e.preventDefault();
    const sharedProviders = collectSharedProviders(shared); // null when all three are checked
    onCreate({
      email: email.trim(),
      password,
      role,
      ...(sourceId ? { credentialSourceUserId: sourceId, allowWrites } : {}),
      // Omit entirely when share-all (null) — that's exactly the legacy default, unchanged.
      ...(sourceId && sharedProviders !== null ? { sharedProviders } : {}),
    });
    setEmail(""); setPassword(""); setSourceId(""); setAllowWrites(false); setRole("user");
    setShared({ jira: true, github: true, ai: true });
  }

  return (
    <Card className="shadow-sm">
      <CardHeader className="px-4 pt-4 pb-2">
        <h2 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
          <UserPlus className="h-4 w-4 text-primary" aria-hidden="true" /> Add user
        </h2>
        <p className="text-xs text-muted-foreground">
          Leave “Credentials” on <em>Their own tokens</em> for a normal teammate. Pick a user to share from
          when the new teammate has no Jira/AI tokens — they'll see that user's boards read-only.
        </p>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        <form onSubmit={submit} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 items-end">
          <div>
            <Label htmlFor="new-email" className="text-xs font-medium">Email</Label>
            <Input id="new-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="new-password" className="text-xs font-medium">Temporary password</Label>
            <Input id="new-password" type="password" required minLength={8} autoComplete="new-password"
              value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="new-role" className="text-xs font-medium">Role</Label>
            <select id="new-role" value={role} onChange={(e) => setRole(e.target.value as "admin" | "user")}
              className="flex h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
              <option value="user">User</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <div>
            <Label htmlFor="new-source" className="text-xs font-medium">Credentials</Label>
            <select id="new-source" value={sourceId} onChange={(e) => setSourceId(e.target.value)}
              className="flex h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
              <option value="">Their own tokens</option>
              {sources.map((s) => (
                <option key={s.id} value={s.id}>Share from {s.email}</option>
              ))}
            </select>
          </div>
          {sourceId && (
            <div className="sm:col-span-2 lg:col-span-3 space-y-1.5">
              <label className="flex items-center gap-2 text-xs text-foreground">
                <input type="checkbox" checked={allowWrites} onChange={(e) => setAllowWrites(e.target.checked)} />
                Allow this user to change Jira (edits will appear under the token owner's name)
              </label>
              <ShareCheckboxes checked={shared} onChange={setShared} />
            </div>
          )}
          <Button type="submit" size="sm" disabled={busy} className="lg:col-start-4">
            {busy ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" aria-hidden="true" /> : null}
            Create user
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

// ── User setup: access (shared credentials) + board/env overrides, saved together ─────────────

/** What UserSetupForm hands back on save — only the parts that actually changed are flagged. */
interface UserSetupInput {
  accessChanged: boolean;
  configChanged: boolean;
  access: {
    email: string;
    credentialSourceUserId: string | null;
    allowWrites: boolean;
    /** v1.67 (ADR-078) — null = share-all (legacy default); an array restricts to those providers. */
    sharedProviders: ShareableProvider[] | null;
  };
  config: AdminConfig;
}

/**
 * v1.52 (ADR-063) — one form for a user's access AND board/env overrides with a SINGLE save, so an
 * admin can't set a shared connection and forget to save the board (the v1.51 field-report bug). It
 * reports its dirty state up (onDirtyChange) so the row can warn before discarding unsaved edits.
 */
function UserSetupForm({
  user, sources, busy, idPrefix, onSave, onDirtyChange,
}: {
  user: AdminUser;
  sources: AdminUser[];
  busy: boolean;
  idPrefix: string;
  onSave: (input: UserSetupInput) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [email, setEmail] = useState(user.email);
  const [sourceId, setSourceId] = useState(user.credentialSourceUserId ?? "");
  const [allowWrites, setAllowWrites] = useState(!!user.allowWrites);
  // v1.67 (ADR-078) — initialized from the saved restriction (null → all three checked).
  const [shared, setShared] = useState<Record<ShareableProvider, boolean>>(() =>
    sharedProvidersToChecked(user.sharedProviders)
  );
  const [values, setValues] = useState<Record<string, string>>(() => toStringMap(user.config));
  const set = (k: string, v: string) => setValues((prev) => ({ ...prev, [k]: v }));
  const options = sources.filter((s) => s.id !== user.id);

  const sharedProviders = collectSharedProviders(shared);

  // Dirty = differs from what's currently saved on the user (props update after a save → auto-clears).
  const accessDirty =
    email.trim() !== user.email ||
    (sourceId || null) !== (user.credentialSourceUserId ?? null) ||
    allowWrites !== !!user.allowWrites ||
    JSON.stringify(sharedProviders) !== JSON.stringify(user.sharedProviders ?? null);
  const configDirty = useMemo(() => configDiffers(values, user.config), [values, user.config]);
  const dirty = accessDirty || configDirty;

  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!dirty) return;
    onSave({
      accessChanged: accessDirty,
      configChanged: configDirty,
      access: { email: email.trim(), credentialSourceUserId: sourceId || null, allowWrites, sharedProviders },
      config: collectConfig(values),
    });
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {/* Access & credentials */}
      <div className="space-y-2">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <div>
            <Label htmlFor={`email-${user.id}`} className="text-xs font-medium">Email</Label>
            <Input id={`email-${user.id}`} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div>
            <Label htmlFor={`src-${user.id}`} className="text-xs font-medium">Credentials</Label>
            <select id={`src-${user.id}`} value={sourceId} onChange={(e) => setSourceId(e.target.value)}
              className="flex h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
              <option value="">Their own tokens</option>
              {options.map((s) => (
                <option key={s.id} value={s.id}>Share from {s.email}</option>
              ))}
            </select>
          </div>
        </div>
        {sourceId && (
          <div className="space-y-1.5">
            <label className="flex items-center gap-2 text-xs text-foreground">
              <input type="checkbox" checked={allowWrites} onChange={(e) => setAllowWrites(e.target.checked)} />
              Allow Jira changes (writes are attributed to the token owner)
            </label>
            <ShareCheckboxes checked={shared} onChange={setShared} />
          </div>
        )}
      </div>

      {/* Board & env overrides */}
      <ConfigFields values={values} set={set} idPrefix={idPrefix} />

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={busy || !dirty}>
          {busy ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" aria-hidden="true" /> : null}
          Save changes
        </Button>
        {dirty && !busy && (
          <span className="text-xs text-warning" role="status">Unsaved changes</span>
        )}
      </div>
    </form>
  );
}

// ── One user row ──────────────────────────────────────────────────────────────

function UserRow({
  user, sources, templates, teams, formEpoch, busy, expanded, confirmingDelete,
  onToggleRole, onToggleExpand, onSaveSetup, onSetPassword, onToggleDisabled, onDelete,
  onRequestDelete, onApplyTemplate, onSetTeam,
}: {
  user: AdminUser;
  sources: AdminUser[];
  templates: ConfigTemplate[];
  teams: TeamView[];
  formEpoch: number;
  busy: boolean;
  expanded: boolean;
  confirmingDelete: boolean;
  onToggleRole: (u: AdminUser) => void;
  onToggleExpand: () => void;
  onSaveSetup: (userId: string, input: UserSetupInput) => void;
  onSetPassword: (userId: string, password: string) => void;
  onToggleDisabled: (u: AdminUser) => void;
  onDelete: (u: AdminUser) => void;
  onRequestDelete: (u: AdminUser | null) => void;
  onApplyTemplate: (userId: string, templateId: string, merge: boolean) => void;
  onSetTeam: (user: AdminUser, teamId: string | null) => void;
}) {
  const isAdmin = user.role === "admin";
  const [password, setPassword] = useState("");
  // v1.52 — track unsaved edits in the setup form so we can warn before the panel is closed.
  const [dirty, setDirty] = useState(false);
  const [confirmingClose, setConfirmingClose] = useState(false);

  // Closing the panel while there are unsaved edits arms an inline "discard?" confirm instead.
  function handleToggle() {
    if (expanded && dirty) { setConfirmingClose(true); return; }
    onToggleExpand();
  }

  return (
    <div className={cn("border rounded-lg", user.disabled ? "border-destructive/30 bg-destructive/[0.03]" : "border-border")}>
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className={cn("h-7 w-7 rounded-full flex items-center justify-center flex-shrink-0",
            isAdmin ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground")}>
            {isAdmin ? <ShieldCheck className="h-4 w-4" aria-hidden="true" /> : <UserIcon className="h-4 w-4" aria-hidden="true" />}
          </span>
          <span className="text-sm font-medium text-foreground truncate">{user.email}</span>
          <Pill tone={isAdmin ? "primary" : "muted"}>{user.role}</Pill>
          {user.sharedFrom && (
            <Pill tone="warn">
              <Share2 className="h-2.5 w-2.5 inline mr-0.5" aria-hidden="true" />
              shared from {user.sharedFrom}
            </Pill>
          )}
          {user.readOnly && <Pill tone="muted">read-only</Pill>}
          {user.disabled && <Pill tone="danger">disabled</Pill>}
          {expanded && dirty && <Pill tone="warn">unsaved</Pill>}
        </div>
        <div className="flex items-center gap-1">
          <ConnBadge label="Jira" status={user.effective.jira} />
          <ConnBadge label="GitHub" status={user.effective.github} />
          <ConnBadge label="AI" status={user.effective.ai} />
        </div>
        <div className="flex items-center gap-1.5">
          <Button type="button" variant="outline" size="sm" onClick={handleToggle}>
            <Settings2 className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" />
            {expanded ? "Close" : "Manage"}
          </Button>
          <Button
            type="button"
            variant={isAdmin ? "outline" : "default"}
            size="sm"
            disabled={busy || user.bootstrapAdmin}
            title={user.bootstrapAdmin ? "Admin via ADMIN_EMAILS — can't be demoted here" : undefined}
            onClick={() => onToggleRole(user)}
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" aria-hidden="true" /> : null}
            {isAdmin ? "Make user" : "Make admin"}
          </Button>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-border px-3 py-3 bg-muted/30 space-y-5">
          {/* Unsaved-changes guard (v1.52) — closing the panel with edits arms this discard confirm. */}
          {confirmingClose && dirty && (
            <div role="alert" className="flex flex-wrap items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-foreground">
              <span className="font-medium">Discard unsaved changes?</span>
              <Button type="button" size="sm" variant="destructive"
                onClick={() => { setConfirmingClose(false); setDirty(false); onToggleExpand(); }}>
                Discard
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmingClose(false)}>
                Keep editing
              </Button>
            </div>
          )}

          {/* Team assignment (v1.73, ADR-084) — a THIRD scope input, separate from Save changes: it
              takes effect immediately, because it changes what documents this user sees, not a
              board/env preference. */}
          <section>
            <p className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
              Team assignment
            </p>
            <div className="max-w-xs">
              <Label htmlFor={`team-${user.id}`} className="text-xs font-medium">Team</Label>
              <select
                id={`team-${user.id}`}
                aria-describedby={`team-warn-${user.id}`}
                value={user.teamId ?? ""}
                disabled={busy}
                onChange={(e) => onSetTeam(user, e.target.value || null)}
                className="flex h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              >
                <option value="">No team</option>
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </div>
            {/* a11y: tied to the select via aria-describedby — always visible, not a one-off toast,
                because this is the single most confusing behavior in the whole feature. */}
            <p id={`team-warn-${user.id}`} className="text-xs text-muted-foreground mt-1.5 max-w-prose">
              Changing a user's team changes what they SEE, not just who they are. Their leaves, retro
              notes, meeting notes, PRs and draft plan switch to the team's shared copies — anything they
              wrote under their own account is kept, but stops being visible to them. To bring a member's
              existing documents into a team the first time, use <strong className="font-medium text-foreground">Adopt data from…</strong> on
              that team in the Teams card above.
            </p>
          </section>

          {/* User setup: access + board/env overrides, saved together in ONE action (v1.52, ADR-063). */}
          <section>
            <p className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
              User setup — access &amp; board overrides
            </p>
            <p className="text-xs text-muted-foreground mb-2">
              Blank board/env fields fall back to {user.sharedFrom ? "the shared user's overrides, then " : ""}the global defaults.
              A single <strong className="font-medium text-foreground">Save changes</strong> saves both access and overrides.
            </p>
            <TemplatePicker
              templates={templates}
              busy={busy}
              id={user.id}
              scope={user.email}
              onApply={(templateId, merge) => onApplyTemplate(user.id, templateId, merge)}
            />
            <UserSetupForm
              key={`${user.id}-${formEpoch}`} // remount so applied template values show up
              user={user}
              sources={sources}
              busy={busy}
              idPrefix={`u-${user.id}`}
              onSave={(input) => onSaveSetup(user.id, input)}
              onDirtyChange={setDirty}
            />
          </section>

          {/* Password */}
          <section>
            <p className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
              Reset password
            </p>
            <form
              onSubmit={(e) => { e.preventDefault(); onSetPassword(user.id, password); setPassword(""); }}
              className="flex flex-wrap items-end gap-2"
            >
              <div className="min-w-[220px]">
                <Label htmlFor={`pw-${user.id}`} className="text-xs font-medium">New password</Label>
                <Input id={`pw-${user.id}`} type="password" minLength={8} required autoComplete="new-password"
                  value={password} onChange={(e) => setPassword(e.target.value)} />
              </div>
              <Button type="submit" size="sm" variant="outline" disabled={busy}>Set password</Button>
            </form>
          </section>

          {/* Danger zone */}
          <section>
            <p className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
              Danger zone
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" variant="outline" disabled={busy || user.bootstrapAdmin}
                title={user.bootstrapAdmin ? "Admin via ADMIN_EMAILS — can't be disabled here" : undefined}
                onClick={() => onToggleDisabled(user)}>
                {user.disabled
                  ? <><Undo2 className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" /> Enable</>
                  : <><Ban className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" /> Disable</>}
              </Button>
              {confirmingDelete ? (
                <>
                  <Button type="button" size="sm" variant="destructive" disabled={busy}
                    onClick={() => onDelete(user)}>
                    Confirm delete
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => onRequestDelete(null)}>Cancel</Button>
                </>
              ) : (
                <Button type="button" size="sm" variant="outline" disabled={busy || user.bootstrapAdmin}
                  title={user.bootstrapAdmin ? "Admin via ADMIN_EMAILS — can't be deleted here" : undefined}
                  onClick={() => onRequestDelete(user)}>
                  <Trash2 className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" /> Delete
                </Button>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function Admin() {
  const [data, setData] = useState<AdminUsersResponse | null>(null);
  const [templates, setTemplates] = useState<ConfigTemplate[]>([]);
  const [teams, setTeams] = useState<TeamView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [savingGlobal, setSavingGlobal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [creatingTemplate, setCreatingTemplate] = useState(false);
  const [creatingTeam, setCreatingTeam] = useState(false);
  const [busyTemplateId, setBusyTemplateId] = useState<string | null>(null);
  const [busyTeamId, setBusyTeamId] = useState<string | null>(null);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // Bumped whenever a template is applied, to remount the config forms with the new values.
  const [formEpoch, setFormEpoch] = useState(0);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [users, tpl, tm] = await Promise.all([getAdminUsers(), getTemplates(), listTeams()]);
      setData(users);
      setTemplates(tpl.templates);
      setTeams(tm.teams);
    } catch (err) { setError(errMsg(err)); }
    finally { setLoading(false); }
  }, []);

  // Re-fetch just the team list — used after any action that changes a team's membership
  // (assigning/clearing a user's team) so member counts/emails stay in sync without a full reload.
  const refreshTeams = useCallback(async () => {
    setTeams((await listTeams()).teams);
  }, []);

  useEffect(() => { void load(); }, [load]);

  function replaceUser(u: AdminUser) {
    setData((d) => (d ? { ...d, users: d.users.map((x) => (x.id === u.id ? u : x)) } : d));
  }

  async function withUser<T>(userId: string, fn: () => Promise<T>, ok?: string): Promise<void> {
    setBusyUserId(userId); setError(null); setNotice(null);
    try {
      await fn();
      if (ok) setNotice(ok);
    } catch (err) { setError(errMsg(err)); }
    finally { setBusyUserId(null); }
  }

  async function onCreate(input: Parameters<typeof createUser>[0]) {
    setCreating(true); setError(null); setNotice(null);
    try {
      const u = await createUser(input);
      setData((d) => (d ? { ...d, users: [...d.users, u] } : d));
      setNotice(`Created ${u.email}${u.sharedFrom ? ` (shares credentials from ${u.sharedFrom})` : ""}.`);
    } catch (err) { setError(errMsg(err)); }
    finally { setCreating(false); }
  }

  const saveGlobal = async (cfg: AdminConfig) => {
    setSavingGlobal(true); setError(null); setNotice(null);
    try {
      const r = await putGlobalConfig(cfg);
      setData((d) => (d ? { ...d, globalConfig: r.globalConfig } : d));
      setNotice("Global defaults saved.");
    } catch (err) { setError(errMsg(err)); }
    finally { setSavingGlobal(false); }
  };

  // v1.52 — one save for a user's access + board/env overrides. They're two endpoints, so fire only
  // the parts that changed; config last so its response reflects the access change too. The panel stays
  // open — the form's dirty state clears once the updated user props flow back, confirming the save.
  const saveUserSetup = (userId: string, input: UserSetupInput) =>
    withUser(userId, async () => {
      let updated: AdminUser | undefined;
      if (input.accessChanged) updated = await updateUser(userId, input.access);
      if (input.configChanged) updated = await putUserConfig(userId, input.config);
      if (updated) replaceUser(updated);
    }, "User settings saved.");

  const setPassword = (userId: string, password: string) =>
    withUser(userId, async () => { replaceUser(await updateUser(userId, { password })); }, "Password updated.");

  const toggleDisabled = (u: AdminUser) =>
    withUser(u.id, async () => { replaceUser(await updateUser(u.id, { disabled: !u.disabled })); },
      u.disabled ? "Account enabled." : "Account disabled.");

  const toggleRole = (u: AdminUser) =>
    withUser(u.id, async () => { replaceUser(await putUserRole(u.id, u.role === "admin" ? "user" : "admin")); });

  const removeUser = (u: AdminUser) =>
    withUser(u.id, async () => {
      await deleteUser(u.id);
      setData((d) => (d ? { ...d, users: d.users.filter((x) => x.id !== u.id) } : d));
      setDeletingId(null);
      setExpandedId(null);
    }, `Deleted ${u.email}.`);

  // ── Templates (v1.47, ADR-057) ──────────────────────────────────────────────

  async function onCreateTemplate(name: string, config: AdminConfig) {
    setCreatingTemplate(true); setError(null); setNotice(null);
    try {
      const tpl = await createTemplate(name, config);
      setTemplates((ts) => [...ts, tpl].sort((a, b) => a.name.localeCompare(b.name)));
      setNotice(`Template "${tpl.name}" created.`);
    } catch (err) { setError(errMsg(err)); }
    finally { setCreatingTemplate(false); }
  }

  async function onDeleteTemplate(t: ConfigTemplate) {
    setBusyTemplateId(t.id); setError(null); setNotice(null);
    try {
      await deleteTemplate(t.id);
      setTemplates((ts) => ts.filter((x) => x.id !== t.id));
      setNotice(`Template "${t.name}" deleted.`);
    } catch (err) { setError(errMsg(err)); }
    finally { setBusyTemplateId(null); }
  }

  const applyToUser = (userId: string, templateId: string, merge: boolean) =>
    withUser(userId, async () => {
      replaceUser(await applyTemplateToUser(userId, templateId, merge));
      setFormEpoch((n) => n + 1);
    }, merge ? "Template merged into the user's config." : "Template applied to the user's config.");

  async function applyToGlobal(templateId: string, merge: boolean) {
    setSavingGlobal(true); setError(null); setNotice(null);
    try {
      const r = await applyTemplateToGlobal(templateId, merge);
      setData((d) => (d ? { ...d, globalConfig: r.globalConfig } : d));
      setFormEpoch((n) => n + 1);
      setNotice(merge ? "Template merged into the global defaults." : "Template applied to the global defaults.");
    } catch (err) { setError(errMsg(err)); }
    finally { setSavingGlobal(false); }
  }

  // ── Teams (v1.73, ADR-084) ───────────────────────────────────────────────────

  async function onCreateTeam(name: string) {
    setCreatingTeam(true); setError(null); setNotice(null);
    try {
      const t = await createTeam(name);
      setTeams((ts) => [...ts, t].sort((a, b) => a.name.localeCompare(b.name)));
      setNotice(`Team "${t.name}" created.`);
    } catch (err) { setError(errMsg(err)); }
    finally { setCreatingTeam(false); }
  }

  async function onRenameTeam(team: TeamView, name: string) {
    setBusyTeamId(team.id); setError(null); setNotice(null);
    try {
      const t = await updateTeam(team.id, { name });
      setTeams((ts) => ts.map((x) => (x.id === t.id ? t : x)).sort((a, b) => a.name.localeCompare(b.name)));
      setNotice(`Team renamed to "${t.name}".`);
    } catch (err) { setError(errMsg(err)); }
    finally { setBusyTeamId(null); }
  }

  async function onDeleteTeam(team: TeamView) {
    setBusyTeamId(team.id); setError(null); setNotice(null);
    try {
      await deleteTeam(team.id);
      setTeams((ts) => ts.filter((x) => x.id !== team.id));
      setNotice(`Team "${team.name}" deleted.`);
    } catch (err) { setError(errMsg(err)); } // surfaces 409 IN_USE verbatim (lists blocking member emails)
    finally { setBusyTeamId(null); }
  }

  // One-time, non-destructive seed — copies fromUserId's existing personal docs into the team's scope.
  async function onAdoptIntoTeam(teamId: string, fromUserId: string) {
    setBusyTeamId(teamId); setError(null); setNotice(null);
    try {
      const result = await adoptIntoTeam(teamId, fromUserId);
      setNotice(`Copied ${result.copied.length} document(s); skipped ${result.skipped.length} (already present or empty).`);
    } catch (err) { setError(errMsg(err)); }
    finally { setBusyTeamId(null); }
  }

  // Assigning/clearing a user's team is a SCOPE change, not a form field — it takes effect the
  // moment it's chosen (see the persistent warning next to the selector in UserRow).
  const setTeamForUser = (user: AdminUser, teamId: string | null) =>
    withUser(user.id, async () => {
      replaceUser(await setUserTeam(user.id, teamId));
      await refreshTeams(); // membership changed → keep each team's member count/emails in sync
    }, "Team assignment updated.");

  // Users who can lend credentials: they own a Jira connection and borrow from nobody.
  const sources = (data?.users ?? []).filter((u) => u.canBeSource);

  return (
    <div className="space-y-4 max-w-5xl">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-5 w-5 text-primary" aria-hidden="true" />
        <h1 className="text-lg font-bold text-foreground">Admin console</h1>
        <Button type="button" variant="ghost" size="sm" className="ml-auto" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={cn("h-3.5 w-3.5 mr-1.5", loading && "animate-spin")} aria-hidden="true" /> Refresh
        </Button>
      </div>

      {error && (
        <p className="text-sm text-destructive flex items-center gap-1.5" role="alert">
          <AlertCircle className="h-4 w-4 flex-shrink-0" aria-hidden="true" /> {error}
        </p>
      )}
      {notice && (
        <p className="text-sm text-success flex items-center gap-1.5" role="status">
          <CheckCircle2 className="h-4 w-4 flex-shrink-0" aria-hidden="true" /> {notice}
        </p>
      )}

      {loading && !data ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-6">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading users…
        </div>
      ) : (
        <>
          <AddUserCard sources={sources} busy={creating} onCreate={onCreate} />

          <TemplatesCard
            templates={templates}
            busy={busyTemplateId}
            creating={creatingTemplate}
            onCreate={(name, cfg) => void onCreateTemplate(name, cfg)}
            onDelete={(t) => void onDeleteTemplate(t)}
          />

          <TeamsCard
            teams={teams}
            users={data?.users ?? []}
            busy={busyTeamId}
            creating={creatingTeam}
            onCreate={(name) => void onCreateTeam(name)}
            onRename={(t, name) => void onRenameTeam(t, name)}
            onDelete={(t) => void onDeleteTeam(t)}
            onAdopt={(teamId, fromUserId) => void onAdoptIntoTeam(teamId, fromUserId)}
          />

          <Card className="shadow-sm">
            <CardHeader className="px-4 pt-4 pb-2">
              <h2 className="text-sm font-semibold text-foreground">
                Users {data ? <span className="text-muted-foreground font-normal">({data.users.length})</span> : null}
              </h2>
            </CardHeader>
            <CardContent className="px-4 pb-4 space-y-2">
              {data && data.users.length > 0 ? (
                data.users.map((u) => (
                  <UserRow
                    key={u.id}
                    user={u}
                    sources={sources}
                    templates={templates}
                    teams={teams}
                    formEpoch={formEpoch}
                    busy={busyUserId === u.id}
                    expanded={expandedId === u.id}
                    confirmingDelete={deletingId === u.id}
                    onToggleRole={toggleRole}
                    onToggleExpand={() => setExpandedId((cur) => (cur === u.id ? null : u.id))}
                    onSaveSetup={saveUserSetup}
                    onSetPassword={setPassword}
                    onToggleDisabled={toggleDisabled}
                    onDelete={removeUser}
                    onRequestDelete={(target) => setDeletingId(target ? target.id : null)}
                    onApplyTemplate={applyToUser}
                    onSetTeam={setTeamForUser}
                  />
                ))
              ) : (
                <p className="text-sm text-muted-foreground py-2">No users yet.</p>
              )}
            </CardContent>
          </Card>

          <Card className="shadow-sm">
            <CardHeader className="px-4 pt-4 pb-2">
              <h2 className="text-sm font-semibold text-foreground">Global defaults</h2>
              <p className="text-xs text-muted-foreground">
                Applied to every user; a user's own connection and per-user overrides win. Tokens are never set here.
              </p>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <TemplatePicker
                templates={templates}
                busy={savingGlobal}
                id="global"
                scope="global defaults"
                onApply={(templateId, merge) => void applyToGlobal(templateId, merge)}
              />
              <ConfigForm
                key={`global-${formEpoch}`} // remount so applied template values show up
                idPrefix="cfg"
                initial={data?.globalConfig ?? {}}
                saving={savingGlobal}
                submitLabel="Save global defaults"
                onSave={saveGlobal}
              />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
