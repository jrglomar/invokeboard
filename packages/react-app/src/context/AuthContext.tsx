// Auth context (v1.44/v1.45, ADR-054/055) — the current user + their connection readiness.
// Drives the app-wide gate: login → connect accounts → app. Refreshes on mount.

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import * as authClient from "../lib/authClient";
import { isAuthApiError, type AuthUser } from "../lib/authClient";
import { getMyContext, type MyContext } from "../lib/connectionsClient";

interface AuthState {
  user: AuthUser | null;
  loading: boolean;
  /** True only when the bridge reports the feature is not configured (503). */
  unavailable: boolean;
  /** True when the user is connected enough to use the app (Jira + GitHub). */
  ready: boolean;
  /** The user's role — "admin" unlocks the Admin console. Defaults to "user". */
  role: "admin" | "user";
  /** v1.46 (ADR-056) — borrowing Jira credentials without write access. */
  readOnly: boolean;
  /** v1.46 — email of the user whose credentials are borrowed, else null. */
  sharedFrom: string | null;
  /** v1.73 (ADR-084) — the shared team the user belongs to (storage scope), or null. */
  team: { id: string; name: string } | null;
  /** The user's resolved context (connections, boards) — null until loaded. */
  context: MyContext | null;
  refresh: () => Promise<void>;
  refreshContext: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  signup: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [context, setContext] = useState<MyContext | null>(null);

  const refreshContext = useCallback(async () => {
    try {
      setContext(await getMyContext());
    } catch {
      setContext(null);
    }
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setUser(await authClient.getMe());
      setUnavailable(false);
      await refreshContext();
    } catch (err) {
      setUser(null);
      setContext(null);
      if (isAuthApiError(err) && err.code === "TASK_HELPER_UNAVAILABLE") setUnavailable(true);
    } finally {
      setLoading(false);
    }
  }, [refreshContext]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(async (email: string, password: string) => {
    setUser(await authClient.login(email, password));
    setUnavailable(false);
    await refreshContext();
  }, [refreshContext]);

  const signup = useCallback(async (email: string, password: string) => {
    setUser(await authClient.signup(email, password));
    setUnavailable(false);
    await refreshContext();
  }, [refreshContext]);

  const logout = useCallback(async () => {
    try { await authClient.logout(); } finally { setUser(null); setContext(null); }
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user, loading, unavailable,
        ready: context?.ready ?? false,
        role: context?.role ?? user?.role ?? "user",
        readOnly: context?.readOnly ?? false,
        sharedFrom: context?.sharedFrom ?? null,
        team: context?.team ?? null,
        context,
        refresh, refreshContext, login, signup, logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
