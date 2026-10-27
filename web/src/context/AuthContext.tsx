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
import {
  FORBIDDEN_EVENT,
  SESSION_REFRESHED_EVENT,
  UNAUTHORIZED_EVENT,
  refreshSession,
  restoreSession,
} from "../api/http";
import type { User } from "../api/types";
import {
  announceSessionChange,
  clearSession,
  getUser,
  isSignedIn,
  onSessionChange,
  setSession,
  setSessionUser,
} from "../lib/storage";
import { toaster } from "../components/ui/toaster";

interface AuthValue {
  user: User | null;
  isAdmin: boolean;
  /** True until the app knows whether the browser holds a session (the first refresh). */
  loading: boolean;
  /** The session couldn't be checked: the server didn't answer. Not the same as signed out. */
  unreachable: boolean;

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
/** A sleeping server (free hosting) can take about a minute to wake: keep asking this long before giving up. */
const RESTORE_RETRY_MS = 3_000;
const RESTORE_ATTEMPTS = 25;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [unreachable, setUnreachable] = useState(false);

  // Nothing is stored in the browser, so a reload asks the server who is signed in (the refresh cookie).
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      let outcome = await restoreSession();

      for (let attempt = 1; outcome === "unavailable" && attempt < RESTORE_ATTEMPTS; attempt += 1) {
        await sleep(RESTORE_RETRY_MS);
        if (cancelled || isSignedIn()) break; // gone, or the person signed in meanwhile
        outcome = await refreshSession();
      }

      if (cancelled) return;
      if (outcome === "ok") setUserState(getUser());
      setUnreachable(outcome === "unavailable" && !isSignedIn());
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const logout = useCallback(() => {
    // End the session on the server too (it also clears the refresh cookie). Best effort.
    // Other tabs hear about it only once the cookie is really gone.
    usersApi
      .logout()
      .catch(() => undefined)
      .finally(announceSessionChange);
    clearSession();
    setUserState(null);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const { token, user: loggedIn } = await usersApi.login(email.trim(), password);
    setSession(token, loggedIn);
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
    setSessionUser(next);
    setUserState(next);
    announceSessionChange();
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
  const userRef = useRef(user);
  userRef.current = user;

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
        const current = userRef.current;
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
  // Tabs share the refresh cookie but not memory, so this tab asks the server what the cookie says now:
  // that brings the new account's access token and profile, or finds the session gone.
  useEffect(
    () =>
      onSessionChange(() => {
        void refreshSession().then((outcome) => {
          if (outcome === "ok") {
            setUserState(getUser());
          } else if (outcome === "invalid") {
            clearSession();
            setUserState(null);
          }
        });
      }),
    []
  );

  // The session is over: the refresh token was refused (expired, signed out elsewhere, account deactivated).
  useEffect(() => {
    const onUnauthorized = () => {
      // Several requests can fail together; react to the first only.
      if (!isSignedIn()) return;
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
    () => ({ user, isAdmin: user?.role === "admin", loading, unreachable, login, register, logout, setUser }),
    [user, loading, unreachable, login, register, logout, setUser]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
