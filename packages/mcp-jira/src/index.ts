/**
 * Jira MCP server — stdio entry point.
 *
 * Consumed by VS Code Copilot (Claude) via MCP stdio protocol.
 * NEVER writes to stdout — stdout carries MCP protocol frames.
 * All diagnostic output goes to stderr.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { tools } from "./tools/index.js";
import { getConfig } from "./lib/config.js";
import { initStorage, flushStorage } from "./lib/storage/index.js";
import {
  draftTicketsPrompt,
  enhanceTicketPrompt,
  dailyHuddlePrompt,
} from "./lib/prompts.js";

// Fail fast: validate config at startup so the user sees a clear error
// if credentials are missing (spec §9 "Missing Jira credentials").
try {
  getConfig();
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[mcp-jira] Config error at startup: ${msg}\n`);
  process.exit(1);
}

const server = new McpServer({ name: "jira", version: "0.1.0" });

// Register all tools from the transport-agnostic registry
for (const tool of tools) {
  server.registerTool(
    tool.name,
    {
      title: tool.name,
      description: tool.description,
      inputSchema: tool.schema.shape,
    },
    async (args) => {
      try {
        const result = await tool.handler(args);
        return {
          content: [
            { type: "text", text: JSON.stringify(result, null, 2) },
          ],
        };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: message }),
            },
          ],
          isError: true,
        };
      }
    }
  );
}

// ---- Register MCP prompts (§4.8) ----

server.registerPrompt(
  "draft_tickets",
  {
    title: "Draft PO Story + Dev Task",
    description:
      "Draft a PO Story and linked Dev Task from a plain-English feature description, " +
      "with Given/When/Then acceptance criteria. Then creates both tickets in Jira.",
    argsSchema: { featureDescription: z.string() },
  },
  ({ featureDescription }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: draftTicketsPrompt(featureDescription),
        },
      },
    ],
  })
);

server.registerPrompt(
  "enhance_ticket",
  {
    title: "Enhance Ticket Description",
    description:
      "Retrieve a Jira ticket and rewrite its description with context, scope, " +
      "and Given/When/Then acceptance criteria, then update the ticket.",
    argsSchema: { ticketKey: z.string() },
  },
  ({ ticketKey }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: enhanceTicketPrompt(ticketKey),
        },
      },
    ],
  })
);

server.registerPrompt(
  "daily_huddle",
  {
    title: "Daily Standup Briefing",
    description:
      "Fetch the active sprint digest and present a crisp daily standup briefing.",
    argsSchema: { boardId: z.string().optional() },
  },
  ({ boardId }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: dailyHuddlePrompt(boardId),
        },
      },
    ],
  })
);

// v1.74 (ADR-085): mysql storage must connect + preload before the first tool call (no-op otherwise).
try {
  await initStorage();
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[mcp-jira] Storage init failed at startup: ${msg}\n`);
  process.exit(1);
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void flushStorage().finally(() => process.exit(0));
  });
}

// Connect and start listening
await server.connect(new StdioServerTransport());
process.stderr.write(
  "Jira MCP server running — waiting for tool calls...\n"
);
