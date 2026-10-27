import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { usersApi } from "../api/users";
import { FORBIDDEN_EVENT, SESSION_REFRESHED_EVENT, UNAUTHORIZED_EVENT } from "../api/http";
import type { User } from "../api/types";
import {
  announceSessionChange,
  clearSession,
  hasSession,
  loadUser,
  onSessionChange,
  saveUser,
  setToken,
} from "../lib/storage";
import { toaster } from "../components/ui/toaster";

interface AuthValue {
  user: User | null;
  isAdmin: boolean;
  login: (email: string, password: string) => Promise<User>;
  register: (name: string, email: string, password: string) => Promise<User>;
  logout: () => void;
  setUser: (user: User) => void;
}

const AuthContext = createContext<AuthValue | null>(null);

/** While the tab is open and visible, re-read the profile this often. */
const SYNC_INTERVAL_MS = 5 * 60_000;
/** Focus events and refused requests can come in bursts; sync at most this often. */
const SYNC_MIN_GAP_MS = 30_000;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState<User | null>(loadUser);

  const logout = useCallback(() => {
    // End the session on the server too (it also clears the refresh cookie). Best effort.
    usersApi.logout().catch(() => undefined);
    clearSession();
    setUserState(null);
    announceSessionChange();
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const { token, user: loggedIn } = await usersApi.login(email.trim(), password);
    setToken(token);
    saveUser(loggedIn);
    setUserState(loggedIn);
    announceSessionChange();
    return loggedIn;
  }, []);

  const register = useCallback(
    async (name: string, email: string, password: string) => {
      await usersApi.register(name.trim(), email.trim(), password);
      return login(email, password);
    },
    [login]
  );

  const setUser = useCallback((next: User) => {
    if (hasSession()) {
      saveUser(next);
      announceSessionChange();
    }
    setUserState(next);
  }, []);

  // A silent token refresh can bring a changed name or role.
  useEffect(() => {
    const onRefreshed = (event: Event) => setUserState((event as CustomEvent<User>).detail);
    window.addEventListener(SESSION_REFRESHED_EVENT, onRefreshed);
    return () => window.removeEventListener(SESSION_REFRESHED_EVENT, onRefreshed);
  }, []);

  // A role change or a rename made elsewhere shows up without waiting for the token to expire.
  // The servers already use the current role on every request; this keeps the menus in step.
  // A deactivated account needs no handling here: its requests fail with 401, which ends the session.
  const userId = user?.id;
  useEffect(() => {
    if (!userId) return;
    let lastSync = Date.now();
    let stopped = false;
    let running = false;

    const sync = async (force = false) => {
      if (running || document.visibilityState !== "visible") return;
      if (!force && Date.now() - lastSync < SYNC_MIN_GAP_MS) return;
      running = true;
      lastSync = Date.now();

      try {
        const fresh = await usersApi.me();
        const current = loadUser();
        if (stopped || !current) return;
        if (
          fresh.role !== current.role ||
          fresh.name !== current.name ||
          fresh.email !== current.email ||
          fresh.isActive !== current.isActive
        ) {
          setUser(fresh);
        }
      } catch {
        // Offline, or the server is waking up: try again on the next trigger.
      } finally {
        running = false;
      }
    };

    const onVisible = () => void sync();
    // After a 403 the role is the likely cause: look straight away (one lookup at a time).
    const onForbidden = () => void sync(true);
    const timer = window.setInterval(() => void sync(true), SYNC_INTERVAL_MS);

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    window.addEventListener(FORBIDDEN_EVENT, onForbidden);

    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.removeEventListener(FORBIDDEN_EVENT, onForbidden);
    };
  }, [userId, setUser]);

  // Signing in or out in another tab: follow it. (A tab never hears its own announcements.)
  // Tabs share the refresh cookie but not the in-memory access token: after a switch of
  // account the old token is dropped, and the next request gets one for the new account.
  const shownId = useRef(user?.id);
  shownId.current = user?.id;

  useEffect(
    () =>
      onSessionChange(() => {
        const next = loadUser();
        if (next?.id !== shownId.current) setToken(null);
        setUserState(next);
      }),
    []
  );

  // The session is over: the refresh token was refused (expired, signed out elsewhere, account deactivated).
  useEffect(() => {
    const onUnauthorized = () => {
      // Several requests can fail together; react to the first only.
      if (!hasSession()) return;
      logout();
      toaster.create({
        type: "warning",
        title: "Session expired",
        description: "Please sign in again.",
      });
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [logout]);

  const value = useMemo<AuthValue>(
    () => ({ user, isAdmin: user?.role === "admin", login, register, logout, setUser }),
    [user, login, register, logout, setUser]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
