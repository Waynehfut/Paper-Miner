import { config } from "../../../package.json";
import type { JournalResult } from "../../types";
import { htmlEl, zoteroIconImg } from "../journal/dom";
import { getJournalRank } from "../journal/service";
import { t } from "../../utils/i18n";
import { getRegularItemForReader, isPaperItem } from "../../utils/item";
import { errorToString, log } from "../../utils/log";
import { getPref } from "../../utils/prefs";
import { injectStylesIntoDocument } from "../../utils/styles";
import { openURL } from "../../utils/ui";

/**
 * Reader warning banner for early-warning journals.
 *
 * The reader toolbar event only allows synchronous DOM appends, so we append a
 * small chip immediately and fill in the actual banner asynchronously once the
 * journal data is available.
 *
 * Closing a reader tab kills its document wrapper. Any later access to that
 * wrapper throws `can't access dead object`, so every cross-document access in
 * this module is guarded by `isDocAlive()` and/or a local try/catch: a dead
 * reader must never break the banner of the next reader.
 */

const BANNER_ID = "paperminer-reader-banner";
const CHIP_ID = "paperminer-reader-warning-chip";
const PLUGIN_ID = config.addonID;

interface ReaderBannerData {
  key: string;
  journal: JournalResult | null;
}

interface ReaderContext {
  reader: any;
  doc: Document;
  chip: HTMLElement | null;
  itemID?: number;
  data?: ReaderBannerData;
  /** Cache key of the rendered banner to avoid rebuilding it on every
   *  toolbar re-render (the reader re-renders the toolbar quite often). */
  signature?: string;
}

const contexts = new Map<Document, ReaderContext>();
/** Items whose banner was dismissed by the user during this session. */
const hiddenForSession = new Set<string>();
const pendingDocs = new WeakSet<Document>();
const positionCleanups: Array<{ doc: Document; cleanup: () => void }> = [];

let registered = false;
let handler: ((event: unknown) => void) | null = null;

/* ------------------------------------------------------------------ */
/* Dead-object-safe helpers                                            */
/* ------------------------------------------------------------------ */

/** True only when `doc` is a live, attached document wrapper. */
function isDocAlive(doc: Document | null | undefined): boolean {
  if (!doc) return false;
  try {
    if (!doc.isConnected) return false;
    const view = doc.defaultView as unknown as
      | { closed?: boolean }
      | null
      | undefined;
    if (!view) return false;
    return !view.closed;
  } catch {
    // "can't access dead object" — the wrapper outlived its window.
    return false;
  }
}

function isElementAlive(element: Element | null | undefined): boolean {
  if (!element) return false;
  try {
    return Boolean(element.isConnected);
  } catch {
    return false;
  }
}

function bannerEnabled(): boolean {
  return Boolean(
    getPref("journalShowReaderBanner") && getPref("journalEnabled"),
  );
}

function itemKey(item: Zotero.Item): string {
  return `${item.libraryID}/${item.key}`;
}

function hideElement(element: Element | null): void {
  if (!element) return;
  try {
    element.classList.add("pm-journal-hidden");
  } catch {
    // Element belonged to a closed reader.
  }
}

function showElement(element: Element | null): void {
  if (!element) return;
  try {
    element.classList.remove("pm-journal-hidden");
  } catch {
    // Element belonged to a closed reader.
  }
}

/** Banner element of a reader document, or null when the doc is gone. */
function getBanner(doc: Document | null | undefined): HTMLElement | null {
  if (!isDocAlive(doc)) return null;
  try {
    return (doc as Document).getElementById(BANNER_ID) as HTMLElement | null;
  } catch {
    return null;
  }
}

function removeBanner(doc: Document | null | undefined): void {
  const banner = getBanner(doc);
  if (!banner) return;
  try {
    banner.remove();
  } catch {
    // Banner belonged to a closed reader.
  }
}

function findPositionCleanup(doc: Document): number {
  return positionCleanups.findIndex((entry) => entry.doc === doc);
}

function runPositionCleanup(doc: Document): void {
  const index = findPositionCleanup(doc);
  if (index < 0) return;
  const [entry] = positionCleanups.splice(index, 1);
  try {
    entry.cleanup();
  } catch {
    // The window may already be gone.
  }
}

/** Drop contexts whose reader document was closed, together with listeners. */
function pruneContexts(): void {
  for (const [doc] of [...contexts.entries()]) {
    let alive = false;
    try {
      alive = isDocAlive(doc);
    } catch {
      alive = false;
    }
    if (alive) continue;
    try {
      contexts.delete(doc);
    } catch {
      // ignore
    }
    runPositionCleanup(doc);
  }
}

