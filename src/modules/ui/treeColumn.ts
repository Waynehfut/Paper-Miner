import { config } from "../../../package.json";
import { htmlEl } from "../journal/dom";
import {
  getCachedJournalRank,
  prefetchJournalRanksByPublication,
} from "../journal/service";
import { getCachedRetractionStatus } from "../retraction/service";
import { getItemDOI, getItemPublication, isPaperItem } from "../../utils/item";
import { t } from "../../utils/i18n";
import { errorToString, log } from "../../utils/log";
import { getPref } from "../../utils/prefs";

/** Item tree column showing journal rank / warning. Owned by journal UI module. */

export const JOURNAL_COLUMN_KEY = "paperminerJournalRank";

const SELECTION_HOOK_MARK = "__paperminerSelectionHook";
const MAX_PREFETCH_PER_FLUSH = 8;
const MAX_SELECTION_PREFETCH = 5;
const PREFETCH_DEBOUNCE_MS = 700;
const REFRESH_THROTTLE_MS = 900;

let registeredDataKey: string | false | null = null;
const pendingNames = new Map<string, string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let lastHookCheck = 0;

interface SelectionHook {
  view: any;
  original: (...args: unknown[]) => unknown;
}

let selectionHook: SelectionHook | null = null;

function journalConfigured(): boolean {
  return Boolean(
    getPref("journalEnabled") &&
    String(getPref("journalSecretKey") || "").trim(),
  );
}

function schedulePrefetch(publication: string): void {
  if (!journalConfigured()) return;
  const name = String(publication || "").trim();
  if (!name) return;
  const key = name.toLowerCase();
  if (pendingNames.has(key) || pendingNames.size >= 60) return;
  pendingNames.set(key, name);
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushPrefetch();
  }, PREFETCH_DEBOUNCE_MS);
}

async function flushPrefetch(): Promise<void> {
  const names = [...pendingNames.values()].slice(0, MAX_PREFETCH_PER_FLUSH);
  pendingNames.clear();
  if (!names.length) return;
  try {
    await prefetchJournalRanksByPublication(names);
    scheduleRefresh();
  } catch (error) {
    log("flush journal prefetch failed:", errorToString(error));
  }
}

/** Throttled item-tree refresh (keeps the current selection). */
function scheduleRefresh(): void {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    applyRefresh();
  }, REFRESH_THROTTLE_MS);
}

function applyRefresh(): void {
  try {
    const view = Zotero.getActiveZoteroPane()?.itemsView as any;
    if (view && typeof view.refreshAndMaintainSelection === "function") {
      void Promise.resolve(view.refreshAndMaintainSelection(false)).catch(
        (error: unknown) => {
          log("refresh item tree failed:", errorToString(error));
        },
      );
      return;
    }
    Zotero.ItemTreeManager.refreshColumns();
  } catch (error) {
    log("refreshJournalColumn failed:", errorToString(error));
  }
}

/* ------------------------------------------------------------------ */
/* Column callbacks                                                    */
/* ------------------------------------------------------------------ */

function dataProvider(item: Zotero.Item): string {
  // Custom columns are also queried for non-item rows (feeds, ...), which do
  // not implement the Zotero.Item API.
  const ref = item as unknown as
    | { isRegularItem?: () => boolean }
    | null
    | undefined;
  if (!ref || typeof ref.isRegularItem !== "function") return "";
  if (!item.isRegularItem() || !isPaperItem(item)) return "";
  try {
    const doi = getItemDOI(item);
    const retraction = doi ? getCachedRetractionStatus(doi) : undefined;
    if (retraction?.status === "retracted") {
      return t("column-retracted", "已撤稿");
    }
    const publication = getItemPublication(item);
    if (!publication) return "";
    const cached = getCachedJournalRank(publication);
    if (cached) {
      return cached.status === "ok" ? cached.shortText : "";
    }
    schedulePrefetch(publication);
    const now = Date.now();
    if (now - lastHookCheck > 5000) {
      lastHookCheck = now;
      installSelectionHook();
    }
    return "";
  } catch (error) {
    log("journal column dataProvider failed:", errorToString(error));
    return "";
  }
}

