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
import { UNAUTHORIZED_EVENT } from "../api/http";
import type { User } from "../api/types";
import { loadAuth, saveAuth } from "../lib/storage";
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
    saveAuth(null);
    setUserState(null);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const { token, user: loggedIn } = await usersApi.login(email.trim(), password);
    saveAuth({ token, user: loggedIn });
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
    if (current) saveAuth({ token: current.token, user: next });
    setUserState(next);
  }, []);

  // Any 401 on an authenticated call means the token expired or the account was deactivated.
  useEffect(() => {
    const onUnauthorized = () => {
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
