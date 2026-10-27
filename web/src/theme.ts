import { createSystem, defaultConfig, defineConfig } from "@chakra-ui/react";
import type { OrderStatus } from "./api/types";

/**
 * The single place that defines how the app looks (Chakra UI v3 "system").
 * Change the brand scale, fonts, radii or global styles here and every page
 * follows. Status colours live here too so badges stay consistent.
 */
const config = defineConfig({
  globalCss: {
    "html, body": {
      bg: "bg.subtle",
      color: "fg",
    },
  },
  theme: {
    tokens: {
      fonts: {
        heading: { value: `Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif` },
        body: { value: `Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif` },
      },
      colors: {
        brand: {
          50: { value: "#eef2ff" },
          100: { value: "#e0e7ff" },
          200: { value: "#c7d2fe" },
          300: { value: "#a5b4fc" },
          400: { value: "#818cf8" },
          500: { value: "#6366f1" },
          600: { value: "#4f46e5" },
          700: { value: "#4338ca" },
          800: { value: "#3730a3" },
          900: { value: "#312e81" },
          950: { value: "#1e1b4b" },
        },
      },
      radii: {
        // slightly rounder than the default
        l2: { value: "0.5rem" },
        l3: { value: "0.75rem" },
      },
    },
    semanticTokens: {
      colors: {
        // Wires `brand` up as a colorPalette (colorPalette="brand").
        brand: {
          contrast: { value: { _light: "white", _dark: "white" } },
          fg: { value: { _light: "{colors.brand.700}", _dark: "{colors.brand.300}" } },
          subtle: { value: { _light: "{colors.brand.100}", _dark: "{colors.brand.900}" } },
          muted: { value: { _light: "{colors.brand.200}", _dark: "{colors.brand.800}" } },
          emphasized: { value: { _light: "{colors.brand.300}", _dark: "{colors.brand.700}" } },
          solid: { value: { _light: "{colors.brand.600}", _dark: "{colors.brand.500}" } },
          focusRing: { value: { _light: "{colors.brand.500}", _dark: "{colors.brand.400}" } },
        },
      },
    },
  },
});

export const system = createSystem(defaultConfig, config);

/** Badge colour per order status. */
export const statusPalette: Record<OrderStatus, string> = {
  PENDING: "gray",
  AWAITING_PAYMENT: "orange",
  CONFIRMED: "blue",
  FULFILLED: "green",
  CANCELLED: "red",
  FAILED: "red",
};

export const statusLabel: Record<OrderStatus, string> = {
  PENDING: "Processing",
  AWAITING_PAYMENT: "Awaiting payment",
  CONFIRMED: "Paid",
  FULFILLED: "Fulfilled",
  CANCELLED: "Cancelled",
  FAILED: "Failed",
};

/** Layout constants shared by pages. */
export const layout = {
  maxWidth: "6xl",
} as const;
