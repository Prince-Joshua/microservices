import { timingSafeEqual } from "node:crypto";

import type { NextFunction, Request, Response } from "express";


export function internalAuth(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const expected = process.env.INTERNAL_API_TOKEN;

  if (!expected) {
    res.status(500).json({ message: "Service misconfigured" });
    return;
  }

  const provided = Buffer.from(req.get("x-internal-token") ?? "");
  const wanted = Buffer.from(expected);

  if (
    provided.length !== wanted.length ||
    !timingSafeEqual(provided, wanted)
  ) {
    res.status(401).json({ message: "Unauthorized" });
    return;
  }

  next();
}
