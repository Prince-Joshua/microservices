import { Router } from "express";
import mongoose from "mongoose";

import { User, type IUser } from "../models/user.model.js";
import { requireAuth, requireAdmin, currentUser } from "../middleware/auth.js";
import { hashPassword, verifyPassword } from "../services/password.js";
import { publicUser, parsePagination } from "../services/public-user.js";
import { validPassword } from "./auth.routes.js";

const router = Router();

router.use(requireAuth);

/** GET /users/me */
router.get("/me", async (req, res) => {
  try {
    const user = await User.findById(currentUser(req).id);

    if (!user || !user.isActive) {
      res.status(404).json({ message: "User not found" });
      return;
    }

    res.json(publicUser(user));
  } catch (error) {
    console.error("Profile lookup failed:", error);
    res.status(500).json({ message: "Unable to load profile" });
  }
});

/** PATCH /users/me  { name } */
router.patch("/me", async (req, res) => {
  const { name } = (req.body ?? {}) as Record<string, unknown>;

  if (
    typeof name !== "string" ||
    name.trim().length < 1 ||
    name.trim().length > 100
  ) {
    res.status(400).json({ message: "name (1-100 chars) is required" });
    return;
  }

  try {
    const user = await User.findOneAndUpdate(
      { _id: currentUser(req).id, isActive: true },
      { $set: { name: name.trim() } },
      { new: true, runValidators: true }
    );

    if (!user) {
      res.status(404).json({ message: "User not found" });
      return;
    }

    res.json(publicUser(user));
  } catch (error) {
    console.error("Profile update failed:", error);
    res.status(500).json({ message: "Unable to update profile" });
  }
});

/** POST /users/me/password  { currentPassword, newPassword } */
router.post("/me/password", async (req, res) => {
  const { currentPassword, newPassword } = (req.body ?? {}) as Record<
    string,
    unknown
  >;

  if (typeof currentPassword !== "string" || !validPassword(newPassword)) {
    res.status(400).json({
      message:
        "currentPassword and a newPassword of 8-128 characters are required",
    });
    return;
  }

  try {
    const user = await User.findById(currentUser(req).id).select(
      "+passwordHash"
    );

    if (!user || !user.isActive) {
      res.status(404).json({ message: "User not found" });
      return;
    }

    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      res.status(401).json({ message: "Current password is incorrect" });
      return;
    }

    user.passwordHash = await hashPassword(newPassword);
    await user.save();

    res.status(204).end();
  } catch (error) {
    console.error("Password change failed:", error);
    res.status(500).json({ message: "Unable to change password" });
  }
});

/**
 * DELETE /users/me
 * Deactivates the account (orders reference it, so it is never erased).
 * Existing tokens stop working for new orders immediately because the
 * Orders service checks isActive on every order.
 */
router.delete("/me", async (req, res) => {
  try {
    await User.updateOne(
      { _id: currentUser(req).id },
      { $set: { isActive: false } }
    );
    res.status(204).end();
  } catch (error) {
    console.error("Account deactivation failed:", error);
    res.status(500).json({ message: "Unable to deactivate account" });
  }
});

/** GET /users?page=&limit=&email=   (admin) */
router.get("/", requireAdmin, async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const filter: { email?: string } = {};

  if (typeof req.query.email === "string" && req.query.email.trim()) {
    filter.email = req.query.email.trim().toLowerCase();
  }

  try {
    const [users, total] = await Promise.all([
      User.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      User.countDocuments(filter),
    ]);

    res.json({ data: users.map(publicUser), page, limit, total });
  } catch (error) {
    console.error("User list failed:", error);
    res.status(500).json({ message: "Unable to list users" });
  }
});

/** GET /users/:id   (admin) */
router.get("/:id", requireAdmin, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(404).json({ message: "User not found" });
    return;
  }

  try {
    const user = await User.findById(req.params.id);

    if (!user) {
      res.status(404).json({ message: "User not found" });
      return;
    }

    res.json(publicUser(user));
  } catch (error) {
    console.error("User lookup failed:", error);
    res.status(500).json({ message: "Unable to load user" });
  }
});

/** PATCH /users/:id  { isActive?, role? }   (admin) */
router.patch("/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { isActive, role } = (req.body ?? {}) as Record<string, unknown>;

  if (!mongoose.isValidObjectId(id)) {
    res.status(404).json({ message: "User not found" });
    return;
  }

  if (id === currentUser(req).id) {
    res.status(400).json({
      message: "Admins can't change their own role or active status",
    });
    return;
  }

  const update: Partial<Pick<IUser, "isActive" | "role">> = {};

  if (isActive !== undefined) {
    if (typeof isActive !== "boolean") {
      res.status(400).json({ message: "isActive must be a boolean" });
      return;
    }

    update.isActive = isActive;
  }

  if (role !== undefined) {
    if (role !== "customer" && role !== "admin") {
      res.status(400).json({ message: "role must be customer or admin" });
      return;
    }

    update.role = role;
  }

  if (Object.keys(update).length === 0) {
    res.status(400).json({ message: "Nothing to update" });
    return;
  }

  try {
    const user = await User.findByIdAndUpdate(
      id,
      { $set: update },
      { new: true, runValidators: true }
    );

    if (!user) {
      res.status(404).json({ message: "User not found" });
      return;
    }

    res.json(publicUser(user));
  } catch (error) {
    console.error("User update failed:", error);
    res.status(500).json({ message: "Unable to update user" });
  }
});

export default router;
