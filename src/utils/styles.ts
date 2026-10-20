import { config } from "../../package.json";
import { log } from "./log";

const STYLE_FILES = ["base", "journal", "chat", "ai"];
const MAIN_STYLE_ID = "paperminer-style-";

/** Inject PaperMiner stylesheets into a Zotero main window. */
export function installMainWindowStyles(win: Window): void {
  const doc = win.document;
  for (const name of STYLE_FILES) {
    const id = `${MAIN_STYLE_ID}${name}`;
    if (doc.getElementById(id)) continue;
    const link = doc.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    link.type = "text/css";
    link.href = `chrome://${config.addonRef}/content/styles/${name}.css`;
    doc.documentElement?.appendChild(link);
  }
}

export function uninstallMainWindowStyles(win: Window): void {
  for (const name of STYLE_FILES) {
    win.document.getElementById(`${MAIN_STYLE_ID}${name}`)?.remove();
  }
}

const cssTextCache = new Map<string, string>();

/** Fetch a PaperMiner stylesheet as text (used inside the reader iframe). */
export async function getStyleText(name: string): Promise<string> {
  if (cssTextCache.has(name)) return cssTextCache.get(name)!;
  try {
    const text = await Zotero.File.getContentsFromURLAsync(
      `chrome://${config.addonRef}/content/styles/${name}.css`,
    );
    cssTextCache.set(name, text);
    return text;
  } catch (error) {
    log("failed to load stylesheet", name, error);
    return "";
  }
}

/** Inject all PaperMiner styles into an arbitrary document (e.g. the reader). */
export async function injectStylesIntoDocument(
  doc: Document,
  files: string[] = STYLE_FILES,
): Promise<void> {
  const id = `paperminer-style-inline-${config.addonRef}`;
  if (doc.getElementById(id)) return;
  const chunks = await Promise.all(files.map((file) => getStyleText(file)));
  const style = doc.createElement("style");
  style.id = id;
  style.textContent = chunks.filter(Boolean).join("\n");
  (doc.head || doc.documentElement)?.appendChild(style);
}

/** Remove injected inline styles (reader panel teardown). */
export function removeInlineStyles(doc: Document): void {
  doc
    .querySelectorAll(`style[id^="paperminer-style-inline"]`)
    .forEach((node: Element) => node.remove());
}
