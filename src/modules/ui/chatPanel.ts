/**
 * Chat entry points in the PDF reader and the docked chat panel.
 *
 * Owned by the chat UI module. `registerChatEntryPoints` wires the reader
 * toolbar button and the tab notifier; the selection-popup buttons are
 * registered separately by `selectionPopup.ts` to keep one registration site
 * per reader event type.
 */

import { config } from "../../../package.json";
import { t } from "../../utils/i18n";
import { findPDFAttachment, getRegularItemForReader } from "../../utils/item";
import { errorToString, log } from "../../utils/log";
import { createZoteroIcon } from "../../utils/icons";
import { injectStylesIntoDocument } from "../../utils/styles";
import { toast } from "../../utils/ui";
import { maybeAutoGenerateSummary } from "../ai/summary";
import { ChatPanel } from "../chat/panel";
import { releaseChatSessions } from "../chat/store";
import {
  getActiveReader,
  getMainWindow,
  getPaperItemForReader,
  getSelectedTabType,
  resolvePaperItem,
  type ReaderLike,
} from "../chat/reader";

const HTML_NS = "http://www.w3.org/1999/xhtml";
const PLUGIN_ID = config.addonID;
const TOOLBAR_BUTTON_ID = "paperminer-chat-toolbar-button";
const TOOLBAR_BUTTON_CLASS = "pm-chat-tb-btn";

let registered = false;
let panel: ChatPanel | null = null;
let panelItemKey: string | null = null;
let panelTabID: string | null = null;
let notifierID: string | null = null;
let toolbarHandler: ((event: unknown) => void) | null = null;
let announcedReaders = new WeakSet<object>();

/* ------------------------------------------------------------------ */
/* Reader toolbar                                                      */
/* ------------------------------------------------------------------ */

interface ReaderToolbarEvent {
  reader: ReaderLike;
  doc: Document;
  append?: (...nodes: Array<Node | string>) => void;
}

function createToolbarButton(
  doc: Document,
  reader: ReaderLike,
): HTMLButtonElement {
  const button = doc.createElementNS(HTML_NS, "button") as HTMLButtonElement;
  button.id = TOOLBAR_BUTTON_ID;
  button.type = "button";
  button.className = TOOLBAR_BUTTON_CLASS;
  const label = t("chat-toolbar-tooltip", "PaperMiner 阅读对话");
  button.title = label;
  button.setAttribute("aria-label", label);
  button.appendChild(createZoteroIcon(doc, "annotate-note", { size: 16 }));
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const item = getPaperItemForReader(reader);
    if (item && panel && panelItemKey === item.key) {
      closeChatPanel();
      return;
    }
    void openChatPanel(item || undefined);
  });
  return button;
}

function handleRenderToolbar(rawEvent: unknown): void {
  const event = rawEvent as ReaderToolbarEvent;
  const { reader, doc, append } = event || ({} as ReaderToolbarEvent);
  if (!doc || typeof append !== "function") return;
  try {
    void injectStylesIntoDocument(doc);
    doc.getElementById(TOOLBAR_BUTTON_ID)?.remove();
    append(createToolbarButton(doc, reader));
  } catch (error) {
    log("failed to inject chat toolbar button:", errorToString(error));
  }
  if (reader && typeof reader === "object" && !announcedReaders.has(reader)) {
    announcedReaders.add(reader);
    void onReaderOpened(reader);
  }
}

/* ------------------------------------------------------------------ */
/* Tab synchronisation                                                 */
/* ------------------------------------------------------------------ */

function handleTabNotify(event: string, type: string): void {
  if (type !== "tab" || !panel) return;
  if (event === "select") {
    const reader = getActiveReader();
    const readerTabID = reader?.tabID || null;
    if (getSelectedTabType() !== "reader" || !readerTabID) {
      closeChatPanel();
      return;
    }
    if (panelTabID && readerTabID !== panelTabID) {
      closeChatPanel();
    }
    return;
  }
  if (event === "close" && panelTabID) {
    const win = getMainWindow();
    const closedOurTab =
      win?.Zotero_Tabs?.selectedID === panelTabID ||
      !win?.document.getElementById(panelTabID);
    if (closedOurTab) closeChatPanel();
  }
}

/* ------------------------------------------------------------------ */
/* Panel lifecycle                                                     */
/* ------------------------------------------------------------------ */

function ensurePanel(): ChatPanel {
  if (panel) return panel;
  panel = new ChatPanel({
    onRequestClose: () => closeChatPanel(),
  });
  return panel;
}

async function resolveAttachment(
  item: Zotero.Item,
): Promise<Zotero.Item | null> {
  if (item.isAttachment()) {
    if (item.attachmentContentType === "application/pdf") return item;
    const parent = getRegularItemForReader(item);
    return parent ? findPDFAttachment(parent) : null;
  }
  return findPDFAttachment(item);
}

/**
 * Open (or switch) the docked chat panel.
 *
 * Works from the item pane (opens the PDF reader first) and from the reader
 * toolbar (uses the current reader). When the item has no PDF, the user gets a
 * friendly toast instead of an error.
 */