/* ------------------------------------------------------------------ */
/* Positioning                                                         */
/* ------------------------------------------------------------------ */

function ensurePositionListener(doc: Document): void {
  if (!isDocAlive(doc)) return;
  if (findPositionCleanup(doc) >= 0) return;
  let win: Window | null = null;
  try {
    win = doc.defaultView;
  } catch {
    win = null;
  }
  if (!win) return;
  let observer: {
    disconnect: () => void;
    observe: (target: Element) => void;
  } | null = null;
  const reposition = () => {
    const banner = getBanner(doc);
    if (banner) positionBanner(doc, banner);
  };
  try {
    win.addEventListener("resize", reposition);
  } catch (error) {
    log("reader resize listener failed:", errorToString(error));
  }
  try {
    const ResizeObserverCtor = (win as unknown as { ResizeObserver?: any })
      .ResizeObserver;
    const view = doc.getElementById("split-view");
    if (typeof ResizeObserverCtor === "function" && view) {
      observer = new ResizeObserverCtor(reposition);
      observer?.observe(view);
    }
  } catch {
    // ResizeObserver is optional.
  }
  const cleanupWindow = win;
  positionCleanups.push({
    doc,
    cleanup: () => {
      try {
        cleanupWindow.removeEventListener("resize", reposition);
      } catch {
        // ignore
      }
      try {
        observer?.disconnect();
      } catch {
        // ignore
      }
    },
  });
}

/** Place the banner right below the reader toolbar, over the document view. */
function positionBanner(
  doc: Document | null | undefined,
  banner: HTMLElement | null,
): void {
  if (!banner || !isDocAlive(doc)) return;
  const targetDoc = doc as Document;
  try {
    const view = targetDoc.getElementById("split-view");
    const rect = view?.getBoundingClientRect();
    if (rect && rect.width > 0 && rect.height > 0) {
      banner.style.left = `${Math.max(0, rect.left + 6)}px`;
      banner.style.top = `${Math.max(0, rect.top + 6)}px`;
      banner.style.width = `${Math.max(220, rect.width - 12)}px`;
      banner.style.right = "auto";
      return;
    }
  } catch {
    // fall through to the fixed fallback
  }
  try {
    banner.style.left = "6px";
    banner.style.top = "45px";
    banner.style.right = "6px";
    banner.style.width = "auto";
  } catch {
    // Banner belonged to a closed reader.
  }
}

/* ------------------------------------------------------------------ */
/* Banner rendering                                                    */
/* ------------------------------------------------------------------ */

function bannerText(data: ReaderBannerData): {
  title: string;
  lines: string[];
  tone: "warning";
} {
  const journal = data.journal;
  const lines: string[] = [];
  if (journal?.shortText) lines.push(journal.shortText);
  if (journal?.publication) lines.push(journal.publication);
  return {
    title: t("journal-warning", "中科院预警期刊"),
    lines,
    tone: "warning",
  };
}

function buildBannerContent(
  doc: Document,
  data: ReaderBannerData,
): HTMLElement {
  const { title, lines, tone } = bannerText(data);
  const banner = htmlEl(doc, "div", {
    id: BANNER_ID,
    class: `pm-root pm-banner pm-journal-reader-banner pm-journal-reader-banner-${tone}`,
    attrs: { role: "status" },
  });
  banner.appendChild(zoteroIconImg(doc, "warning"));
  const content = htmlEl(doc, "div", {
    class: "pm-journal-reader-banner-content",
  });
  content.appendChild(
    htmlEl(doc, "div", { class: "pm-banner-title", text: title }),
  );
  if (lines.length) {
    content.appendChild(
      htmlEl(doc, "div", {
        class: "pm-journal-reader-banner-text",
        text: lines.join(" · "),
        title: lines.join("\n"),
      }),
    );
  }
  banner.appendChild(content);
  const close = htmlEl(doc, "button", {
    class: "pm-icon-btn pm-journal-banner-close",
    title: t("close", "关闭"),
    attrs: { type: "button", "aria-label": t("close", "关闭") },
    on: {
      click: (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
        hiddenForSession.add(data.key);
        hideElement(getBanner(doc));
      },
    },
  });
  // A text glyph is used instead of an icon so the affordance still renders
  // when chrome icon URLs are unavailable inside the reader iframe.
  close.appendChild(htmlEl(doc, "span", { text: "\u00d7" }));
  banner.appendChild(close);
  return banner;
}

