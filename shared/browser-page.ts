/** Recognize Chromium's actual top-level preview, excluding its PDF iframe and normal sites. */
export function isPrintPreviewUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "chrome:" && parsed.hostname === "print" && parsed.pathname === "/";
  } catch {
    return false;
  }
}

/** Distinguish real preview targets in the existing tab picker and agent tab list. */
export function browserPageTitle(title: string, url: string): string {
  return isPrintPreviewUrl(url) ? `Print preview${title ? `: ${title}` : ""}` : title;
}
