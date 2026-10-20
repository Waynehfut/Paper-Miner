/**
 * Icon helpers following Zotero's own icon convention: the SVG is used as a
 * CSS background with `-moz-context-properties: fill`, so it inherits the
 * current text colour in both light and dark mode and is always displayed at
 * the requested size (never stretched by flex layout).
 */

export const HTML_NS = "http://www.w3.org/1999/xhtml";

export interface IconOptions {
  /** Additional CSS classes. */
  className?: string;
  /** Display size in px; defaults to 16. */
  size?: 12 | 16 | 20 | 24;
  /** Zotero icon directory, defaults to `16/universal`. */
  dir?: string;
}

/** Create a Zotero monochrome icon element backed by a CSS background image. */
export function createZoteroIcon(
  doc: Document,
  name: string,
  options: IconOptions = {},
): HTMLSpanElement {
  const size = options.size ?? 16;
  const dir = options.dir ?? (size >= 20 ? "20/universal" : "16/universal");
  const icon = doc.createElementNS(HTML_NS, "span") as HTMLSpanElement;
  icon.className = ["pm-icon", options.className || ""].join(" ").trim();
  if (size === 12) icon.classList.add("pm-icon-sm");
  else if (size === 20) icon.classList.add("pm-icon-nav");
  else if (size === 24) icon.classList.add("pm-icon-lg");
  icon.setAttribute("aria-hidden", "true");
  icon.style.backgroundImage = `url("chrome://zotero/skin/${dir}/${name}.svg")`;
  return icon;
}