function showBanner(
  doc: Document | null | undefined,
  data: ReaderBannerData,
): void {
  if (!isDocAlive(doc)) return;
  const targetDoc = doc as Document;
  try {
    const existing = getBanner(targetDoc);
    const banner = buildBannerContent(targetDoc, data);
    if (existing) {
      existing.replaceWith(banner);
    } else {
      const container = targetDoc.body || targetDoc.documentElement;
      if (!container) return;
      container.appendChild(banner);
    }
    positionBanner(targetDoc, banner);
    ensurePositionListener(targetDoc);
    // Respect a manual dismissal until the user explicitly opens it again.
    if (hiddenForSession.has(data.key)) hideElement(banner);
    else showElement(banner);
  } catch (error) {
    log("render reader banner failed:", errorToString(error));
  }
}

function currentChip(
  doc: Document | null | undefined,
  chip: HTMLElement | null,
): HTMLElement | null {
  // The reader re-renders its toolbar often and replaces custom sections, so
  // the chip captured when the event fired may already be detached.
  try {
    if (chip && chip.isConnected) return chip;
  } catch {
    // Chip belonged to a closed reader.
  }
  if (!isDocAlive(doc)) return null;
  try {
    return (doc as Document).getElementById(CHIP_ID) as HTMLElement | null;
  } catch {
    return null;
  }
}

function updateChip(
  chip: HTMLElement | null,
  data: ReaderBannerData | null,
): void {
  if (!chip) return;
  try {
    if (!data) {
      hideElement(chip);
      return;
    }
    const { title } = bannerText(data);
    chip.className = "pm-journal-toolbar-chip pm-journal-toolbar-chip-warning";
    chip.setAttribute(
      "title",
      `${title} · ${t("journal-show-banner", "显示提示横幅")}`,
    );
    const text = chip.querySelector(".pm-journal-toolbar-chip-text");
    if (text) {
      text.textContent = t("reader-chip-warning", "预警");
    }
    showElement(chip);
  } catch {
    // Chip belonged to a closed reader.
  }
}

function toggleBanner(doc: Document, data: ReaderBannerData): void {
  if (!isDocAlive(doc)) return;
  const banner = getBanner(doc);
  if (banner && !banner.classList.contains("pm-journal-hidden")) {
    hiddenForSession.add(data.key);
    hideElement(banner);
    return;
  }
  hiddenForSession.delete(data.key);
  if (banner) {
    showElement(banner);
    positionBanner(doc, banner);
    return;
  }
  showBanner(doc, data);
}

/* ------------------------------------------------------------------ */
/* Async data loading                                                  */
/* ------------------------------------------------------------------ */

async function updateBanner(
  context: ReaderContext,
  chip: HTMLElement | null,
): Promise<void> {
  const { doc } = context;
  if (!isDocAlive(doc)) return;
  if (pendingDocs.has(doc)) return;
  pendingDocs.add(doc);
  const discard = (): void => {
    updateChip(currentChip(doc, chip), null);
    removeBanner(doc);
  };
  try {
    await injectStylesIntoDocument(doc, ["base", "journal"]);
    if (!isDocAlive(doc)) return;

    let readerItemID: number | undefined;
    try {
      readerItemID = context.reader?.itemID;
    } catch {
      readerItemID = undefined;
    }
    const attachment = readerItemID ? Zotero.Items.get(readerItemID) : null;
    const item = getRegularItemForReader(attachment);
    if (!item || !isPaperItem(item)) {
      discard();
      return;
    }
    context.itemID = item.id;
    const key = itemKey(item);
    const journal =
      getPref("journalShowReaderBanner") && getPref("journalEnabled")
        ? await getJournalRank(item).catch((error: unknown) => {
            log("reader banner journal lookup failed:", errorToString(error));
            return null;
          })
        : null;
    // The reader tab may have been closed while the lookup was running.
    if (!isDocAlive(doc)) return;

    const warning = Boolean(
      journal && journal.status === "ok" && journal.warning,
    );
    if (!warning) {
      context.signature = undefined;
      discard();
      return;
    }
    const data: ReaderBannerData = {
      key,
      journal,
    };
    context.data = data;
    const signature = [key, journal?.shortText || ""].join("|");
    if (context.signature === signature && getBanner(doc)) {
      updateChip(currentChip(doc, chip), data);
      const existing = getBanner(doc);
      if (existing) {
        if (hiddenForSession.has(key)) hideElement(existing);
        else showElement(existing);
        positionBanner(doc, existing);
      }
      return;
    }
    context.signature = signature;
    updateChip(currentChip(doc, chip), data);
    showBanner(doc, data);
  } catch (error) {
    log("reader banner update failed:", errorToString(error));
    try {
      discard();
    } catch {
      // The reader was closed; nothing left to clean up.
    }
  } finally {
    try {
      pendingDocs.delete(doc);
    } catch {
      // ignore
    }
  }
}

