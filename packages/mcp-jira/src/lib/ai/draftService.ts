/**
 * AI drafting service — builds system prompts and orchestrates provider calls.
 *
 * Uses zod/v4 schemas for AI output shapes (required by zodOutputFormat).
 * All other zod usage stays on the v3 API ("zod").
 *
 * Per contract §4.9: system prompts follow the same ticket conventions as
 * lib/prompts.ts (user-story phrasing, Given/When/Then ACs, dev implementation
 * checklist, "## " headings + "- " bullets so textToAdf works).
 */

import * as z from "zod/v4";
import type { AiProvider } from "./provider.js";
import { AnthropicProvider } from "./anthropicProvider.js";
import { GithubProvider } from "./githubProvider.js";
import { UpstreamError } from "../errors.js";

// ---------------------------------------------------------------------------
// Output schemas (zod/v4 — required by zodOutputFormat for Anthropic)
// ---------------------------------------------------------------------------

export const DraftTicketsOutputSchema = z.object({
  assistantMessage: z.string(),
  po: z.object({
    summary: z.string(),
    description: z.string(),
    storyPoints: z.number().nullable(),
  }),
  dev: z.object({
    summary: z.string(),
    description: z.string(),
  }),
});

export type DraftTicketsOutput = z.infer<typeof DraftTicketsOutputSchema>;

export const EnhanceTicketOutputSchema = z.object({
  assistantMessage: z.string(),
  summary: z.string(),
  description: z.string(),
});

export type EnhanceTicketOutput = z.infer<typeof EnhanceTicketOutputSchema>;

export const SprintSummaryOutputSchema = z.object({
  summary: z.string(),
});

export type SprintSummaryOutput = z.infer<typeof SprintSummaryOutputSchema>;

// v1.11 (ADR-022): bulk plan — one Dev draft per PO story.
export const PlanDevTicketsOutputSchema = z.object({
  assistantMessage: z.string(),
  items: z.array(
    z.object({
      poKey: z.string(),
      devSummary: z.string(),
      devDescription: z.string(),
    })
  ),
});

export type PlanDevTicketsOutput = z.infer<typeof PlanDevTicketsOutputSchema>;

// v1.72 (ADR-083): roll N existing Dev tasks up into ONE PO story — the inverse of plan-dev-tickets.
export const DraftPoStoryOutputSchema = z.object({
  assistantMessage: z.string(),
  summary: z.string(),
  description: z.string(),
});

export type DraftPoStoryOutput = z.infer<typeof DraftPoStoryOutputSchema>;

// ---------------------------------------------------------------------------
// System prompts — same conventions as lib/prompts.ts
// ---------------------------------------------------------------------------

const DRAFT_SYSTEM = `You are an expert Agile coach helping a Product Owner create well-structured Jira tickets.

IMPORTANT: You MUST return a JSON object matching this schema exactly (no extra fields):
{
  "assistantMessage": "short conversational reply (what you understood, what you improved, any assumptions made)",
  "po": {
    "summary": "concise story summary max 255 chars",
    "description": "full description with ## headings and - bullets",
    "storyPoints": null or a number (Fibonacci: 1,2,3,5,8,13)
  },
  "dev": {
    "summary": "concise technical task summary max 255 chars",
    "description": "full technical description with ## headings and - bullets"
  }
}

Description format — use EXACTLY these conventions so the text converts cleanly to Atlassian Document Format:
- Use "## " headings (level 2/3)
- Use "- " bullet list items
- Blank lines between paragraphs

PO Story description template:
## User Story
As a [specific role], I want [clear goal], so that [concrete business benefit].

## Acceptance Criteria
- Given [initial context] / When [action taken] / Then [expected outcome]
- Given [initial context] / When [action taken] / Then [expected outcome]
- Given [initial context] / When [action taken] / Then [expected outcome]

## Out of Scope
- [explicit exclusions]

Dev Task description template:
## Overview
[Technical summary of what needs to be built]

## Implementation Checklist
- [ ] [concrete implementation step]
- [ ] [concrete implementation step]
- [ ] [concrete implementation step]

## Acceptance Criteria
- Given [technical precondition] / When [action] / Then [verifiable result]

## Notes
[Technical notes, dependencies, risks]

BEHAVIOUR:
- Analyse the full conversation history to understand evolving requirements.
- Enhance terse input into detailed professional tickets.
- Put your assumptions/clarifications in assistantMessage (short, conversational, 1-3 sentences).
- Descriptions must be detailed and professional.
- storyPoints must be null or a Fibonacci number (1, 2, 3, 5, 8, or 13).`;

