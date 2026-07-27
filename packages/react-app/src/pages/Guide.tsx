// Guide (v1.49, ADR-060) — an in-app user guide. Reached from the header "Guide" button rather
// than a tab, to keep the tab bar uncluttered (per the v1.48 UI review). Static content that
// mirrors docs/USER-GUIDE.md, written for reading inside the app. A sticky table of contents on
// wide screens; a plain anchored list on mobile.

import type { ReactNode } from "react";
import {
  BookOpen, PlayCircle, LayoutDashboard, CalendarRange, CalendarDays, Link2, BarChart3,
  Plug, ShieldCheck, MessageCircle, HelpCircle, Terminal, Table2,
} from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  TOOL_GROUPS, toolsByGroup, type ToolGroup, type ToolSurface, type ToolAccess, type ToolCatalogEntry,
} from "../lib/toolCatalog";

type Section = { id: string; title: string; icon: typeof BookOpen; body: ReactNode };

// A term the reader recognises in the UI (bold), used consistently across sections.
function T({ children }: { children: ReactNode }) {
  return <strong className="font-semibold text-foreground">{children}</strong>;
}

// ── MCP tool reference helpers (v1.56, ADR-067) ─────────────────────────────────
// Page-local presentational pieces for the "Tool reference" section's per-group tables.

const SURFACE_LABEL: Record<ToolSurface, string> = { jira: "Jira", github: "GitHub", local: "Local" };
const AI_LABEL: Record<ToolCatalogEntry["aiAssistant"], string> = { read: "Ask", propose: "Propose", none: "—" };

function ToolTypeBadge({ surface, access }: { surface: ToolSurface; access: ToolAccess }) {
  const cls =
    access === "read"
      ? "border-info-border text-info bg-info-bg"
      : "border-warning-border text-warning-foreground bg-warning-bg";
  return (
    <Badge variant="outline" className={`text-[0.625rem] font-medium whitespace-nowrap ${cls}`}>
      {SURFACE_LABEL[surface]} · {access === "read" ? "Read" : "Write"}
    </Badge>
  );
}

