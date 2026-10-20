/**
 * AbortController compatibility.
 *
 * Some Zotero plugin sandboxes do not expose `AbortController` as a global,
 * even though the main window has it. We borrow the constructor from the main
 * window and expose it globally at startup, with a lazy per-call fallback for
 * code that runs very early.
 */

type AbortCtor = typeof AbortController;

function findAbortController(): AbortCtor | null {
  try {
    const globalCtor = (
      globalThis as unknown as { AbortController?: AbortCtor }
    ).AbortController;
    if (typeof globalCtor === "function") return globalCtor;
  } catch {
    // ignore
  }
  try {
    const win = Zotero.getMainWindow() as unknown as {
      AbortController?: AbortCtor;
    };
    if (typeof win?.AbortController === "function") return win.AbortController;
  } catch {
    // Zotero may not be ready yet.
  }
  return null;
}

/** Install AbortController/AbortSignal globals if the sandbox lacks them. */
export function installAbortGlobals(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  try {
    const win = Zotero.getMainWindow() as unknown as Record<string, unknown>;
    if (typeof g.AbortController !== "function" && win?.AbortController) {
      g.AbortController = win.AbortController;
    }
    if (typeof g.AbortSignal !== "function" && win?.AbortSignal) {
      g.AbortSignal = win.AbortSignal;
    }
  } catch {
    // Zotero not ready; lazy fallback below still works.
  }
}

/** Create an AbortController even when the sandbox global is missing. */
export function createAbortController(): AbortController {
  const ctor = findAbortController();
  if (!ctor) {
    throw new Error(
      "当前 Zotero 环境缺少 AbortController，请重启 Zotero 后重试",
    );
  }
  return new ctor();
}
