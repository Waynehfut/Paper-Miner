/**
 * Selection popup actions (translate / ask AI). Owned by chat UI module.
 *
 * Registers the two reader events that add buttons to Zotero's own UI:
 * - `renderTextSelectionPopup` for the text-selection palette
 * - `createAnnotationContextMenu` for the saved-annotation context menu
 *
 * The floating translation panel lives in `chat/translatePopover.ts`.
 */

import { config } from "../../../package.json";
import { getItemTitle } from "../../utils/item";
import { t } from "../../utils/i18n";
import { errorToString, log } from "../../utils/log";
import { getPref } from "../../utils/prefs";
import { injectStylesIntoDocument } from "../../utils/styles";
import {
  closeTranslatePopover,
  openTranslatePopover,
} from "../chat/translatePopover";
import {
  collectAnnotationText,
  getPaperItemForReader,
  getPopupSelectionAnchor,
  getReaderDocument,
  type ReaderLike,
  type SelectionAnchor,
} from "../chat/reader";
import { openChatPanel } from "./chatPanel";

const HTML_NS = "http://www.w3.org/1999/xhtml";
const PLUGIN_ID = config.addonID;

interface SelectionPopupEvent {
  reader: ReaderLike;
  doc?: Document;
  params?: {
    annotation?: { text?: string; position?: unknown };
  };
  append?: (...nodes: Array<Node | string>) => void;
}

interface AnnotationMenuEvent {
  reader: ReaderLike;
  params?: { ids?: string[] };
  append?: (item: { label: string; onCommand: () => void }) => void;
}

let registered = false;
let popupHandler: ((event: unknown) => void) | null = null;
let menuHandler: ((event: unknown) => void) | null = null;
let popoverDisposer: (() => void) | null = null;

function isPopupEnabled(): boolean {
  try {
    return getPref("translateShowPopup") !== false;
  } catch {
    return true;
  }
}

function createActionButton(
  doc: Document,
  label: string,
  onClick: () => void,
): HTMLButtonElement {
  const button = doc.createElementNS(HTML_NS, "button") as HTMLButtonElement;
  button.type = "button";
  button.className = "pm-translate-popup-btn";
  button.textContent = label;
  button.title = label;
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      onClick();
    } catch (error) {
      log("selection action failed:", errorToString(error));
    }
  });
  return button;
}

/** Paper title + abstract hint helps the translator with terminology. */
function getTranslationContext(reader: ReaderLike): string {
  const item = getPaperItemForReader(reader);
  if (!item) return "";
  const title = getItemTitle(item);
  let abstract = "";
  try {
    abstract = String(item.getField("abstractNote") || "");
  } catch {
    abstract = "";
  }
  return [title, abstract.slice(0, 800)].filter(Boolean).join("\n\n");
}

function openTranslation(
  reader: ReaderLike,
  text: string,
  anchor: SelectionAnchor,
): void {
  closeTranslatePopover();
  popoverDisposer = openTranslatePopover({
    doc: anchor.doc,
    text,
    anchor: anchor.rect,
    context: getTranslationContext(reader),
    onAskAI: () => {
      const item = getPaperItemForReader(reader);
      void openChatPanel(item || undefined, { quotedText: text });
    },
    onClose: () => {
      popoverDisposer = null;
    },
  });
}

function translateFromEvent(event: SelectionPopupEvent, text: string): void {
  const anchor = getPopupSelectionAnchor(event);
  if (!anchor) {
    log("no anchor rect for selection translation");
    return;
  }
  void injectStylesIntoDocument(anchor.doc);
  openTranslation(event.reader, text, anchor);
}

function askAIFromReader(reader: ReaderLike, text: string): void {
  const item = getPaperItemForReader(reader);
  if (!item) {
    log("no paper item for reader selection");
    return;
  }
  void openChatPanel(item, { quotedText: text });
}

/* ------------------------------------------------------------------ */
/* Reader event handlers                                               */
/* ------------------------------------------------------------------ */