const SPRINT_SUMMARY_SYSTEM = `You are an expert Agile coach writing a concise, professional sprint-review executive summary.

IMPORTANT: You MUST return a JSON object matching this schema exactly (no extra fields):
{
  "summary": "a 3-6 sentence executive summary followed by a short highlights/risks/next structure"
}

Write in plain prose (markdown is OK). Your summary should cover:
1. What was committed vs delivered (reference the points and completion rate).
2. Notable carryover or blockers (if any).
3. Brief per-team/assignee observations (if relevant from the data).
4. A forward-looking note about next sprint capacity.

Structure (inside the summary string, markdown ok):
[3-6 sentences of executive prose]

**Highlights:** [what went well]
**Risks / Watch:** [carryover, blockers, concerns]
**Next:** [forward note — capacity, items to pick up, etc.]

Keep the tone concise and professional (appropriate for a sprint review or retro).`;

const ENHANCE_SYSTEM = `You are an expert Agile coach helping improve an existing Jira ticket.

IMPORTANT: You MUST return a JSON object matching this schema exactly (no extra fields):
{
  "assistantMessage": "short conversational summary of what you improved and why",
  "summary": "improved ticket summary (max 255 chars)",
  "description": "full rewritten description with ## headings and - bullets"
}

Description format — use EXACTLY these conventions so the text converts cleanly to Atlassian Document Format:
- Use "## " headings (level 2/3)
- Use "- " bullet list items
- Blank lines between paragraphs

Rewrite the ticket description to include:

## Context
Why this work is needed; business driver.

## Scope
What is and is NOT included.

## Acceptance Criteria
- Given [initial context] / When [action taken] / Then [expected outcome]
- Given [initial context] / When [action taken] / Then [expected outcome]
- Given [initial context] / When [action taken] / Then [expected outcome]

BEHAVIOUR:
- Preserve real facts from the existing ticket (don't invent information).
- Incorporate the user's notes/refinement instructions.
- Put your improvements summary in assistantMessage (short, conversational, 1-3 sentences).
- Keep the summary under 255 characters.`;

const PLAN_DEV_SYSTEM = `You are an expert Agile coach and tech lead. For EACH Product Owner story you are given, plan and draft the single developer Task needed to deliver it.

IMPORTANT: You MUST return a JSON object matching this schema exactly (no extra fields):
{
  "assistantMessage": "1-3 sentence overview of the plan and any cross-cutting assumptions",
  "items": [
    {
      "poKey": "the EXACT PO key as given (e.g. PO-42)",
      "devSummary": "concise technical task summary, max 255 chars",
      "devDescription": "full technical description with ## headings and - bullets"
    }
  ]
}

Return EXACTLY one item per PO story, using its exact key. Do NOT invent extra POs or omit any.

Description format — use EXACTLY these conventions so the text converts cleanly to Atlassian Document Format:
- Use "## " headings
- Use "- " bullet list items
- Blank lines between paragraphs

Dev Task description template:
## Overview
[What needs to be built to deliver this PO story]

## Implementation Checklist
- [ ] [concrete implementation step]
- [ ] [concrete implementation step]

## Acceptance Criteria
- Given [technical precondition] / When [action] / Then [verifiable result]

## Notes
[Dependencies, risks, sequencing relative to the other tasks]

BEHAVIOUR:
- Exactly one dev task per PO story; reference that story's intent.
- Keep each devSummary under 255 characters.
- Be concrete and technical; note dependencies between tasks where relevant.`;