function ToolGroupTable({ group }: { group: ToolGroup }) {
  const rows = toolsByGroup(group);
  return (
    <div className="mb-5 last:mb-0">
      <h3 className="text-sm font-semibold text-foreground mb-1.5">{group}</h3>
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-xs" aria-label={`${group} tools`}>
          <thead>
            <tr className="border-b border-border bg-muted/40 text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
              <th className="text-left py-1.5 px-2.5">Tool</th>
              <th className="text-left py-1.5 px-2.5">What it does</th>
              <th className="text-left py-1.5 px-2.5">Type</th>
              <th className="text-left py-1.5 px-2.5">AI</th>
              <th className="text-left py-1.5 px-2.5">Used in the app</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.name} className="border-b border-border/50 last:border-0 align-top">
                <td className="py-1.5 px-2.5"><code className="text-[0.6875rem] font-mono text-foreground">{t.name}</code></td>
                <td className="py-1.5 px-2.5 text-muted-foreground">{t.blurb}</td>
                <td className="py-1.5 px-2.5"><ToolTypeBadge surface={t.surface} access={t.access} /></td>
                <td className="py-1.5 px-2.5 text-muted-foreground">{AI_LABEL[t.aiAssistant]}</td>
                <td className="py-1.5 px-2.5 text-muted-foreground">{t.appSurface ?? "VS Code Copilot only"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const SECTIONS: Section[] = [
  {
    id: "getting-started",
    title: "Getting started",
    icon: PlayCircle,
    body: (
      <>
        <p>Three steps and you're in:</p>
        <ol className="list-decimal pl-5 space-y-1.5 mt-2">
          <li><T>Sign in</T> (or create an account) on the login screen.</li>
          <li>
            Open <T>Connections</T> and add your own <T>Jira</T> and <T>GitHub</T> tokens — and an{" "}
            <T>AI</T> token if you want the AI features. The app unlocks the moment Jira and GitHub are connected.
          </li>
          <li>
            Pick your <T>board</T> (PO or Dev) and <T>sprint</T> from the top-right. That choice is shared
            across the Huddle, Planning and Reports.
          </li>
        </ol>
        <p className="mt-3">
          If an admin set you up on <T>shared credentials</T>, you'll see a <T>Read-only</T> badge in the
          header: you can view everything but not change Jira. Ask an admin to enable writes for you, or
          connect your own Jira token on Connections to act as yourself.
        </p>
      </>
    ),
  },
  {
    id: "huddle",
    title: "Huddle — your daily standup",
    icon: LayoutDashboard,
    body: (
      <>
        <p>The run-the-standup home screen.</p>
        <ul className="list-disc pl-5 space-y-1.5 mt-2">
          <li><T>Sprint board</T> — the sprint's issues in <T>To Do · In Progress · Code Review · Done</T>, with points, assignee and a “has-PR” badge; filter by assignee.</li>
          <li><T>Daily huddle digest</T> — a copy-pastable summary, viewable by status or <T>by person</T> for walk-the-board standups.</li>
          <li><T>Sidebar cards</T> (each collapses via the chevron; your choices are remembered): <T>Meeting goal</T>, <T>Meeting notes</T> (rich text), <T>Impediments</T>, <T>On leave</T>, and <T>Code review</T> (linked PRs + approval status).</li>
          <li><T>Fly-in tracker</T> across the Dev and PO boards, plus auto-refresh with a “last updated” stamp.</li>
          <li>
            <T>Ticket aging</T> — the sprint board's in-progress and code-review tickets each show an age
            chip, and the sidebar's <T>Ticket aging</T> card lists them worst-first. Age is measured from
            the Jira changelog (time since the ticket entered its current column); the “expected” days is
            base days + days-per-point × story points (an unpointed ticket uses base days alone), both
            admin-configurable. A ticket is <T>ok</T> under 100% of that expectation, <T>watch</T> from
            100–150%, and <T>overdue</T> beyond 150%. Tickets with no changelog history show no age at
            all — never a guess.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "planning",
    title: "Planning — grooming & sprint prep",
    icon: CalendarRange,
    body: (
      <ul className="list-disc pl-5 space-y-1.5">
        <li><T>Create a sprint</T> and target new tickets into it.</li>
        <li><T>Ticket generator</T> — draft PO stories and Dev tasks (AI-assisted when AI is on, deterministic templates otherwise), created straight into the chosen board.</li>
        <li><T>Leaves &amp; capacity</T> — plot each teammate's leave by type; the plotter shows each developer's remaining capacity.</li>
        <li><T>Assignment list</T> — assign the sprint's tickets (bulk-assign supported), edit story points inline, and change status or move a ticket between sprints.</li>
        <li><T>Team roster</T> — curate the people InvokeBoard plans around.</li>
      </ul>
    ),
  },
  {
    id: "offset",
    title: "Offset Tracker — leaves & offset wallet",
    icon: CalendarDays,
    body: (
      <ul className="list-disc pl-5 space-y-1.5">
        <li><T>Typed leaves</T> — Vacation, Emergency, Holiday and <T>Offset</T> days per person.</li>
        <li><T>Offset wallet</T> — earned offset banks automatically each sprint; spending auto-deducts from Offset leaves. See each developer's balance and a full <T>history</T> of earns and spends.</li>
      </ul>
    ),
  },
  {
    id: "linking",
    title: "Linking — connect PO stories and Dev tasks, both directions",
    icon: Link2,
    body: (
      <ul className="list-disc pl-5 space-y-1.5">
        <li>Three modes, switched at the top of the page. Both sprint pickers stay on screen — what they <T>mean</T> changes per mode (source vs. target).</li>
        <li><T>Create Dev tasks</T> — select PO stories and bulk-create linked Dev tasks, with an AI plan drafted from each story's description. <T>Point-driven breakdown</T> auto-splits a story's points into one or two Dev tasks (e.g. 4 → 2 + 2), each with its own points and assignee.</li>
        <li><T>Link existing</T> — pick a target PO story, then tick any number of <T>existing</T> Dev tickets and link them at once (many Dev tickets can hang off one PO story). Filter by assignee or show only tickets with no PO link; already-linked pairs are skipped, not duplicated.</li>
        <li><T>Unlink</T> — every link badge has an unlink control (click to arm, click again to confirm) for fixing a wrong link without leaving InvokeBoard.</li>
        <li><T>New PO from Dev tasks</T> — the inverse: select existing Dev tickets and let the AI draft <T>one PO story covering all of them</T>, points pre-filled with their sum. Edit, then create and link in one step. With AI off it falls back to a deterministic template.</li>
        <li>Links are created so the <T>PO story “depends on” its Dev task(s)</T>.</li>
      </ul>
    ),
  },
  {
    id: "reports",
    title: "Reports — sprint review & metrics",
    icon: BarChart3,
    body: (
      <ul className="list-disc pl-5 space-y-1.5">
        <li><T>Per-sprint report</T> — committed vs. completed points, completion rate and a by-assignee table (code-review-complete counts as done, per your Definition of Done).</li>
        <li><T>Velocity</T> — the average of recent closed sprints, capacity-adjusted for leave.</li>
        <li><T>Retrospective</T> — a persisted retro that also pre-fills the full-report export.</li>
        <li><T>Export</T> — Copy (Markdown), a printable <T>PDF</T>, or a styled <T>Excel</T> workbook with a per-member table (points + leaves by type + offset balance).</li>
        <li><T>AI executive summary</T> — an on-demand narrative of the sprint (when AI is on).</li>
        <li>
          <T>Trends & KPIs</T> — a second mode (toggle next to the board switcher) that reports across a
          whole window of sprints instead of just one: committed/completed points, rate, carryover and
          blocked counts per sprint, team-wide averages, and a per-developer view (pick a name to see
          their trend). The window defaults to a <T>date range</T> pre-filled to the span of the last 10
          closed sprints — or choose <T>last N</T> closed sprints instead, or <T>pick sprints</T>
          individually — then export the same way (Copy, .md, .csv). Per-developer KPIs are
          leave-adjusted: each plotted leave day (Vacation, Emergency, Holiday, or Offset) reduces that
          developer's sprint target by a point, and their per-sprint <T>met target</T> mark reflects that
          adjusted number, not the flat team target.
        </li>
      </ul>
    ),
  },
  {
    id: "connections",
    title: "Connections — your accounts",
    icon: Plug,
    body: (
      <p>
        Connect and disconnect your own <T>Jira</T>, <T>GitHub</T> and <T>AI</T> tokens here. Tokens are
        encrypted at rest and are <T>never shown back to you</T> — only a masked “…last4” hint. Your AI
        token is what powers the assistant.
      </p>
    ),
  },
  {
    id: "admin",
    title: "Admin — team management",
    icon: ShieldCheck,
    body: (
      <>
        <p className="text-xs font-medium text-muted-foreground mb-2">Visible to admins only.</p>
        <ul className="list-disc pl-5 space-y-1.5">
          <li><T>Users</T> — create accounts, reset passwords, promote/demote, disable, or delete.</li>
          <li><T>Shared credentials</T> — onboard a viewer who has no tokens of their own by pointing them at another user's Jira/GitHub/AI. They're read-only against Jira unless you allow writes.</li>
          <li><T>Board &amp; env config</T> — set defaults globally or per-user, and save reusable <T>templates</T> you can apply to any user or to the global defaults.</li>
        </ul>
      </>
    ),
  },
  {
    id: "assistant",
    title: "AI assistant — the floating chat",
    icon: MessageCircle,
    body: (
      <>
        <p>The button in the lower-right is on every page (when AI is connected). Use it to:</p>
        <ul className="list-disc pl-5 space-y-1.5 mt-2">
          <li><T>Ask</T> about the current sprint — “what's in code review?”, “who owns VRDB-1234?”, “any impediments today?”</li>
          <li><T>Propose changes</T> — update points, move a ticket, set a sprint goal, file leave — each shown for <T>confirmation before it's applied</T>. Nothing changes without your OK.</li>
        </ul>
      </>
    ),
  },
  {
    id: "mcp-tools",
    title: "Using the MCP tools",
    icon: Terminal,
    body: (
      <>
        <p>
          Everything in InvokeBoard runs on <T>52 MCP tools</T> spread across two servers —{" "}
          <T>mcp-jira</T> and <T>mcp-github</T>. There are two ways to reach them.
        </p>

        <p className="mt-3">
          <T>1. VS Code Copilot Chat.</T> Open the repo in VS Code and Copilot auto-loads both
          servers from <code className="font-mono text-xs">.vscode/mcp.json</code> — nothing to
          configure. All 52 tools are available there, including a few with no dashboard button at
          all, like <code className="font-mono text-xs">sync_pr_links</code>,{" "}
          <code className="font-mono text-xs">get_pr</code> and{" "}
          <code className="font-mono text-xs">get_pr_reviews</code>. Try asking:
        </p>
        <ul className="list-disc pl-5 space-y-1.5 mt-2">
          <li><em>“Create a PO story and a linked dev task for CSV export on the Reports page.”</em></li>
          <li><em>“What's our velocity over the last 6 sprints on the Dev board?”</em></li>
          <li><em>“Sync PR links across every open PR in the repo.”</em></li>
        </ul>

        <p className="mt-3">
          <T>2. The floating AI assistant</T> (bottom-right, every page). Ask a question and it
          answers using 19 read-only tools; ask for a change and it proposes one of <T>7 writes</T>{" "}
          — always shown for confirmation before anything happens. It calls no GitHub tools today.
          Try asking:
        </p>
        <ul className="list-disc pl-5 space-y-1.5 mt-2">
          <li><em>“What's in code review right now?”</em></li>
          <li>
            <em>“Set VRDB-2712 to 5 points.”</em> — proposes an <T>update_ticket</T>{" "}
            change and shows it to you for confirmation before anything is applied.
          </li>
        </ul>

        <p className="mt-3">
          <T>Two kinds of data.</T> Some tools read or write real Jira or GitHub, like{" "}
          <code className="font-mono text-xs">get_ticket</code>,{" "}
          <code className="font-mono text-xs">transition_issue</code> and{" "}
          <code className="font-mono text-xs">link_pr_to_ticket</code>. Others read or write{" "}
          InvokeBoard's own local stores — team data Jira has no field for — like{" "}
          <code className="font-mono text-xs">get_leaves</code>,{" "}
          <code className="font-mono text-xs">get_impediments</code> and{" "}
          <code className="font-mono text-xs">get_offset_ledger</code>. The <T>Tool reference</T>{" "}
          below marks each tool <T>Jira</T>, <T>GitHub</T> or <T>Local</T>.
        </p>

        <p className="mt-3">
          On <T>shared credentials</T>, every read works as normal. Writes that touch real Jira
          need an admin to grant write access first — otherwise you'll see a read-only error.
          Writes to InvokeBoard's own local stores work either way.
        </p>
      </>
    ),
  },
  {
    id: "tool-reference",
    title: "Tool reference",
    icon: Table2,
    body: (
      <>
        <p>Every tool InvokeBoard and Copilot can call, grouped by what it does.</p>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground pb-3 mb-4 border-b border-border">
          <span className="inline-flex items-center gap-1.5">
            <ToolTypeBadge surface="jira" access="read" /> observes only
          </span>
          <span className="inline-flex items-center gap-1.5">
            <ToolTypeBadge surface="jira" access="write" /> changes data — the assistant always
            asks first
          </span>
          <span>Jira / GitHub = the real service · Local = InvokeBoard's own store, not Jira</span>
          <span>
            AI column: Ask = the assistant can read it · Propose = it can suggest the change (you
            confirm) · — = app/Copilot only
          </span>
        </div>

        {TOOL_GROUPS.map((g) => (
          <ToolGroupTable key={g} group={g} />
        ))}
      </>
    ),
  },
  {
    id: "tips",
    title: "Tips & troubleshooting",
    icon: HelpCircle,
    body: (
      <ul className="list-disc pl-5 space-y-1.5">
        <li><T>Board switcher</T> (top-right) flips PO ⇄ Dev context; Linking works across both.</li>
        <li>Every Huddle sidebar card collapses via the chevron in its header — handy on long sprints.</li>
        <li><T>“Bridge is offline”</T> — a page can't reach the Jira/GitHub server. Ask whoever runs InvokeBoard to start the bridges.</li>
        <li><T>A report looks empty?</T> Check the board is right and the sprint has issues assigned to your rostered team.</li>
        <li><T>Security</T> — tokens live only in the server config or the encrypted per-user vault; they're never logged or sent to your browser.</li>
      </ul>
    ),
  },
];

export function Guide() {
  return (
    <div className="max-w-5xl mx-auto">
      <header className="mb-6">
        <h1 className="text-xl font-bold text-foreground flex items-center gap-2">
          <BookOpen className="h-5 w-5 text-primary" aria-hidden="true" /> Using InvokeBoard
        </h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
          InvokeBoard turns your Jira sprint into a live board, a daily-huddle digest, planning and
          reporting tools, leave tracking, and an AI helper. Here's what each part does.
        </p>
      </header>

      <div className="lg:grid lg:grid-cols-[210px_minmax(0,1fr)] lg:gap-8">
        {/* Table of contents */}
        <nav aria-label="Guide contents" className="mb-5 lg:mb-0">
          <div className="lg:sticky lg:top-16">
            <p className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground mb-2">
              On this page
            </p>
            <ul className="space-y-0.5">
              {SECTIONS.map((s) => (
                <li key={s.id}>
                  <a
                    href={`#${s.id}`}
                    className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[0.8125rem] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <s.icon className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
                    <span className="truncate">{s.title}</span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </nav>

        {/* Sections */}
        <div className="space-y-4 min-w-0">
          {SECTIONS.map((s) => (
            <section key={s.id} id={s.id} className="scroll-mt-16">
              <Card className="shadow-sm">
                <CardHeader className="px-4 pt-4 pb-2">
                  <h2 className="text-base font-semibold text-foreground flex items-center gap-2">
                    <span className="h-7 w-7 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
                      <s.icon className="h-4 w-4 text-primary" aria-hidden="true" />
                    </span>
                    {s.title}
                  </h2>
                </CardHeader>
                <CardContent className="px-4 pb-4 text-sm text-muted-foreground leading-relaxed">
                  {s.body}
                </CardContent>
              </Card>
            </section>
          ))}

          <p className="text-xs text-muted-foreground pt-1">
            Setting up InvokeBoard for a team (connecting Jira, enabling AI, deploying) is covered in the
            project's <code className="font-mono">docs/</code> folder — see <code className="font-mono">USER-GUIDE.md</code> and <code className="font-mono">SETUP.md</code>.
          </p>
        </div>
      </div>
    </div>
  );
}
