/**
 * The payment link comes from the server. Only follow an https link: anything else
 * (javascript:, data:, a malformed string) is treated as "no link".
 */
export function safeCheckoutUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;

  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** An in-app path to return to after sign-in; anything that could leave the site becomes "/". */
export function safeAppPath(path: unknown): string {
  return typeof path === "string" && /^\/(?![/\\])/.test(path) ? path : "/";
}
