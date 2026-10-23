import type { Request } from "express";

import type { UserRole } from "../models/user.model.js";

/** The fields of a user document that may leave this service. */
export interface PublicUserSource {
  _id: unknown;
  name: string;
  email: string;
  role: UserRole;
  isActive: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  isActive: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

/** The only shape of a user that leaves this service. */
export function publicUser(user: PublicUserSource): PublicUser {
  return {
    id: String(user._id),
    name: user.name,
    email: user.email,
    role: user.role,
    isActive: user.isActive,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

export interface Pagination {
  page: number;
  limit: number;
  skip: number;
}

export function parsePagination(query: Request["query"]): Pagination {
  const page = Math.max(1, Number.parseInt(String(query.page), 10) || 1);
  const limit = Math.min(
    100,
    Math.max(1, Number.parseInt(String(query.limit), 10) || 20)
  );

  return { page, limit, skip: (page - 1) * limit };
}