function handleSelectionPopup(rawEvent: unknown): void {
  const event = rawEvent as SelectionPopupEvent;
  const text = String(event?.params?.annotation?.text || "").trim();
  if (!text || typeof event.append !== "function") return;
  const doc = event.doc || getReaderDocument(event.reader);
  if (!doc) return;
  void injectStylesIntoDocument(doc);

  const container = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
  container.className = "pm-translate-actions";
  if (isPopupEnabled()) {
    container.appendChild(
      createActionButton(doc, t("chat-translate-button", "翻译"), () =>
        translateFromEvent(event, text),
      ),
    );
  }
  container.appendChild(
    createActionButton(doc, t("chat-ask-ai", "问 AI"), () =>
      askAIFromReader(event.reader, text),
    ),
  );
  event.append(container);
}

function handleAnnotationContextMenu(rawEvent: unknown): void {
  const event = rawEvent as AnnotationMenuEvent;
  if (typeof event.append !== "function") return;
  const text = collectAnnotationText(event.reader, event.params?.ids);
  if (!text) return;
  const doc = getReaderDocument(event.reader);
  if (doc) void injectStylesIntoDocument(doc);
  event.append({
    label: t("chat-translate-annotation", "PaperMiner 翻译标注"),
    onCommand: () => {
      const anchor = doc ? getFallbackAnchor(doc) : null;
      if (!anchor) return;
      openTranslation(event.reader, text, anchor);
    },
  });
  event.append({
    label: t("chat-ask-annotation", "询问 PaperMiner"),
    onCommand: () => askAIFromReader(event.reader, text),
  });
}

/** Anchor used when a menu command has no selection (center of the reader). */
function getFallbackAnchor(doc: Document): SelectionAnchor | null {
  const view = doc.defaultView;
  const width = view?.innerWidth || 0;
  const height = view?.innerHeight || 0;
  if (!width || !height) return null;
  const left = Math.max(40, width / 2 - 80);
  const top = Math.max(60, height / 2 - 20);
  return {
    doc,
    text: "",
    rect: { left, right: left + 160, top, bottom: top + 24 },
  };
}

/* ------------------------------------------------------------------ */
/* Registration                                                        */
/* ------------------------------------------------------------------ */

export function registerSelectionPopup(): void {
  if (registered) return;
  registered = true;

  popupHandler = handleSelectionPopup;
  menuHandler = handleAnnotationContextMenu;
  try {
    Zotero.Reader.registerEventListener(
      "renderTextSelectionPopup",
      popupHandler as never,
      PLUGIN_ID,
    );
  } catch (error) {
    log("register renderTextSelectionPopup failed:", errorToString(error));
  }
  try {
    Zotero.Reader.registerEventListener(
      "createAnnotationContextMenu",
      menuHandler as never,
      PLUGIN_ID,
    );
  } catch (error) {
    log("register createAnnotationContextMenu failed:", errorToString(error));
  }
}

export function unregisterSelectionPopup(): void {
  if (!registered) return;
  registered = false;
  closeTranslatePopover();
  popoverDisposer = null;
  if (popupHandler) {
    try {
      Zotero.Reader.unregisterEventListener(
        "renderTextSelectionPopup",
        popupHandler as never,
      );
    } catch (error) {
      log("unregister renderTextSelectionPopup failed:", errorToString(error));
    }
    popupHandler = null;
  }
  if (menuHandler) {
    try {
      Zotero.Reader.unregisterEventListener(
        "createAnnotationContextMenu",
        menuHandler as never,
      );
    } catch (error) {
      log(
        "unregister createAnnotationContextMenu failed:",
        errorToString(error),
      );
    }
    menuHandler = null;
  }
  try {
    for (const reader of Zotero.Reader._readers || []) {
      try {
        const doc = (reader as ReaderLike)._iframeWindow?.document;
        doc
          ?.querySelectorAll(".pm-translate-popover, .pm-translate-actions")
          .forEach((node: Element) => node.remove());
      } catch {
        // skip dead readers
      }
    }
  } catch {
    // ignore
  }
}