function renderCell(
  _index: number,
  data: string,
  column: { className?: string },
  _isFirstColumn: boolean,
  doc: Document,
): HTMLElement {
  const cell = htmlEl(doc, "span", {
    class: `cell ${column?.className || ""} pm-journal-cell`.trim(),
    text: data || "",
    title: data || "",
  });
  if (!data) {
    cell.classList.add("pm-journal-cell-empty");
    return cell;
  }
  const normalized = data.toUpperCase();
  if (data.includes("预警") || data.includes("撤稿")) {
    cell.classList.add("pm-journal-cell-bad");
  } else if (
    normalized.includes("1区") ||
    normalized.includes("Q1") ||
    normalized.includes("TOP")
  ) {
    cell.classList.add("pm-journal-cell-good");
  } else if (
    normalized.includes("2区") ||
    normalized.includes("Q2") ||
    normalized.includes("3区") ||
    normalized.includes("Q3")
  ) {
    cell.classList.add("pm-journal-cell-info");
  } else {
    cell.classList.add("pm-journal-cell-neutral");
  }
  return cell;
}

/* ------------------------------------------------------------------ */
/* Selection prefetch                                                  */
/* ------------------------------------------------------------------ */

function prefetchSelection(): void {
  try {
    const pane = Zotero.getActiveZoteroPane();
    const items = pane?.getSelectedItems?.() || [];
    let requested = 0;
    for (const item of items) {
      if (requested >= MAX_SELECTION_PREFETCH) break;
      if (!item || !item.isRegularItem() || !isPaperItem(item)) continue;
      const publication = getItemPublication(item);
      if (!publication) continue;
      requested += 1;
      schedulePrefetch(publication);
    }
  } catch (error) {
    log("selection prefetch failed:", errorToString(error));
  }
}

function installSelectionHook(): void {
  try {
    const view = Zotero.getActiveZoteroPane()?.itemsView as any;
    if (!view || view === false) return;
    if (selectionHook && selectionHook.view === view) return;
    removeSelectionHook();
    const props = view.props;
    if (!props || typeof props.onSelectionChange !== "function") return;
    const existing = props.onSelectionChange as {
      [SELECTION_HOOK_MARK]?: boolean;
    };
    if (existing[SELECTION_HOOK_MARK]) return;
    const original = props.onSelectionChange;
    const wrapped = function (this: unknown, ...args: unknown[]) {
      prefetchSelection();
      return original.apply(this, args);
    };
    (wrapped as typeof existing)[SELECTION_HOOK_MARK] = true;
    props.onSelectionChange = wrapped;
    selectionHook = { view, original };
  } catch (error) {
    log("install selection hook failed:", errorToString(error));
  }
}

function removeSelectionHook(): void {
  if (!selectionHook) return;
  try {
    const { view, original } = selectionHook;
    const props = view?.props;
    if (props && props.onSelectionChange?.[SELECTION_HOOK_MARK]) {
      props.onSelectionChange = original;
    }
  } catch (error) {
    log("remove selection hook failed:", errorToString(error));
  }
  selectionHook = null;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export async function registerJournalColumn(): Promise<void> {
  if (!getPref("journalShowColumn")) return;
  if (registeredDataKey) return;
  if (!Zotero.ItemTreeManager?.registerColumn) return;
  try {
    const key = await Zotero.ItemTreeManager.registerColumn({
      dataKey: JOURNAL_COLUMN_KEY,
      label: t("journal-column-label", "期刊"),
      pluginID: config.addonID,
      enabledTreeIDs: ["main"],
      width: "120",
      minWidth: 80,
      showInColumnPicker: true,
      zoteroPersist: ["width", "hidden", "sortDirection"],
      dataProvider,
      renderCell,
    });
    if (!key) {
      log("registerJournalColumn returned false");
      return;
    }
    registeredDataKey = key;
    installSelectionHook();
    scheduleRefresh();
  } catch (error) {
    log("registerJournalColumn failed:", errorToString(error));
  }
}

export async function unregisterJournalColumn(): Promise<void> {
  if (registeredDataKey) {
    try {
      await Zotero.ItemTreeManager.unregisterColumn(registeredDataKey);
    } catch (error) {
      log("unregisterJournalColumn failed:", errorToString(error));
    }
    registeredDataKey = null;
  }
  removeSelectionHook();
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  pendingNames.clear();
}

/** Refresh the column (throttled). Safe to call from any module. */
export function refreshJournalColumn(): void {
  scheduleRefresh();
}

export const __testing = { dataProvider, renderCell };