/* ------------------------------------------------------------------ */
/* Toolbar handler                                                     */
/* ------------------------------------------------------------------ */

function onRenderToolbar(event: unknown): void {
  const payload = event as {
    reader?: any;
    doc?: Document;
    append?: (...nodes: Node[]) => void;
  };
  if (!payload?.reader || !payload?.doc || !payload?.append) return;
  if (!bannerEnabled()) return;
  const doc = payload.doc;
  if (!isDocAlive(doc)) return;

  // 1) Create and append the chip for the *current* reader first. Pruning old
  //    readers must never be able to block this (a dead context used to abort
  //    the whole handler here).
  let chip: HTMLElement | null = null;
  try {
    chip = htmlEl(doc, "button", {
      id: CHIP_ID,
      class: "pm-journal-toolbar-chip pm-journal-hidden",
      attrs: {
        type: "button",
        title: t("reader-chip-checking", "PaperMiner 正在检测"),
      },
    });
    chip.appendChild(zoteroIconImg(doc, "warning"));
    chip.appendChild(
      htmlEl(doc, "span", {
        class: "pm-journal-toolbar-chip-text",
        text: "",
      }),
    );
  } catch (error) {
    log("reader banner chip creation failed:", errorToString(error));
  }

  // 2) Register the context for this document (before pruning, so a prune
  //    failure cannot lose the new reader).
  let previous: ReaderContext | undefined;
  try {
    previous = contexts.get(doc);
  } catch {
    previous = undefined;
  }
  const context: ReaderContext = {
    reader: payload.reader,
    doc,
    chip,
    itemID: previous?.itemID,
    data: previous?.data,
    signature: previous?.signature,
  };
  if (chip) {
    chip.addEventListener("click", (clickEvent) => {
      clickEvent.preventDefault();
      try {
        if (context.data) toggleBanner(doc, context.data);
      } catch (error) {
        log("reader banner toggle failed:", errorToString(error));
      }
    });
    try {
      payload.append(chip);
    } catch (error) {
      log("reader toolbar append failed:", errorToString(error));
    }
  }
  try {
    contexts.set(doc, context);
  } catch (error) {
    log("reader banner context registration failed:", errorToString(error));
  }

  // 3) Prune contexts of readers that were closed in the meantime.
  try {
    pruneContexts();
  } catch (error) {
    log("reader banner prune failed:", errorToString(error));
  }

  // 4) Fill the banner asynchronously.
  void updateBanner(context, chip).catch((error) => {
    log("reader banner update failed:", errorToString(error));
  });
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export function registerReaderBanner(): void {
  if (registered) return;
  handler = (event: unknown) => onRenderToolbar(event);
  try {
    Zotero.Reader.registerEventListener("renderToolbar", handler, PLUGIN_ID);
    registered = true;
  } catch (error) {
    log("registerReaderBanner failed:", errorToString(error));
  }
}

export function unregisterReaderBanner(): void {
  if (registered && handler) {
    try {
      Zotero.Reader.unregisterEventListener("renderToolbar", handler);
    } catch (error) {
      log("unregisterReaderBanner failed:", errorToString(error));
    }
  }
  registered = false;
  handler = null;
  for (const entry of positionCleanups.splice(0)) {
    try {
      entry.cleanup();
    } catch {
      // ignore
    }
    try {
      removeBanner(entry.doc);
    } catch {
      // ignore
    }
  }
  for (const doc of [...contexts.keys()]) {
    try {
      removeBanner(doc);
    } catch {
      // ignore
    }
  }
  contexts.clear();
  hiddenForSession.clear();
}

/**
 * Re-evaluate the banner for one reader (or all open readers). Used after a
 * manual refresh from the item pane/context menu. Dead readers are dropped
 * silently instead of breaking the caller.
 */
export function refreshReaderBanner(reader?: any): void {
  for (const [doc, context] of [...contexts.entries()]) {
    let alive = false;
    try {
      alive = isDocAlive(doc);
    } catch {
      alive = false;
    }
    if (!alive) {
      try {
        contexts.delete(doc);
      } catch {
        // ignore
      }
      runPositionCleanup(doc);
      continue;
    }
    if (reader) {
      let sameReader = false;
      try {
        sameReader =
          context.reader === reader ||
          Boolean(
            reader.itemID &&
            context.reader?.itemID &&
            reader.itemID === context.reader.itemID,
          );
      } catch {
        sameReader = false;
      }
      if (!sameReader) continue;
    }
    try {
      void updateBanner(context, context.chip).catch((error) => {
        log("refresh reader banner failed:", errorToString(error));
      });
    } catch (error) {
      log("refresh reader banner failed:", errorToString(error));
    }
  }
}