// v1.72 (ADR-083): the INVERSE of PLAN_DEV_SYSTEM — roll N existing Dev tasks up into ONE PO story.
const PO_ROLLUP_SYSTEM = `You are an expert Agile coach and Product Owner. You are given a set of existing Dev tasks and must roll them up into ONE Product Owner story that covers all of them.

IMPORTANT: You MUST return a JSON object matching this schema exactly (no extra fields):
{
  "assistantMessage": "1-3 sentence overview of the rollup and any assumptions made; if the tasks look unrelated, say so here and still write the best single umbrella story",
  "summary": "concise story summary, max 255 chars, written as business value — NEVER a list of Jira keys",
  "description": "full description with ## headings and - bullets"
}

Write EXACTLY one PO story that covers ALL of the given Dev tasks — never split into multiple stories.

Never invent work that is not represented in the given tasks. Derive the acceptance criteria strictly from their actual content.

Description format — use EXACTLY these conventions so the text converts cleanly to Atlassian Document Format:
- Use "## " headings
- Use "- " bullet list items
- Blank lines between paragraphs

PO Story description template:
## User Story
As a [specific role], I want [clear goal], so that [concrete business benefit].

## Acceptance Criteria
- Given [initial context] / When [action taken] / Then [expected outcome]
- Given [initial context] / When [action taken] / Then [expected outcome]

## Scope
- [what is included, derived from the given tasks]

## Out of Scope
- [explicit exclusions]

## Delivered by
- KEY — title
- KEY — title

BEHAVIOUR:
- Exactly one PO story covering ALL given Dev tasks; do not omit any.
- The "## Delivered by" section must list one "- KEY — title" bullet per Dev task given, using its exact key.
- If the tasks appear unrelated, say so plainly in assistantMessage and still write the best single umbrella story.
- Keep summary under 255 characters; it must read as business value, never a bare list of ticket keys.
- Do NOT emit story points anywhere in the output — the caller computes them as an arithmetic sum.`;

// ---------------------------------------------------------------------------
// Service functions
// ---------------------------------------------------------------------------

/**
 * Draft a PO story + Dev task pair from a conversation.
 */
export async function draftTickets(
  provider: AiProvider,
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  storyPoints?: number
): Promise<DraftTicketsOutput & { provider: "anthropic" | "github"; model: string }> {
  const system =
    storyPoints !== undefined
      ? `${DRAFT_SYSTEM}\n\nNote: The user has suggested ${storyPoints} story points for the PO ticket.`
      : DRAFT_SYSTEM;

  const output = await callProvider(provider, system, messages, DraftTicketsOutputSchema);

  return {
    ...output,
    provider: provider.name,
    model: provider.model,
  };
}

/**
 * Draft an AI executive summary for a sprint report (v1.4, §4.9).
 */
