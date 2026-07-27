// Deterministic PO-story rollup builder — CONTRACTS.md §4.9 `draft-po-story` / §6
// "New PO from Dev tasks" mode (v1.72, ADR-083). PURE: no side effects, no network,
// no React — the client-side fallback when AI is off/unavailable, same convention
// as ticketTemplates.ts's deterministic builders.

/** Cap applied to each Dev ticket's description before it's embedded in the rollup. */
export const DESC_CAP = 4000;

/**
 * Truncate `text` to DESC_CAP chars, appending a "… (truncated)" marker when cut.
 * Moved verbatim from Linking.tsx's PO_DESC_CAP/capDesc (same behaviour, generalized
 * name since this module serves Dev-task descriptions, not just PO ones).
 */
export function capDesc(text: string): string {
  const t = (text ?? "").trim();
  return t.length <= DESC_CAP ? t : t.slice(0, DESC_CAP) + "\n… (truncated)";
}

export interface PoRollupDevTicket {
  key: string;
  summary: string;
  description?: string;
}

export interface PoRollupDraft {
  summary: string;
  description: string;
}

/**
 * Build a deterministic single PO story draft that covers N existing Dev tickets —
 * the client-side fallback for `POST /api/ai/draft-po-story` (CONTRACTS.md §4.9) when
 * AI is off/unavailable. Empty input returns a safe empty-ish draft rather than throwing.
 */
export function buildPoRollupDraft(
  devTickets: PoRollupDevTicket[]
): PoRollupDraft {
  if (devTickets.length === 0) {
    return {
      summary: "",
      description: `## User Story

As a user,
I want [describe the feature],
so that [describe the benefit].

## Delivered by

(no Dev tasks selected)

## Acceptance Criteria

**Given** [a precondition / starting state]
**When** [the user performs an action]
**Then** [an observable outcome occurs]`,
    };
  }

  const [first, ...rest] = devTickets;
  const rawSummary =
    rest.length > 0 ? `${first.summary} (+${rest.length} more)` : first.summary;
  const summary =
    rawSummary.length <= 255 ? rawSummary : rawSummary.slice(0, 252) + "…";

  const deliveredBy = devTickets
    .map((t) => `- ${t.key} — ${t.summary}`)
    .join("\n");

  const withDescription = devTickets.filter((t) => (t.description ?? "").trim() !== "");
  const sourceSection =
    withDescription.length > 0
      ? `

## Source Dev tasks

${withDescription
  .map((t) => `### ${t.key}\n\n${capDesc(t.description ?? "")}`)
  .join("\n\n")}`
      : "";

  const description = `## User Story

As a user,
I want the work delivered by the Dev tasks below,
so that the combined outcome is available as one PO story.

## Delivered by

${deliveredBy}

## Acceptance Criteria

**Given** [a precondition / starting state]
**When** [the user performs an action]
**Then** [an observable outcome occurs]

**Given** [another scenario]
**When** [the user performs an action]
**Then** [another observable outcome]${sourceSection}`;

  return { summary, description };
}
