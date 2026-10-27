import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { usersApi } from "../api/users";
import { SESSION_REFRESHED_EVENT, UNAUTHORIZED_EVENT } from "../api/http";
import type { User } from "../api/types";
import { AUTH_KEY, loadAuth, saveAuth } from "../lib/storage";
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

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState<User | null>(() => loadAuth()?.user ?? null);

  const logout = useCallback(() => {
    // End the session on the server too, so a copied refresh token is useless. Best effort.
    const refreshToken = loadAuth()?.refreshToken;
    if (refreshToken) usersApi.logout(refreshToken).catch(() => undefined);
    saveAuth(null);
    setUserState(null);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const { token, refreshToken, user: loggedIn } = await usersApi.login(email.trim(), password);
    saveAuth({ token, refreshToken, user: loggedIn });
    setUserState(loggedIn);
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
    const current = loadAuth();
    if (current) saveAuth({ ...current, user: next });
    setUserState(next);
  }, []);

  // A silent token refresh can bring a changed name or role.
  useEffect(() => {
    const onRefreshed = (event: Event) => setUserState((event as CustomEvent<User>).detail);
    window.addEventListener(SESSION_REFRESHED_EVENT, onRefreshed);
    return () => window.removeEventListener(SESSION_REFRESHED_EVENT, onRefreshed);
  }, []);

  // Signing in or out in another tab: follow it. (This event only fires in the other tabs.)
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === AUTH_KEY || event.key === null) setUserState(loadAuth()?.user ?? null);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // The session is over: the refresh token was refused (expired, signed out elsewhere, account deactivated).
  useEffect(() => {
    const onUnauthorized = () => {
      // Several requests can fail together; react to the first only.
      if (!loadAuth()) return;
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
