// Connections client (v1.44, ADR-054) — the signed-in user's own Jira/GitHub connections
// (the Connections tab + onboarding gate). Tokens are sent once (to connect) and NEVER
// returned by the server.

import { credFetch } from "./authClient";

/**
 * v1.46 (ADR-056): a connection may be INHERITED from a credential-source user (shared
 * credentials). `via` is that user's email; the owner's token hint is never exposed.
 */
interface InheritedFlags {
  inherited?: boolean;
  via?: string;
}
export interface JiraConnStatus extends InheritedFlags {
  connected: true;
  baseUrl: string;
  email: string;
  hint: string; // masked (…last4); empty when inherited
}
export interface GithubConnStatus extends InheritedFlags {
  connected: true;
  login: string;
  hint: string;
}
export interface AiConnStatus extends InheritedFlags {
  connected: true;
  provider: "anthropic" | "github" | string;
  model: string;
  hint: string;
}
export interface ConnectionsStatus {
  jira: JiraConnStatus | null;
  github: GithubConnStatus | null;
  ai: AiConnStatus | null;
}

/** Board refs the signed-in user's config resolves to (drives the board selector). */
export interface UserBoardRef {
  id: number;
  projectKey: string;
}
export interface MyContext {
  connections: ConnectionsStatus;
  /** True when the required accounts (Jira + GitHub) are connected — gates app access. */
  ready: boolean;
  boards: { dev: UserBoardRef[]; po: UserBoardRef[] };
  /** v1.51 (ADR-062): the user's EFFECTIVE offset policy (per-user config, not global .env). */
  policy?: { requiredPoints: number; offsetThreshold: number };
  /** v1.58 (ADR-070): the user's EFFECTIVE ticket-aging policy (per-user config, not global .env). */
  aging?: { baseDays: number; daysPerPoint: number };
  /** v1.53 (ADR-064): the user's EFFECTIVE AI status (own token OR inherited/global), not global .env. */
  ai?: { enabled: boolean; provider: string | null; model: string | null };
  /** v1.45 (ADR-055) — "admin" unlocks the Admin console tab. */
  role: "admin" | "user";
  /** v1.46 (ADR-056) — true when borrowing Jira credentials without admin-granted writes. */
  readOnly?: boolean;
  /** v1.46 — the email of the user whose credentials are being borrowed, else null. */
  sharedFrom?: string | null;
  /** v1.73 (ADR-084) — the shared team this user belongs to (storage SCOPE), or null when unassigned. */
  team?: { id: string; name: string } | null;
}

export function getConnections(): Promise<ConnectionsStatus> {
  return credFetch<ConnectionsStatus>("/api/me/connections", "GET");
}

export function putJiraConnection(baseUrl: string, email: string, token: string): Promise<ConnectionsStatus> {
  return credFetch<ConnectionsStatus>("/api/me/connections/jira", "PUT", { baseUrl, email, token });
}

export function putGithubConnection(token: string): Promise<ConnectionsStatus> {
  return credFetch<ConnectionsStatus>("/api/me/connections/github", "PUT", { token });
}

export function putAiConnection(
  provider: "anthropic" | "github",
  token: string,
  model?: string
): Promise<ConnectionsStatus> {
  return credFetch<ConnectionsStatus>("/api/me/connections/ai", "PUT", { provider, token, model });
}

export function deleteConnection(provider: "jira" | "github" | "ai"): Promise<ConnectionsStatus> {
  return credFetch<ConnectionsStatus>(`/api/me/connections/${provider}`, "DELETE");
}

/** The signed-in user's context: connection status, readiness, and resolved boards. */
export function getMyContext(): Promise<MyContext> {
  return credFetch<MyContext>("/api/me/context", "GET");
}
