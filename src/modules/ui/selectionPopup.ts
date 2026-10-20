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
import { createAbortController } from "../../utils/abort";
import { isTranslationConfigured, translateText } from "../ai/translate";
import { injectStylesIntoDocument } from "../../utils/styles";
import {
  closeTranslatePopover,
  openTranslatePopover,
} from "../chat/translatePopover";
import {
  collectAnnotationText,
  getPaperItemForReader,
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

function makeButton(
  doc: Document,
  label: string,
  className = "pm-inline-translate-btn",
): HTMLButtonElement {
  const button = doc.createElementNS(HTML_NS, "button") as HTMLButtonElement;
  button.type = "button";
  button.className = className;
  button.textContent = label;
  return button;
}

function appendInlineTranslation(
  doc: Document,
  reader: ReaderLike,
  text: string,
): HTMLElement {
  const card = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
  card.className = "pm-inline-translate";
  card.addEventListener("mousedown", (event) => event.stopPropagation());
  card.addEventListener("pointerup", (event) => event.stopPropagation());

  const head = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
  head.className = "pm-inline-translate-head";
  const title = doc.createElementNS(HTML_NS, "span") as HTMLSpanElement;
  title.className = "pm-inline-translate-title";
  title.textContent = t("chat-translate-title", "翻译");
  const status = doc.createElementNS(HTML_NS, "span") as HTMLSpanElement;
  status.className = "pm-inline-translate-status";
  status.textContent = t("chat-translate-doing", "翻译中…");
  head.append(title, status);

  const output = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
  output.className = "pm-inline-translate-text";
  output.textContent = t("chat-translate-doing", "翻译中…");

  const footer = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
  footer.className = "pm-inline-translate-footer";
  const copy = makeButton(doc, t("chat-copy", "复制"));
  copy.hidden = true;
  const settings = makeButton(doc, t("chat-open-settings", "打开设置"));
  settings.hidden = true;
  const ask = makeButton(doc, t("chat-ask-ai", "问 AI"));
  footer.append(copy, settings, ask);
  card.append(head, output, footer);

  const controller = createAbortController();
  let result = "";
  const isAlive = () => {
    if (controller.signal.aborted || !card.isConnected) {
      if (!card.isConnected) controller.abort();
      return false;
    }
    return true;
  };
  const setStatus = (value: string) => {
    if (isAlive()) status.textContent = value;
  };
  const showError = (message: string) => {
    if (!isAlive()) return;
    output.classList.add("pm-inline-translate-error");
    output.textContent = message;
    status.textContent = "";
    copy.hidden = true;
    settings.hidden = !/(设置|API|Key|引擎|配置)/i.test(message);
  };

  const run = async () => {
    if (!isTranslationConfigured()) {
      showError(
        t(
          "chat-translate-not-configured",
          "翻译引擎尚未配置，请先在 PaperMiner 设置中填写翻译引擎或 API Key。",
        ),
      );
      return;
    }
    try {
      const value = await translateText(text, {
        signal: controller.signal,
        targetLang: String(getPref("translateTarget") || "auto"),
        context: getTranslationContext(reader),
        onDelta: (delta) => {
          if (!isAlive()) return;
          result += delta;
          output.textContent = result;
          status.textContent = t("chat-translate-doing", "翻译中…");
        },
      });
      if (!isAlive()) return;
      result = String(value || result);
      output.textContent =
        result || t("chat-translate-empty", "没有获取到译文，请重试。");
      output.classList.toggle("pm-inline-translate-error", !result);
      status.textContent = result ? t("chat-translate-done", "翻译完成") : "";
      copy.hidden = !result;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : errorToString(error);
      showError(message);
    }
  };

  copy.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!result) return;
    void navigator.clipboard
      ?.writeText(result)
      .then(() => setStatus(t("chat-copied", "已复制")))
      .catch((error: unknown) => log("copy translation failed:", error));
  });
  settings.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      Zotero.Utilities.Internal.openPreferences("paperminer-preference-pane");
    } catch (error) {
      log("open preferences failed:", errorToString(error));
    }
  });
  ask.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    askAIFromReader(reader, text);
  });

  // Let Zotero append the card to the selection popup first, otherwise the
  // initial "not configured" state is mistaken for a detached element.
  setTimeout(() => void run(), 0);
  return card;
}

function handleSelectionPopup(rawEvent: unknown): void {
  const event = rawEvent as SelectionPopupEvent;
  const text = String(event?.params?.annotation?.text || "").trim();
  if (!text || typeof event.append !== "function") return;
  const doc = event.doc || getReaderDocument(event.reader);
  if (!doc) return;
  void injectStylesIntoDocument(doc);

  if (!isPopupEnabled()) {
    const container = doc.createElementNS(HTML_NS, "div") as HTMLDivElement;
    container.className = "pm-translate-actions";
    const translate = createActionButton(
      doc,
      t("chat-translate-button", "翻译"),
      () => {
        translate.remove();
        container.appendChild(appendInlineTranslation(doc, event.reader, text));
      },
    );
    container.appendChild(translate);
    container.appendChild(
      createActionButton(doc, t("chat-ask-ai", "问 AI"), () =>
        askAIFromReader(event.reader, text),
      ),
    );
    event.append(container);
    return;
  }
  const popup = doc.querySelector(".selection-popup") as HTMLElement | null;
  if (popup) popup.style.maxWidth = "none";
  event.append(appendInlineTranslation(doc, event.reader, text));
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
