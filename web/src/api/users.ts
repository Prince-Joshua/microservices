import { config } from "../config";
import { request } from "./http";
import { getRefreshToken } from "../lib/storage";
import type { Paged, Role, User } from "./types";

const base = config.usersUrl;

export const usersApi = {
  login: (email: string, password: string) =>
    request<{ token: string; refreshToken: string; user: User }>(base, "/auth/login", {
      method: "POST",
      body: { email, password },
      auth: false,
    }),

  register: (name: string, email: string, password: string) =>
    request<User>(base, "/auth/register", {
      method: "POST",
      body: { name, email, password },
      auth: false,
    }),

  /** Ends the session on the server. Safe to call with a token that is already dead. */
  logout: (refreshToken: string) =>
    request<void>(base, "/auth/logout", { method: "POST", body: { refreshToken }, auth: false }),

  me: (signal?: AbortSignal) => request<User>(base, "/users/me", { signal }),

  updateMe: (name: string) =>
    request<User>(base, "/users/me", { method: "PATCH", body: { name } }),

  changePassword: (currentPassword: string, newPassword: string) =>
    request<void>(base, "/users/me/password", {
      method: "POST",
      // Tells the server which session to keep; every other device is signed out.
      body: { currentPassword, newPassword, refreshToken: getRefreshToken() ?? undefined },
    }),

  deactivateMe: () => request<void>(base, "/users/me", { method: "DELETE" }),

  // admin
  list: (params: { page?: number; limit?: number; email?: string }, signal?: AbortSignal) =>
    request<Paged<User>>(base, "/users", { query: params, signal }),

  update: (id: string, patch: { isActive?: boolean; role?: Role }) =>
    request<User>(base, `/users/${encodeURIComponent(id)}`, { method: "PATCH", body: patch }),
};
