/**
 * Docked reading-chat panel.
 *
 * The panel lives inside the main window's right-hand context pane
 * (`#zotero-context-pane`) as an absolutely-positioned overlay, so it is a real
 * docked side panel — not a floating window — and its width follows the pane.
 * Opening the panel expands the pane/splitter; closing restores the previous
 * state.
 */

import { clearChildren } from "../../utils/html";
import { t } from "../../utils/i18n";
import { getItemMeta, getItemTitle } from "../../utils/item";
import { errorToString, log } from "../../utils/log";
import { getNumberPref, getPref } from "../../utils/prefs";
import { injectStylesIntoDocument } from "../../utils/styles";
import { copyText, showProgress, toast } from "../../utils/ui";
import { getLLMConfig, getLLMConfigError, isLLMConfigured } from "../ai/config";
import { createAbortController } from "../../utils/abort";
import { createZoteroIcon } from "../../utils/icons";
import { chatCompletion, LLMError } from "../ai/llm";
import { getPaperText } from "../ai/paperText";
import { generatePpt } from "../ai/ppt";
import { generateSummary, openSummaryNote } from "../ai/summary";
import {
  buildChatContext,
  buildChatMessages,
  buildSystemPrompt,
  DEFAULT_CONTEXT_CHARS,
  DEFAULT_MAX_HISTORY,
  type ChatContextResult,
} from "./context";
import { renderMarkdown } from "./markdown";
import { loadQuickPhrases } from "./quickPhrases";
import {
  buildSession,
  clearChatSession,
  createMessageId,
  exportSessionMarkdown,
  loadChatSession,
  MAX_MESSAGE_CHARS,
  saveChatSession,
} from "./store";
import { openPreferencesPane } from "./preferences";
import { getMainWindow, getReaderDocument, type ReaderLike } from "./reader";
import type { ChatSession, StoredChatMessage } from "./session";

const HTML_NS = "http://www.w3.org/1999/xhtml";
const PANEL_ID = "paperminer-chat-panel";
const STREAM_RENDER_INTERVAL_MS = 80;
const SAVE_DEBOUNCE_MS = 500;
const INPUT_MAX_CHARS = 4000;
const MIN_DOCKED_WIDTH = 340;
const DOCKED_WIDTH = 380;
const OVERLAY_WIDTH = 380;

type El<K extends keyof HTMLElementTagNameMap> = HTMLElementTagNameMap[K];

