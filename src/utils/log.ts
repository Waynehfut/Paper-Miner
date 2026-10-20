import { config } from "../../package.json";

/** PaperMiner debug logger. Always goes through Zotero.debug so it shows up in
 *  the Debug Output Logging console and in `zotero-plugin test` output. */
export function log(...args: unknown[]): void {
  try {
    Zotero.debug(
      `[${config.addonName}] ${args.map((a) => String(a)).join(" ")}`,
    );
  } catch {
    // Zotero not ready (e.g. during tests) — fall back to console.
    console.log(`[${config.addonName}]`, ...args);
  }
}

export function warn(...args: unknown[]): void {
  log("WARN", ...args);
}

export function errorLog(...args: unknown[]): void {
  try {
    Zotero.logError(
      new Error(`[${config.addonName}] ${args.map(String).join(" ")}`),
    );
  } catch {
    console.error(`[${config.addonName}]`, ...args);
  }
}

export function errorToString(error: unknown): string {
  if (!error) return "未知错误";
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message || String(error);
  const anyError = error as { message?: string; responseText?: string };
  if (anyError?.message) return String(anyError.message);
  if (anyError?.responseText)
    return String(anyError.responseText).slice(0, 300);
  try {
    return JSON.stringify(error).slice(0, 300);
  } catch {
    return String(error);
  }
}