export async function openChatPanel(
  item?: Zotero.Item,
  options: { quotedText?: string } = {},
): Promise<void> {
  try {
    let target = resolvePaperItem(item);
    let reader = getActiveReader();
    let readerItem = getPaperItemForReader(reader);

    if (!target) target = readerItem;
    if (!target) {
      const win = getMainWindow();
      const selected = win?.ZoteroPane?.getSelectedItems?.() || [];
      target = resolvePaperItem(selected[0] as Zotero.Item);
    }
    if (!target) {
      toast(t("chat-no-paper", "请先选择一篇论文"), "default");
      return;
    }

    if (!reader || !readerItem || readerItem.key !== target.key) {
      const attachment = await resolveAttachment(target);
      if (!attachment) {
        toast(
          t("chat-no-pdf", "该条目没有可读取的 PDF 附件，无法使用阅读对话"),
          "fail",
        );
        return;
      }
      const opened = await Zotero.Reader.open(attachment.id);
      const openedReader = (opened as ReaderLike | undefined) || null;
      if (openedReader) {
        reader = openedReader;
        try {
          await (openedReader as { _initPromise?: Promise<unknown> })
            ._initPromise;
        } catch {
          // The reader is still opening; its toolbar render will follow.
        }
      }
      reader = getActiveReader() || reader;
      readerItem = getPaperItemForReader(reader) || target;
    }

    const chatPanel = ensurePanel();
    await chatPanel.open({
      item: readerItem || target,
      reader,
      quotedText: options.quotedText,
    });
    panelItemKey = (readerItem || target).key;
    panelTabID = reader?.tabID || null;
  } catch (error) {
    log("openChatPanel failed:", errorToString(error));
    toast(
      t("chat-open-failed", "打开阅读对话失败：{message}", {
        message: errorToString(error),
      }),
      "fail",
    );
  }
}

/** Toggle the panel for the given item (or the current reader). */
export async function toggleChatPanel(item?: Zotero.Item): Promise<void> {
  if (panel) {
    closeChatPanel();
    return;
  }
  await openChatPanel(item);
}

/** Close the docked panel and restore the context pane. */
export function closeChatPanel(): void {
  const current = panel;
  panel = null;
  panelItemKey = null;
  panelTabID = null;
  if (!current) return;
  try {
    current.destroy();
  } catch (error) {
    log("destroy chat panel failed:", errorToString(error));
  }
}

export function isChatPanelOpen(): boolean {
  return Boolean(panel);
}

export function getChatPanelItemKey(): string | null {
  return panelItemKey;
}

/** Copy the current conversation as Markdown (used by menus / Lead). */
export function copyChatConversation(): void {
  try {
    panel?.copyConversation();
  } catch (error) {
    log("copyChatConversation failed:", errorToString(error));
  }
}

/* ------------------------------------------------------------------ */
/* Registration                                                        */
/* ------------------------------------------------------------------ */

export function registerChatEntryPoints(): void {
  if (registered) return;
  registered = true;
  announcedReaders = new WeakSet<object>();

  toolbarHandler = handleRenderToolbar;
  try {
    Zotero.Reader.registerEventListener(
      "renderToolbar",
      toolbarHandler as never,
      PLUGIN_ID,
    );
  } catch (error) {
    log("register renderToolbar failed:", errorToString(error));
  }

  try {
    notifierID = Zotero.Notifier.registerObserver(
      {
        notify: (event: string, type: string) => handleTabNotify(event, type),
      },
      ["tab"],
      `${config.addonRef}-chat-ui`,
    );
  } catch (error) {
    log("register tab notifier failed:", errorToString(error));
  }
}

export function unregisterChatEntryPoints(): void {
  if (!registered) return;
  registered = false;
  closeChatPanel();
  if (toolbarHandler) {
    try {
      Zotero.Reader.unregisterEventListener(
        "renderToolbar",
        toolbarHandler as never,
      );
    } catch (error) {
      log("unregister renderToolbar failed:", errorToString(error));
    }
    toolbarHandler = null;
  }
  if (notifierID) {
    try {
      Zotero.Notifier.unregisterObserver(notifierID);
    } catch (error) {
      log("unregister tab notifier failed:", errorToString(error));
    }
    notifierID = null;
  }
  // Remove any toolbar buttons left behind in open readers.
  try {
    for (const reader of Zotero.Reader._readers || []) {
      try {
        const doc = (reader as ReaderLike)._iframeWindow?.document;
        doc?.getElementById(TOOLBAR_BUTTON_ID)?.remove();
      } catch {
        // skip dead readers
      }
    }
  } catch {
    // ignore
  }
  try {
    const win = getMainWindow();
    win?.document?.getElementById("paperminer-chat-panel")?.remove();
  } catch {
    // ignore
  }
  announcedReaders = new WeakSet<object>();
  releaseChatSessions();
}

/** Called when a PDF reader becomes active; may trigger auto summary. */
export async function onReaderOpened(reader: any): Promise<void> {
  if (!reader) return;
  const paperItem = getPaperItemForReader(reader as ReaderLike);
  if (!paperItem) return;
  try {
    await maybeAutoGenerateSummary(paperItem);
  } catch (error) {
    log("maybeAutoGenerateSummary failed:", errorToString(error));
  }
  if (panel && panel.currentItem?.key === paperItem.key) {
    // Give the header a chance to pick up settings that changed meanwhile.
    try {
      await panel.open({
        item: paperItem,
        reader: reader as ReaderLike,
      });
    } catch (error) {
      log("refresh chat panel failed:", errorToString(error));
    }
  }
}