export async function draftSprintSummary(
  provider: AiProvider,
  reportData: {
    sprintName: string;
    state: string;
    startDate?: string;
    endDate?: string;
    goal?: string | null;
    committedPoints: number;
    completedPoints: number;
    completedCount: number;
    totalCount: number;
    carryoverCount: number;
    blockedCount: number;
    byAssignee: Array<{
      name: string;
      donePoints: number;
      totalPoints: number;
      doneCount: number;
      totalCount: number;
    }>;
  }
): Promise<SprintSummaryOutput & { provider: "anthropic" | "github"; model: string }> {
  const completionRate =
    reportData.committedPoints > 0
      ? Math.round((reportData.completedPoints / reportData.committedPoints) * 100)
      : 0;

  const assigneeLines = reportData.byAssignee
    .map(
      (a) =>
        `  - ${a.name}: ${a.donePoints}/${a.totalPoints} pts, ${a.doneCount}/${a.totalCount} issues`
    )
    .join("\n");

  const userContent = [
    `Sprint: ${reportData.sprintName} (${reportData.state})`,
    reportData.startDate && reportData.endDate
      ? `Dates: ${reportData.startDate} → ${reportData.endDate}`
      : "",
    reportData.goal ? `Goal: ${reportData.goal}` : "",
    `Committed: ${reportData.committedPoints} pts | Completed: ${reportData.completedPoints} pts | Completion rate: ${completionRate}%`,
    `Issues: ${reportData.completedCount} done / ${reportData.totalCount} total | Carryover: ${reportData.carryoverCount} | Blocked: ${reportData.blockedCount}`,
    reportData.byAssignee.length > 0 ? `By assignee:\n${assigneeLines}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const messages: Array<{ role: "user" | "assistant"; content: string }> = [
    { role: "user", content: userContent },
  ];

  const output = await callProvider(
    provider,
    SPRINT_SUMMARY_SYSTEM,
    messages,
    SprintSummaryOutputSchema
  );

  return {
    ...output,
    provider: provider.name,
    model: provider.model,
  };
}

/**
 * Plan + draft one Dev task per PO story in a single call (v1.11, §4.9, ADR-022).
 */
export async function planDevTickets(
  provider: AiProvider,
  poStories: Array<{ key: string; summary: string; description?: string }>,
  instructions?: string
): Promise<PlanDevTicketsOutput & { provider: "anthropic" | "github"; model: string }> {
  const lines = poStories
    .map(
      (s, i) =>
        `${i + 1}. [${s.key}] ${s.summary}` +
        (s.description ? `\n   Details: ${s.description}` : "")
    )
    .join("\n");

  const userContent = [
    "Plan and draft the developer Task needed to deliver each of these PO stories.",
    "Return EXACTLY one item per PO story, keyed by its exact key.",
    instructions ? `Global instructions: ${instructions}` : "",
    `PO stories:\n${lines}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const messages: Array<{ role: "user" | "assistant"; content: string }> = [
    { role: "user", content: userContent },
  ];

  const output = await callProvider(
    provider,
    PLAN_DEV_SYSTEM,
    messages,
    PlanDevTicketsOutputSchema
  );

  return {
    ...output,
    provider: provider.name,
    model: provider.model,
  };
}

/**
 * Roll N existing Dev tasks up into ONE PO story — the inverse of planDevTickets
 * (v1.72, §4.9, ADR-083). No storyPoints in the output: the caller sums the selected
 * Dev tickets' points arithmetically and seeds that into an editable field.
 */
export async function draftPoStory(
  provider: AiProvider,
  devTickets: Array<{ key: string; summary: string; description?: string; storyPoints?: number | null }>,
  instructions?: string
): Promise<DraftPoStoryOutput & { provider: "anthropic" | "github"; model: string }> {
  const lines = devTickets
    .map(
      (t, i) =>
        `${i + 1}. [${t.key}] ${t.summary}` +
        (t.description ? `\n   Details: ${t.description}` : "")
    )
    .join("\n");

  const userContent = [
    "Write ONE Product Owner story that covers ALL of these Dev tasks.",
    instructions ? `Global instructions: ${instructions}` : "",
    `Dev tasks:\n${lines}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const messages: Array<{ role: "user" | "assistant"; content: string }> = [
    { role: "user", content: userContent },
  ];

  const output = await callProvider(
    provider,
    PO_ROLLUP_SYSTEM,
    messages,
    DraftPoStoryOutputSchema
  );

  return {
    ...output,
    provider: provider.name,
    model: provider.model,
  };
}

/**
 * Enhance an existing ticket with notes.
 */
export async function enhanceTicket(
  provider: AiProvider,
  ticketKey: string,
  notes: string | undefined,
  current: { summary: string; description: string }
): Promise<EnhanceTicketOutput & { provider: "anthropic" | "github"; model: string }> {
  const userContent = [
    `Ticket: ${ticketKey}`,
    `Current Summary: ${current.summary}`,
    `Current Description:\n${current.description}`,
    notes ? `User Notes / Refinement Instructions:\n${notes}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const messages: Array<{ role: "user" | "assistant"; content: string }> = [
    { role: "user", content: userContent },
  ];

  const output = await callProvider(provider, ENHANCE_SYSTEM, messages, EnhanceTicketOutputSchema);

  return {
    ...output,
    provider: provider.name,
    model: provider.model,
  };
}

// ---------------------------------------------------------------------------
// Internal dispatch — routes to provider-specific typed APIs
// ---------------------------------------------------------------------------

async function callProvider<T extends z.ZodObject<z.ZodRawShape>>(
  provider: AiProvider,
  system: string,
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  schema: T
): Promise<z.infer<T>> {
  if (provider instanceof AnthropicProvider) {
    // Use messages.parse + zodOutputFormat — returns typed output
    return provider.parseWith(system, messages, schema);
  }

  if (provider instanceof GithubProvider) {
    // Use JSON mode + retry; schema is zod/v4 compatible
    return provider.completeWithSchema(system, messages, schema);
  }

  // Generic fallback for other providers — use complete() and parse manually
  const result = await provider.complete(system, messages, { maxTokens: 4096 });
  const parsed = parseJsonSafe(result.text, schema);
  if (parsed === null) {
    throw new UpstreamError("AI returned an unparseable response", 502);
  }
  return parsed;
}

function parseJsonSafe<T extends z.ZodObject<z.ZodRawShape>>(
  text: string,
  schema: T
): z.infer<T> | null {
  try {
    const json: unknown = JSON.parse(text);
    const result = schema.safeParse(json);
    if (result.success) return result.data as z.infer<T>;
    return null;
  } catch {
    return null;
  }
}