function mk<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
  text?: string,
): El<K> {
  const node = doc.createElementNS(HTML_NS, tag) as El<K>;
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function iconButton(
  doc: Document,
  iconName: string,
  title: string,
  className = "pm-chat-icon-btn",
): HTMLButtonElement {
  const button = mk(doc, "button", `pm-icon-btn ${className}`);
  button.type = "button";
  button.title = title;
  button.setAttribute("aria-label", title);
  button.appendChild(createZoteroIcon(doc, iconName, { size: 16 }));
  return button;
}

/** Fluent-aware interpolation that also fills plain `{name}` fallbacks. */
function tWith(
  key: string,
  fallback: string,
  values: Record<string, string | number>,
): string {
  const result = t(key, fallback, values);
  return result.replace(/\{\s*\$?([a-zA-Z0-9_]+)\s*\}/g, (match, name) =>
    values[name] === undefined ? match : String(values[name]),
  );
}

function truncate(text: string, maxChars: number): string {
  const value = String(text || "").trim();
  if (value.length <= maxChars) return value;
  return value.slice(0, Math.max(0, maxChars - 1)) + "…";
}

function formatTime(timestamp: number): string {
  try {
    const date = new Date(timestamp);
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    return `${hours}:${minutes}`;
  } catch {
    return "";
  }
}

export interface ChatPanelShowOptions {
  item: Zotero.Item;
  reader?: ReaderLike | null;
  quotedText?: string;
}

export interface ChatPanelCallbacks {
  /** Called when the user closes the panel (header button or API). */
  onRequestClose: () => void;
}

interface PanelHost {
  pane: HTMLElement | null;
  docked: boolean;
  wasCollapsed: boolean;
  previousPanePosition: string;
  previousPaneWidth: string;
}

interface LLMErrorInfo {
  message: string;
  configHint: boolean;
}

const SUGGESTION_KEYS: Array<[string, string]> = [
  ["chat-suggest-1", "这篇论文解决什么问题？"],
  ["chat-suggest-2", "主要方法和创新点是什么？"],
  ["chat-suggest-3", "实验设计和结论可信吗？"],
  ["chat-suggest-4", "这篇论文有哪些局限性？"],
];

export class ChatPanel {
  private callbacks: ChatPanelCallbacks;
  private win: _ZoteroTypes.MainWindow;
  private doc: Document;
  private root!: HTMLElement;
  private paperTitleEl!: HTMLElement;
  private paperSubEl!: HTMLElement;
  private modelBadge!: HTMLElement;
  private summaryButton!: HTMLButtonElement;
  private pptButton!: HTMLButtonElement;
  private newChatButton!: HTMLButtonElement;
  private closeButton!: HTMLButtonElement;
  private messagesEl!: HTMLElement;
  private quoteEl!: HTMLElement;
  private quoteTextEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private hintEl!: HTMLElement;
  private countEl!: HTMLElement;
  private sendButton!: HTMLButtonElement;
  private stopButton!: HTMLButtonElement;

  private host: PanelHost | null = null;
  private item: Zotero.Item | null = null;
  private reader: ReaderLike | null = null;
  private session: ChatSession | null = null;
  private pendingQuote = "";
  private lastQuestion = "";
  private paperText: {
    text: string;
    fullTextLength: number;
    truncated: boolean;
  } | null = null;
  private paperTextPromise: Promise<void> | null = null;

  private streaming = false;
  private abortController: AbortController | null = null;
  private streamBuffer = "";
  private streamNodeId: string | null = null;
  private streamTimer: ReturnType<typeof setTimeout> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private messageNodes = new Map<string, HTMLElement>();

  private busy = false;
  private disposed = false;
  /** Set when the context pane's relative positioning proved unusable. */
  private fixedFallback = false;
  private fallbackResizeHandler: (() => void) | null = null;
  private fallbackObserver: MutationObserver | null = null;

  constructor(callbacks: ChatPanelCallbacks) {
    this.callbacks = callbacks;
    const win = getMainWindow();
    if (!win) {
      throw new Error("Zotero main window is not available");
    }
    this.win = win;
    this.doc = win.document;
    this.buildDom();
  }

  get currentItem(): Zotero.Item | null {
    return this.item;
  }

  get isStreaming(): boolean {
    return this.streaming;
  }

  /* ------------------------------------------------------------------ */
  /* Private constructor helpers                                         */
  /* ------------------------------------------------------------------ */

  private buildDom(): void {
    const doc = this.doc;
    const root = mk(doc, "div", "pm-root pm-chat-panel");
    root.id = PANEL_ID;
    root.setAttribute("role", "complementary");
    root.setAttribute(
      "aria-label",
      t("chat-panel-title", "PaperMiner 阅读对话"),
    );

    /* header */
    const header = mk(doc, "header", "pm-chat-header");
    const heading = mk(doc, "div", "pm-chat-heading");
    this.paperTitleEl = mk(
      doc,
      "span",
      "pm-chat-title",
      t("chat-panel-title", "阅读对话"),
    );
    this.paperSubEl = mk(doc, "span", "pm-chat-paper", "");
    heading.append(this.paperTitleEl, this.paperSubEl);

    const actions = mk(doc, "div", "pm-chat-actions");
    this.modelBadge = mk(
      doc,
      "span",
      "pm-badge pm-badge-neutral pm-chat-model",
    );
    this.summaryButton = iconButton(
      doc,
      "abstract",
      t("chat-summary-tooltip", "生成 AI 摘要"),
    );
    this.pptButton = iconButton(
      doc,
      "page",
      t("chat-ppt-tooltip", "根据论文生成 PPT"),
      "pm-chat-icon-btn pm-chat-ppt",
    );
    this.newChatButton = iconButton(
      doc,
      "refresh",
      t("chat-new-chat", "新对话"),
    );
    this.closeButton = iconButton(doc, "cross", t("chat-close", "关闭面板"));
    actions.append(
      this.modelBadge,
      this.summaryButton,
      this.pptButton,
      this.newChatButton,
      this.closeButton,
    );
    header.append(heading, actions);

    /* messages */
    const messages = mk(doc, "div", "pm-chat-messages");
    messages.setAttribute("role", "log");
    messages.setAttribute("aria-live", "polite");

    /* composer */
    const composer = mk(doc, "div", "pm-chat-composer");

    const quote = mk(doc, "div", "pm-chat-quote");
    quote.hidden = true;
    const quoteLabel = mk(
      doc,
      "span",
      "pm-chat-quote-label",
      t("chat-quote-label", "引用"),
    );
    this.quoteTextEl = mk(doc, "span", "pm-chat-quote-text", "");
    const quoteRemove = mk(
      doc,
      "button",
      "pm-icon-btn pm-chat-quote-remove",
      "×",
    );
    quoteRemove.type = "button";
    quoteRemove.title = t("chat-quote-remove", "移除引用");
    quoteRemove.setAttribute("aria-label", t("chat-quote-remove", "移除引用"));
    quote.append(quoteLabel, this.quoteTextEl, quoteRemove);

    const input = mk(
      doc,
      "textarea",
      "pm-textarea pm-chat-input",
    ) as HTMLTextAreaElement;
    input.rows = 1;
    input.placeholder = t(
      "chat-input-placeholder",
      "就这篇论文提问…（Enter 发送，Shift+Enter 换行）",
    );
    input.setAttribute("aria-label", t("chat-input-placeholder", "向论文提问"));

    const bar = mk(doc, "div", "pm-chat-composer-bar");
    this.hintEl = mk(
      doc,
      "span",
      "pm-chat-hint",
      t("chat-input-hint", "Enter 发送 · Shift+Enter 换行"),
    );
    this.countEl = mk(doc, "span", "pm-chat-count", "");
    this.stopButton = mk(doc, "button", "pm-btn pm-chat-stop");
    this.stopButton.type = "button";
    this.stopButton.textContent = t("chat-stop", "停止");
    this.stopButton.hidden = true;
    this.sendButton = mk(doc, "button", "pm-btn pm-btn-primary pm-chat-send");
    this.sendButton.type = "button";
    this.sendButton.textContent = t("chat-send", "发送");
    const templateSelect = mk(this.doc, "select", "pm-chat-template-select");
    templateSelect.setAttribute(
      "aria-label",
      t("chat-template-label", "对话模板"),
    );
    const placeholderOption = mk(
      this.doc,
      "option",
      "",
      t("chat-template-placeholder", "模板…"),
    );
    placeholderOption.value = "";
    templateSelect.appendChild(placeholderOption);
    for (const phrase of loadQuickPhrases()) {
      const option = mk(this.doc, "option", "", phrase.label);
      option.value = phrase.prompt;
      option.title = phrase.prompt;
      templateSelect.appendChild(option);
    }
    templateSelect.addEventListener("change", () => {
      const prompt = templateSelect.value;
      if (!prompt) return;
      const existing = this.inputEl.value.trim();
      this.inputEl.value = existing ? `${existing}\n${prompt}` : prompt;
      templateSelect.value = "";
      this.autoGrow();
      this.updateComposerState();
      this.focus();
    });

    bar.prepend(templateSelect);
    bar.append(this.hintEl, this.countEl, this.stopButton, this.sendButton);

    composer.append(quote, input, bar);
    root.append(header, messages, composer);

    this.root = root;
    this.messagesEl = messages;
    this.quoteEl = quote;
    this.inputEl = input;

    /* events */
    input.addEventListener("input", () => {
      this.autoGrow();
      this.updateComposerState();
    });
    input.addEventListener("keydown", (rawEvent) => {
      const event = rawEvent as KeyboardEvent;
      if (event.key !== "Enter" || event.shiftKey) return;
      if (event.isComposing) return;
      event.preventDefault();
      void this.send();
    });
    quoteRemove.addEventListener("click", () => this.clearQuote());
    this.sendButton.addEventListener("click", () => void this.send());
    this.stopButton.addEventListener("click", () => this.stopStreaming());
    this.closeButton.addEventListener("click", () =>
      this.callbacks.onRequestClose(),
    );
    this.newChatButton.addEventListener(
      "click",
      () => void this.startNewChat(),
    );
    this.summaryButton.addEventListener("click", () => void this.summarize());
    this.pptButton.addEventListener("click", () => void this.makePpt());
    this.messagesEl.addEventListener("click", (event) =>
      this.handleMessagesClick(event),
    );
  }

  /* ------------------------------------------------------------------ */
  /* Lifetime                                                            */
  /* ------------------------------------------------------------------ */

  /** Mount the panel and show the conversation for `options.item`. */
  async open(options: ChatPanelShowOptions): Promise<void> {
    if (this.disposed) return;
    this.reader = options.reader || this.reader;
    if (!this.host) {
      const mounted = this.mount();
      if (!mounted) {
        throw new Error(
          t("chat-panel-no-host", "找不到可停靠的侧栏，无法打开阅读对话"),
        );
      }
    }
    this.root.hidden = false;
    await this.setItem(options.item, options.reader || null);
    if (options.quotedText) this.setQuote(options.quotedText);
    this.renderAll();
    this.autoGrow();
    this.updateComposerState();
    try {
      this.inputEl.focus();
    } catch {
      // ignore
    }
  }

  /** Tear down the panel and restore the side pane. */
  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abortStreaming();
    this.flushSave();
    if (this.streamTimer) {
      clearTimeout(this.streamTimer);
      this.streamTimer = null;
    }
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.messageNodes.clear();
    this.restoreHost();
    this.session = null;
    this.item = null;
    this.reader = null;
    this.paperText = null;
    this.paperTextPromise = null;
  }

  /** Focus the composer (used after opening from a toolbar button). */
  focus(): void {
    try {
      this.inputEl.focus();
    } catch {
      // ignore
    }
  }

  /* ------------------------------------------------------------------ */
  /* Docking                                                             */
  /* ------------------------------------------------------------------ */

  private mount(): boolean {
    const stale = this.doc.getElementById(PANEL_ID);
    if (stale && stale !== this.root) stale.remove();

    const pane = this.doc.getElementById(
      "zotero-context-pane",
    ) as HTMLElement | null;
    if (pane) {
      const contextPane = (
        this.win as unknown as {
          ZoteroContextPane?: { collapsed?: boolean };
        }
      ).ZoteroContextPane;
      let wasCollapsed = false;
      try {
        wasCollapsed = contextPane
          ? Boolean(contextPane.collapsed)
          : pane.getAttribute("collapsed") === "true";
      } catch {
        wasCollapsed = false;
      }
      const previousPanePosition = pane.style.position || "";
      const previousPaneWidth = pane.style.width || "";
      pane.style.position = "relative";
      try {
        if (contextPane) {
          contextPane.collapsed = false;
        } else {
          pane.setAttribute("collapsed", "false");
          this.doc
            .getElementById("zotero-context-splitter")
            ?.setAttribute("state", "");
        }
      } catch (error) {
        log("failed to expand context pane:", error);
      }
      if (pane.getBoundingClientRect().width < MIN_DOCKED_WIDTH) {
        pane.style.width = `${DOCKED_WIDTH}px`;
      }
      this.root.classList.add("pm-chat-panel-docked");
      this.root.classList.remove("pm-chat-panel-overlay");
      pane.appendChild(this.root);
      this.host = {
        pane,
        docked: true,
        wasCollapsed,
        previousPanePosition,
        previousPaneWidth,
      };
      this.scheduleDockVerification();
      return true;
    }

    // Standalone reader window / unexpected layout: fall back to an in-reader
    // overlay that still sits on the right-hand side (never a separate window).
    const readerDoc = getReaderDocument(this.reader);
    if (readerDoc?.body) {
      void injectStylesIntoDocument(readerDoc);
      this.root.classList.add("pm-chat-panel-overlay");
      this.root.classList.remove("pm-chat-panel-docked");
      this.root.style.width = `${OVERLAY_WIDTH}px`;
      readerDoc.body.appendChild(this.root);
      this.host = {
        pane: null,
        docked: false,
        wasCollapsed: false,
        previousPanePosition: "",
        previousPaneWidth: "",
      };
      return true;
    }
    return false;
  }

  /**
   * A XUL `<box>` normally establishes a containing block for the absolutely
   * positioned panel. If a Zotero version or theme breaks that, fall back to a
   * fixed overlay pinned to the pane's rectangle so the panel still docks to
   * the right-hand column instead of escaping the window.
   */
  private scheduleDockVerification(): void {
    const verify = () => this.verifyDockedLayout();
    try {
      this.win.requestAnimationFrame(verify);
    } catch {
      setTimeout(verify, 60);
    }
  }

  private verifyDockedLayout(): void {
    if (this.disposed || this.fixedFallback) return;
    const pane = this.host?.pane;
    if (!pane) return;
    const paneRect = pane.getBoundingClientRect();
    if (paneRect.width <= 0 || paneRect.height <= 0) return;
    const rootRect = this.root.getBoundingClientRect();
    const misplaced =
      Math.abs(rootRect.left - paneRect.left) > 8 ||
      Math.abs(rootRect.top - paneRect.top) > 8 ||
      Math.abs(rootRect.width - paneRect.width) > 8;
    if (!misplaced) return;
    this.applyFixedFallback();
  }

  private applyFixedFallback(): void {
    const pane = this.host?.pane;
    if (!pane || this.fixedFallback) return;
    this.fixedFallback = true;
    this.root.classList.add("pm-chat-panel-fixed");
    const place = () => {
      const host = this.host;
      if (this.disposed || !host?.pane) return;
      const rect = host.pane.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      this.root.style.position = "fixed";
      this.root.style.left = `${rect.left}px`;
      this.root.style.top = `${rect.top}px`;
      this.root.style.width = `${rect.width}px`;
      this.root.style.height = `${rect.height}px`;
    };
    place();
    this.fallbackResizeHandler = place;
    try {
      this.win.addEventListener("resize", place);
    } catch {
      // ignore
    }
    const MutationObserverClass = (
      this.win as unknown as {
        MutationObserver?: typeof MutationObserver;
      }
    ).MutationObserver;
    if (MutationObserverClass) {
      try {
        this.fallbackObserver = new MutationObserverClass(place);
        this.fallbackObserver.observe(pane, { attributes: true });
      } catch {
        this.fallbackObserver = null;
      }
    }
  }

  private releaseFixedFallback(): void {
    if (this.fallbackResizeHandler) {
      try {
        this.win.removeEventListener("resize", this.fallbackResizeHandler);
      } catch {
        // ignore
      }
      this.fallbackResizeHandler = null;
    }
    this.fallbackObserver?.disconnect();
    this.fallbackObserver = null;
    this.fixedFallback = false;
  }

  private restoreHost(): void {
    this.releaseFixedFallback();
    this.root.remove();
    const host = this.host;
    this.host = null;
    if (!host?.pane) return;
    const pane = host.pane;
    try {
      if (host.previousPanePosition) {
        pane.style.position = host.previousPanePosition;
      } else {
        pane.style.removeProperty("position");
      }
      if (host.previousPaneWidth) {
        pane.style.width = host.previousPaneWidth;
      } else {
        pane.style.removeProperty("width");
      }
      if (host.wasCollapsed) {
        const contextPane = (
          this.win as unknown as {
            ZoteroContextPane?: { collapsed?: boolean };
          }
        ).ZoteroContextPane;
        if (contextPane) {
          contextPane.collapsed = true;
        } else {
          pane.setAttribute("collapsed", "true");
          this.doc
            .getElementById("zotero-context-splitter")
            ?.setAttribute("state", "collapsed");
        }
      }
    } catch (error) {
      log("failed to restore context pane:", error);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Session                                                             */
  /* ------------------------------------------------------------------ */

  private async setItem(
    item: Zotero.Item,
    reader: ReaderLike | null,
  ): Promise<void> {
    const sameItem = this.item?.key && this.item.key === item.key;
    if (sameItem && this.session) {
      this.reader = reader;
      this.updateHeader();
      return;
    }
    this.abortStreaming();
    await this.flushSave();
    this.item = item;
    this.reader = reader;
    this.paperText = null;
    this.paperTextPromise = null;
    this.lastQuestion = "";
    this.clearQuote();
    let loaded: ChatSession | null = null;
    try {
      loaded = await loadChatSession(item);
    } catch (error) {
      log("load session failed:", errorToString(error));
    }
    this.session = loaded || buildSession(item, []);
    if (!this.session.title)
      this.session.title = getItemTitle(item) || item.key;
    this.updateHeader();
    this.renderAll();
    void this.prefetchPaperText();
  }

  private ensureSession(): ChatSession | null {
    if (!this.item) return null;
    if (!this.session) {
      this.session = buildSession(this.item, []);
    }
    return this.session;
  }

  private saveSoon(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flushSave();
    }, SAVE_DEBOUNCE_MS);
  }

  private async flushSave(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const session = this.session;
    if (!session || !session.messages.length) return;
    try {
      session.updatedAt = Date.now();
      await saveChatSession(session);
    } catch (error) {
      log("save session failed:", errorToString(error));
    }
  }

  private async startNewChat(): Promise<void> {
    if (!this.item) return;
    const session = this.ensureSession();
    if (session?.messages.length) {
      try {
        if (
          !this.win.confirm(
            t("chat-new-chat-confirm", "清空当前对话并开始新的对话？"),
          )
        ) {
          return;
        }
      } catch {
        // If the prompt is unavailable, clear without asking.
      }
    }
    this.abortStreaming();
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.messageNodes.clear();
    this.lastQuestion = "";
    try {
      await clearChatSession(this.item);
    } catch (error) {
      log("clear session failed:", errorToString(error));
    }
    this.session = buildSession(this.item, []);
    this.renderAll();
    this.updateComposerState();
    this.focus();
  }

  /* ------------------------------------------------------------------ */
  /* Paper context                                                       */
  /* ------------------------------------------------------------------ */

  private async prefetchPaperText(): Promise<void> {
    if (this.paperText || this.paperTextPromise || !this.item) return;
    const item = this.item;
    this.paperTextPromise = (async () => {
      try {
        const result = await getPaperText(item);
        if (this.item !== item) return;
        this.paperText = {
          text: String(result?.text || ""),
          fullTextLength: Number(result?.fullTextLength) || 0,
          truncated: Boolean(result?.truncated),
        };
      } catch (error) {
        log("getPaperText failed:", errorToString(error));
        if (this.item === item) {
          this.paperText = { text: "", fullTextLength: 0, truncated: false };
        }
      } finally {
        this.paperTextPromise = null;
      }
    })();
    await this.paperTextPromise;
  }

  private async buildContext(question: string): Promise<ChatContextResult> {
    if (this.item && !this.paperText) {
      if (this.paperTextPromise) await this.paperTextPromise;
      else await this.prefetchPaperText();
    }
    const meta = this.item
      ? getItemMeta(this.item)
      : {
          itemID: 0,
          key: "",
          title: "",
          doi: "",
          journal: "",
          year: "",
          authors: "",
          abstract: "",
          itemType: "",
        };
    const maxChars = getNumberPref(
      "chatContextChars",
      DEFAULT_CONTEXT_CHARS,
      1000,
      200000,
      true,
    );
    return buildChatContext(
      {
        meta,
        text: this.paperText?.text || "",
        fullTextLength: this.paperText?.fullTextLength || 0,
      },
      { question, maxChars },
    );
  }

  private maxHistory(): number {
    const value = getNumberPref(
      "chatMaxHistory",
      DEFAULT_MAX_HISTORY,
      0,
      100,
      true,
    );
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_HISTORY;
  }

  private temperature(): number | undefined {
    const value = getNumberPref("chatTemperature", 0.3, 0, 2);
    return Number.isFinite(value) ? value : undefined;
  }

  /* ------------------------------------------------------------------ */
  /* Sending / streaming                                                 */
  /* ------------------------------------------------------------------ */

  private async send(): Promise<void> {
    if (this.streaming || this.busy) return;
    const item = this.item;
    const session = this.ensureSession();
    if (!item || !session) {
      toast(t("chat-no-item", "请先在阅读器中打开一篇论文"), "fail");
      return;
    }
    if (!isLLMConfigured("chat")) {
      this.renderAll();
      toast(
        getLLMConfigError("chat") ||
          t("chat-not-configured", "请先配置 AI 模型"),
        "fail",
      );
      return;
    }
    const text = this.inputEl.value.trim();
    if (!text) return;
    if (text.length > INPUT_MAX_CHARS) {
      toast(
        tWith(
          "chat-input-too-long",
          "问题过长，请精简后再发送（最多 {max} 字）",
          { max: INPUT_MAX_CHARS },
        ),
        "fail",
      );
      return;
    }
    const quote = this.pendingQuote.trim();
    const userMessage: StoredChatMessage = {
      id: createMessageId(),
      role: "user",
      content: text.slice(0, MAX_MESSAGE_CHARS),
      createdAt: Date.now(),
    };
    if (quote) userMessage.quote = quote.slice(0, 4000);
    session.messages.push(userMessage);
    this.appendMessageNode(userMessage);
    this.inputEl.value = "";
    this.autoGrow();
    this.clearQuote();
    this.updateComposerState();
    this.lastQuestion = text;
    this.scrollToBottom(true);
    this.saveSoon();
    await this.runAssistant(text, userMessage);
  }

  private async runAssistant(
    question: string,
    userMessage?: StoredChatMessage,
  ): Promise<void> {
    const session = this.session;
    if (!session || !this.item) return;
    // History passed to the model excludes the user message that is about to
    // be sent (it is appended separately by buildChatMessages).
    const history = userMessage
      ? session.messages.slice(0, session.messages.indexOf(userMessage))
      : session.messages.slice(0, -1);

    const assistantMessage: StoredChatMessage = {
      id: createMessageId(),
      role: "assistant",
      content: "",
      createdAt: Date.now(),
    };
    session.messages.push(assistantMessage);
    this.appendMessageNode(assistantMessage, true);

    const controller = createAbortController();
    this.abortController = controller;
    this.beginStreaming(assistantMessage.id);
    let full = "";
    try {
      const context = await this.buildContext(question);
      const messages = buildChatMessages({
        systemPrompt: buildSystemPrompt(
          context.contextText,
          String(getPref("chatSystemPrompt") || ""),
        ),
        history,
        question,
        maxHistory: this.maxHistory(),
      });
      full = await chatCompletion(messages, {
        purpose: "chat",
        stream: true,
        temperature: this.temperature(),
        signal: controller.signal,
        onDelta: (_delta, all) => {
          full = all;
          this.scheduleStreamRender(all);
        },
      });
      assistantMessage.content = String(full || "").trim();
      if (!assistantMessage.content) {
        throw new LLMError("parse", "模型没有返回任何内容");
      }
      delete assistantMessage.incomplete;
      this.flushStreamRender();
      this.updateMessageNode(assistantMessage);
    } catch (error) {
      const aborted =
        controller.signal.aborted ||
        (error instanceof LLMError && error.kind === "abort");
      if (aborted) {
        assistantMessage.content = String(
          full || this.streamBuffer || "",
        ).trim();
        assistantMessage.incomplete = true;
        if (!assistantMessage.content) {
          assistantMessage.content = t(
            "chat-stopped-empty",
            "（已停止生成，可重新发送问题）",
          );
        }
        this.flushStreamRender();
        this.updateMessageNode(assistantMessage);
      } else {
        const index = session.messages.indexOf(assistantMessage);
        if (index >= 0) session.messages.splice(index, 1);
        this.messageNodes.get(assistantMessage.id)?.remove();
        this.messageNodes.delete(assistantMessage.id);
        this.renderErrorCard(question, error);
      }
    } finally {
      this.endStreaming();
      this.saveSoon();
    }
  }

  private stopStreaming(): void {
    this.abortController?.abort();
  }

  private abortStreaming(): void {
    this.abortController?.abort();
    this.abortController = null;
    this.streaming = false;
    if (this.streamTimer) {
      clearTimeout(this.streamTimer);
      this.streamTimer = null;
    }
  }

  private beginStreaming(nodeId: string): void {
    this.streaming = true;
    this.streamNodeId = nodeId;
    this.streamBuffer = "";
    this.updateComposerState();
    this.hintEl.textContent = t("chat-generating", "正在生成，可点击停止…");
  }

  private endStreaming(): void {
    this.streaming = false;
    this.abortController = null;
    this.flushStreamRender();
    this.streamNodeId = null;
    this.streamBuffer = "";
    this.updateComposerState();
    this.hintEl.textContent = t(
      "chat-input-hint",
      "Enter 发送 · Shift+Enter 换行",
    );
  }

  private scheduleStreamRender(content: string): void {
    this.streamBuffer = content;
    if (this.streamTimer) return;
    this.streamTimer = setTimeout(() => {
      this.streamTimer = null;
      this.flushStreamRender();
    }, STREAM_RENDER_INTERVAL_MS);
  }

  private flushStreamRender(): void {
    if (!this.streamNodeId) return;
    const node = this.messageNodes.get(this.streamNodeId);
    if (!node) return;
    const markdown = node.querySelector<HTMLElement>(".pm-chat-markdown");
    const typing = node.querySelector<HTMLElement>(".pm-chat-typing");
    const nearBottom = this.isNearBottom();
    if (markdown) {
      const content = this.streamBuffer;
      markdown.innerHTML = content ? renderMarkdown(content) : "";
      if (content && typing) typing.remove();
      if (nearBottom) this.scrollToBottom(false);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Rendering                                                           */
  /* ------------------------------------------------------------------ */

  private renderAll(): void {
    clearChildren(this.messagesEl);
    this.messageNodes.clear();
    if (!isLLMConfigured("chat")) {
      this.messagesEl.appendChild(this.buildSetupCard());
    }
    const messages = this.session?.messages || [];
    if (!messages.length) {
      this.messagesEl.appendChild(this.buildEmptyState());
      return;
    }
    for (const message of messages) {
      this.appendMessageNode(message);
    }
    this.scrollToBottom(true);
  }

  private buildSetupCard(): HTMLElement {
    const card = mk(this.doc, "div", "pm-chat-setup");
    const title = mk(
      this.doc,
      "div",
      "pm-chat-setup-title",
      t("chat-setup-title", "尚未配置 AI 模型"),
    );
    const desc = mk(
      this.doc,
      "div",
      "pm-chat-setup-desc",
      getLLMConfigError("chat") ||
        t(
          "chat-setup-desc",
          "请先在 PaperMiner 设置中填写 API Base URL、API Key 与模型名称，然后即可开始对话。",
        ),
    );
    const actions = mk(this.doc, "div", "pm-chat-setup-actions");
    const settings = mk(this.doc, "button", "pm-btn pm-btn-primary");
    settings.type = "button";
    settings.textContent = t("chat-open-settings", "打开设置");
    settings.setAttribute("data-open-settings", "1");
    actions.append(settings);
    card.append(title, desc, actions);
    return card;
  }

  private buildEmptyState(): HTMLElement {
    const wrapper = mk(this.doc, "div", "pm-chat-empty");
    const title = mk(
      this.doc,
      "div",
      "pm-chat-empty-title",
      t("chat-empty-title", "和这篇论文对话"),
    );
    const desc = mk(
      this.doc,
      "div",
      "pm-chat-empty-desc",
      t(
        "chat-empty-desc",
        "回答只依据 PDF 正文与论文元数据，引用会标注段落编号。",
      ),
    );
    const suggestions = mk(this.doc, "div", "pm-chat-suggestions");
    for (const phrase of loadQuickPhrases()) {
      const button = mk(this.doc, "button", "pm-chat-suggestion");
      button.type = "button";
      button.textContent = phrase.label;
      button.title = phrase.prompt;
      button.dataset.suggestion = phrase.prompt;
      suggestions.appendChild(button);
    }
    wrapper.append(title, desc, suggestions);
    return wrapper;
  }

  private appendMessageNode(
    message: StoredChatMessage,
    streaming = false,
  ): HTMLElement {
    const doc = this.doc;
    const article = mk(
      doc,
      "article",
      `pm-chat-msg pm-chat-msg-${message.role}`,
    );
    article.dataset.id = message.id;

    const avatar = mk(
      doc,
      "div",
      `pm-chat-avatar pm-chat-avatar-${message.role}`,
      message.role === "user"
        ? t("chat-role-avatar-user", "你")
        : t("chat-role-avatar-assistant", "PM"),
    );
    avatar.setAttribute("aria-hidden", "true");
    const content = mk(doc, "div", "pm-chat-msg-content");

    const meta = mk(doc, "div", "pm-chat-msg-meta");
    const role = mk(
      doc,
      "span",
      "pm-chat-msg-role",
      message.role === "user"
        ? t("chat-role-user", "你")
        : t("chat-role-assistant", "PaperMiner"),
    );
    const time = mk(
      doc,
      "span",
      "pm-chat-msg-time",
      formatTime(message.createdAt),
    );
    const copy = mk(doc, "button", "pm-icon-btn pm-chat-copy");
    copy.type = "button";
    copy.title = t("chat-copy", "复制");
    copy.setAttribute("aria-label", t("chat-copy", "复制"));
    copy.dataset.copyId = message.id;
    copy.textContent = t("chat-copy", "复制");
    meta.append(role, time, copy);
    content.appendChild(meta);

    if (message.quote) {
      const quote = mk(doc, "blockquote", "pm-chat-msg-quote");
      quote.textContent = truncate(message.quote, 400);
      quote.title = message.quote;
      content.appendChild(quote);
    }

    const bubble = mk(doc, "div", "pm-chat-bubble");
    if (message.role === "user") {
      const text = mk(doc, "div", "pm-chat-text", message.content);
      bubble.appendChild(text);
    } else {
      const markdown = mk(doc, "div", "pm-chat-markdown");
      if (message.content) markdown.innerHTML = renderMarkdown(message.content);
      bubble.appendChild(markdown);
      if (streaming && !message.content) bubble.appendChild(this.buildTyping());
    }
    content.appendChild(bubble);

    if (message.incomplete) {
      const incomplete = mk(
        doc,
        "div",
        "pm-chat-msg-note",
        t("chat-incomplete", "（回答已中断）"),
      );
      content.appendChild(incomplete);
    }

    article.append(avatar, content);
    this.messagesEl.appendChild(article);
    this.messageNodes.set(message.id, article);
    return article;
  }

  private buildTyping(): HTMLElement {
    const typing = mk(this.doc, "div", "pm-chat-typing");
    for (let i = 0; i < 3; i += 1) {
      typing.appendChild(mk(this.doc, "span", "pm-chat-typing-dot"));
    }
    return typing;
  }

  private updateMessageNode(message: StoredChatMessage): void {
    const article = this.messageNodes.get(message.id);
    if (!article) return;
    const typing = article.querySelector(".pm-chat-typing");
    typing?.remove();
    if (message.role === "assistant") {
      const markdown = article.querySelector<HTMLElement>(".pm-chat-markdown");
      if (markdown) markdown.innerHTML = renderMarkdown(message.content);
    }
    const hasNote = article.querySelector(".pm-chat-msg-note");
    if (message.incomplete && !hasNote) {
      const note = mk(
        this.doc,
        "div",
        "pm-chat-msg-note",
        t("chat-incomplete", "（回答已中断）"),
      );
      article.appendChild(note);
    }
    this.scrollToBottom(false);
  }

  private renderErrorCard(question: string, error: unknown): void {
    const info = this.describeError(error);
    const card = mk(this.doc, "div", "pm-chat-error-card");
    const title = mk(
      this.doc,
      "div",
      "pm-chat-error-title",
      t("chat-error-title", "回复失败"),
    );
    const detail = mk(this.doc, "div", "pm-chat-error-detail", info.message);
    const actions = mk(this.doc, "div", "pm-chat-error-actions");
    const retry = mk(this.doc, "button", "pm-btn pm-chat-retry");
    retry.type = "button";
    retry.textContent = t("chat-retry", "重试");
    retry.setAttribute("data-retry", question);
    actions.appendChild(retry);
    if (info.configHint) {
      const settings = mk(this.doc, "button", "pm-btn pm-chat-error-settings");
      settings.type = "button";
      settings.textContent = t("chat-open-settings", "打开设置");
      settings.setAttribute("data-open-settings", "1");
      actions.appendChild(settings);
    }
    card.append(title, detail, actions);
    this.messagesEl.appendChild(card);
    this.scrollToBottom(true);
  }

  private describeError(error: unknown): LLMErrorInfo {
    if (error instanceof LLMError) {
      switch (error.kind) {
        case "config":
          return { message: error.message, configHint: true };
        case "auth":
          return {
            message: t(
              "chat-error-auth",
              "API Key 无效或没有权限，请检查 PaperMiner 设置。",
            ),
            configHint: true,
          };
        case "rate":
          return {
            message: t(
              "chat-error-rate",
              "请求过于频繁或额度不足，请稍后重试。",
            ),
            configHint: false,
          };
        case "network":
          return {
            message: t(
              "chat-error-network",
              "无法连接模型接口，请检查网络或 API Base URL。",
            ),
            configHint: true,
          };
        case "server":
          return {
            message: t("chat-error-server", "模型服务暂时不可用，请稍后重试。"),
            configHint: false,
          };
        case "parse":
          return {
            message: t("chat-error-parse", "模型返回内容无法解析，请重试。"),
            configHint: false,
          };
        case "abort":
        default:
          return {
            message: t("chat-error-abort", "请求已取消。"),
            configHint: false,
          };
      }
    }
    return {
      message: truncate(errorToString(error), 300),
      configHint: false,
    };
  }

  private updateHeader(): void {
    const title = this.item ? getItemTitle(this.item) : "";
    this.paperSubEl.textContent = title
      ? truncate(title, 42)
      : t("chat-no-paper", "未选择论文");
    this.paperSubEl.title = title;
    const configured = isLLMConfigured("chat");
    const cfg = getLLMConfig("chat");
    if (configured) {
      this.modelBadge.textContent = truncate(cfg.model || "LLM", 22);
      this.modelBadge.title = `${cfg.model} · ${cfg.baseURL}`;
      this.modelBadge.classList.remove("pm-badge-warn");
      this.modelBadge.classList.add("pm-badge-neutral");
    } else {
      this.modelBadge.textContent = t("chat-model-unconfigured", "未配置 AI");
      this.modelBadge.title = getLLMConfigError("chat");
      this.modelBadge.classList.add("pm-badge-warn");
      this.modelBadge.classList.remove("pm-badge-neutral");
    }
    const hasItem = Boolean(this.item);
    this.summaryButton.disabled = !hasItem;
    this.pptButton.disabled = !hasItem;
  }

  private updateComposerState(): void {
    const hasText = Boolean(this.inputEl.value.trim());
    this.sendButton.disabled = this.streaming || !hasText;
    this.stopButton.hidden = !this.streaming;
    this.sendButton.hidden = this.streaming;
    const length = this.inputEl.value.length;
    this.countEl.textContent = length ? `${length} / ${INPUT_MAX_CHARS}` : "";
    this.countEl.classList.toggle(
      "pm-chat-count-over",
      length > INPUT_MAX_CHARS,
    );
  }

  private updateQuoteChip(): void {
    if (!this.quoteEl || !this.quoteTextEl) return;
    const text = this.pendingQuote.trim();
    this.quoteEl.hidden = !text;
    this.quoteTextEl.textContent = text ? truncate(text, 160) : "";
    this.quoteTextEl.title = text;
  }

  private setQuote(text: string): void {
    this.pendingQuote = String(text || "")
      .trim()
      .slice(0, 4000);
    this.updateQuoteChip();
    this.focus();
  }

  private clearQuote(): void {
    this.pendingQuote = "";
    this.updateQuoteChip();
  }

  private autoGrow(): void {
    const input = this.inputEl;
    if (!input) return;
    input.style.height = "auto";
    const height = Math.min(150, Math.max(30, input.scrollHeight || 30));
    input.style.height = `${height}px`;
  }

  private isNearBottom(): boolean {
    const element = this.messagesEl;
    if (!element) return true;
    return element.scrollHeight - element.scrollTop - element.clientHeight < 90;
  }

  private scrollToBottom(force: boolean): void {
    const element = this.messagesEl;
    if (!element) return;
    if (!force && !this.isNearBottom()) return;
    element.scrollTop = element.scrollHeight;
  }

  /* ------------------------------------------------------------------ */
  /* Message interaction                                                 */
  /* ------------------------------------------------------------------ */

  private handleMessagesClick(event: Event): void {
    const target = event.target as Element | null;
    if (!target || !target.closest) return;

    const link = target.closest("a[href]") as HTMLAnchorElement | null;
    if (link) {
      event.preventDefault();
      const href = link.getAttribute("href") || "";
      if (/^https?:/i.test(href)) {
        try {
          Zotero.launchURL(href);
        } catch (error) {
          log("failed to open link:", error);
        }
      }
      return;
    }

    const copy = target.closest(".pm-chat-copy") as HTMLElement | null;
    if (copy) {
      const id = copy.dataset.copyId;
      const message = this.session?.messages.find((item) => item.id === id);
      if (message) copyText(message.content);
      return;
    }

    if (target.closest("[data-open-settings]")) {
      openPreferencesPane();
      return;
    }

    const suggestion = target.closest(
      "[data-suggestion]",
    ) as HTMLElement | null;
    if (suggestion) {
      this.inputEl.value = suggestion.dataset.suggestion || "";
      this.autoGrow();
      this.updateComposerState();
      this.focus();
      return;
    }

    const retry = target.closest("[data-retry]") as HTMLElement | null;
    if (retry) {
      const question = retry.getAttribute("data-retry") || this.lastQuestion;
      const card = retry.closest(".pm-chat-error-card");
      card?.remove();
      if (question) void this.runAssistant(question);
    }
  }

  /* ------------------------------------------------------------------ */
  /* AI side actions                                                     */
  /* ------------------------------------------------------------------ */

  private async summarize(): Promise<void> {
    const item = this.item;
    if (!item || this.busy) return;
    this.busy = true;
    this.summaryButton.disabled = true;
    const progress = showProgress(
      t("chat-summary-title", "AI 摘要"),
      t("chat-summary-working", "正在生成摘要…"),
      5,
    );
    try {
      const result = await generateSummary(item, {
        onProgress: (message: string, value?: number) =>
          progress.update(message, value),
      });
      progress.close(1200);
      toast(
        result.cached
          ? t("chat-summary-cached", "已打开已有摘要")
          : t("chat-summary-done", "摘要已生成并保存为笔记"),
        "success",
      );
      try {
        openSummaryNote(item);
      } catch (error) {
        log("openSummaryNote failed:", error);
      }
    } catch (error) {
      progress.close(0);
      toast(
        tWith("chat-summary-failed", "摘要生成失败：{message}", {
          message: this.describeError(error).message,
        }),
        "fail",
      );
    } finally {
      this.busy = false;
      this.summaryButton.disabled = !this.item;
    }
  }

  private async makePpt(): Promise<void> {
    const item = this.item;
    if (!item || this.busy) return;
    this.busy = true;
    this.pptButton.disabled = true;
    const progress = showProgress(
      t("chat-ppt-title", "生成 PPT"),
      t("chat-ppt-working", "正在生成幻灯片…"),
      5,
    );
    try {
      const result = await generatePpt(item, {
        onProgress: (message: string, value?: number) =>
          progress.update(message, value),
      });
      progress.close(1200);
      toast(
        tWith("chat-ppt-done", "PPT 已生成：{file}", {
          file: result?.filePath || "",
        }),
        "success",
      );
    } catch (error) {
      progress.close(0);
      toast(
        tWith("chat-ppt-failed", "PPT 生成失败：{message}", {
          message: this.describeError(error).message,
        }),
        "fail",
      );
    } finally {
      this.busy = false;
      this.pptButton.disabled = !this.item;
    }
  }

  /** Markdown export of the current conversation (used by Lead / API). */
  exportMarkdown(): string {
    const session = this.session;
    if (!session) return "";
    return exportSessionMarkdown(session, { now: Date.now() });
  }

  /** Copy the whole conversation to the clipboard. */
  copyConversation(): void {
    const markdown = this.exportMarkdown();
    if (!markdown) {
      toast(t("chat-empty-conversation", "当前还没有对话"), "default");
      return;
    }
    copyText(markdown);
  }
}
