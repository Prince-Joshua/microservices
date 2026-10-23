import { Router, type Request } from "express";
import mongoose from "mongoose";

import { Product, type IProduct } from "../models/product.model.js";
import { optionalAuth, requireAdmin } from "../middleware/auth.js";

const router = Router();

/** The only shape of a product that leaves this service publicly. */
type ProductView = Pick<
  IProduct,
  "name" | "price" | "stockQuantity" | "isActive" | "createdAt" | "updatedAt"
> & { _id: unknown };

function toProduct(product: ProductView) {
  return {
    id: String(product._id),
    name: product.name,
    price: product.price,
    stockQuantity: product.stockQuantity,
    isActive: product.isActive,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
  };
}

const PUBLIC_FIELDS = "name price stockQuantity isActive createdAt updatedAt";

function validName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length >= 1 &&
    value.trim().length <= 200
  );
}

// Prices are whole cents: 19.99 is fine, 19.999 is not.
function validPrice(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1e9 &&
    Math.abs(value * 100 - Math.round(value * 100)) < 1e-6
  );
}

function validStock(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parsePagination(query: Request["query"]) {
  const page = Math.max(1, Number.parseInt(String(query.page), 10) || 1);
  const limit = Math.min(
    100,
    Math.max(1, Number.parseInt(String(query.limit), 10) || 20)
  );

  return { page, limit, skip: (page - 1) * limit };
}

/**
 * GET /products?q=&page=&limit=
 * Public. Customers see active products only; admins also see inactive
 * ones when they pass includeInactive=true.
 */
router.get("/", optionalAuth, async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const filter: Record<string, unknown> = {};

  const includeInactive =
    req.user?.role === "admin" && req.query.includeInactive === "true";

  if (!includeInactive) {
    filter.isActive = true;
  }

  if (typeof req.query.q === "string" && req.query.q.trim()) {
    filter.name = {
      $regex: escapeRegex(req.query.q.trim().slice(0, 100)),
      $options: "i",
    };
  }

  try {
    const [products, total] = await Promise.all([
      Product.find(filter)
        .select(PUBLIC_FIELDS)
        .sort({ name: 1, _id: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Product.countDocuments(filter),
    ]);

    return res.json({ data: products.map(toProduct), page, limit, total });
  } catch (error) {
    console.error("Product list failed:", error);
    return res.status(500).json({ message: "Unable to list products" });
  }
});

/** GET /products/:id  (public; inactive products are hidden from non-admins) */
router.get("/:id", optionalAuth, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(404).json({ message: "Product not found" });
  }

  try {
    const product = await Product.findById(req.params.id)
      .select(PUBLIC_FIELDS)
      .lean();

    if (!product || (!product.isActive && req.user?.role !== "admin")) {
      return res.status(404).json({ message: "Product not found" });
    }

    return res.json(toProduct(product));
  } catch (error) {
    console.error("Product lookup failed:", error);
    return res.status(500).json({ message: "Unable to load product" });
  }
});

/** POST /products  { name, price, stockQuantity? }   (admin) */
router.post("/", requireAdmin, async (req, res) => {
  const { name, price, stockQuantity = 0 } = req.body ?? {};

  if (!validName(name) || !validPrice(price) || !validStock(stockQuantity)) {
    return res.status(400).json({
      message:
        "name (1-200 chars), price (>= 0, whole cents) and an integer stockQuantity (>= 0) are required",
    });
  }

  try {
    const product = await Product.create({
      name: name.trim(),
      price,
      stockQuantity,
    });

    return res.status(201).json(toProduct(product));
  } catch (error) {
    console.error("Product creation failed:", error);
    return res.status(500).json({ message: "Unable to create product" });
  }
});

/** PATCH /products/:id  { name?, price?, isActive? }   (admin) */
router.patch("/:id", requireAdmin, async (req, res) => {
  const { name, price, isActive } = req.body ?? {};

  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(404).json({ message: "Product not found" });
  }

  const update: Partial<Pick<IProduct, "name" | "price" | "isActive">> = {};

  if (name !== undefined) {
    if (!validName(name)) {
      return res.status(400).json({ message: "name must be 1-200 characters" });
    }

    update.name = name.trim();
  }

  if (price !== undefined) {
    if (!validPrice(price)) {
      return res
        .status(400)
        .json({ message: "price must be >= 0 in whole cents" });
    }

    update.price = price;
  }

  if (isActive !== undefined) {
    if (typeof isActive !== "boolean") {
      return res.status(400).json({ message: "isActive must be a boolean" });
    }

    update.isActive = isActive;
  }

  if (Object.keys(update).length === 0) {
    return res.status(400).json({ message: "Nothing to update" });
  }

  try {
    const product = await Product.findByIdAndUpdate(
      req.params.id,
      { $set: update },
      { new: true, runValidators: true }
    );

    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    return res.json(toProduct(product));
  } catch (error) {
    console.error("Product update failed:", error);
    return res.status(500).json({ message: "Unable to update product" });
  }
});

/**
 * POST /products/:id/stock  { delta }   (admin)
 * Adds or removes stock atomically. Removing more than is on hand is
 * rejected (409) rather than going negative. Not idempotent: each call
 * applies the delta, so don't blindly retry it.
 */
router.post("/:id/stock", requireAdmin, async (req, res) => {
  const { delta } = req.body ?? {};

  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(404).json({ message: "Product not found" });
  }

  if (!Number.isSafeInteger(delta) || delta === 0) {
    return res
      .status(400)
      .json({ message: "delta must be a non-zero integer" });
  }

  const filter: Record<string, unknown> = { _id: req.params.id };

  if (delta < 0) {
    filter.stockQuantity = { $gte: -delta };
  }

  try {
    const product = await Product.findOneAndUpdate(
      filter,
      { $inc: { stockQuantity: delta } },
      { new: true }
    );

    if (product) {
      return res.json(toProduct(product));
    }

    if (await Product.exists({ _id: req.params.id })) {
      return res
        .status(409)
        .json({ message: "Not enough stock to remove that amount" });
    }

    return res.status(404).json({ message: "Product not found" });
  } catch (error) {
    console.error("Stock adjustment failed:", error);
    return res.status(500).json({ message: "Unable to adjust stock" });
  }
});

/**
 * DELETE /products/:id   (admin)
 * Soft delete: the product is deactivated, never erased, because past
 * orders and open reservations still refer to it.
 */
router.delete("/:id", requireAdmin, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(404).json({ message: "Product not found" });
  }

  try {
    const result = await Product.updateOne(
      { _id: req.params.id },
      { $set: { isActive: false } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ message: "Product not found" });
    }

    return res.status(204).end();
  } catch (error) {
    console.error("Product deletion failed:", error);
    return res.status(500).json({ message: "Unable to delete product" });
  }
});

export default router;
