export type Role = "customer" | "admin";

export interface AuthUser {
  id: string;
  role: Role;
}

declare global {
  namespace Express {
    interface Request {
      /** Set by requireAuth once the Bearer token has been verified. */
      user?: AuthUser;
    }
  }
}
