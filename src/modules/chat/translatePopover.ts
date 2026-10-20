/**
 * Floating selection-translation popover.
 *
 * Rendered inside the PDF reader document (the selection lives there), styled
 * by `chat.css` which the reader entry points inject. Positioned with fixed
 * coordinates and clamped to the viewport, with the highest possible z-index so
 * it always sits above the PDF canvas.
 */

import { createAbortController } from "../../utils/abort";
import { t } from "../../utils/i18n";
import { errorToString, log } from "../../utils/log";
import { getPref } from "../../utils/prefs";
import { injectStylesIntoDocument } from "../../utils/styles";
import {
  getTranslateErrorMessage,
  isTranslationConfigured,
  translateText,
} from "../ai/translate";
import { openPreferencesPane } from "./preferences";
import { computePopoverPosition, movePoint, type AnchorRect } from "./position";

export interface TranslatePopoverOptions {
  doc: Document;
  text: string;
  anchor: AnchorRect;
  /** Paper title/abstract hint used to disambiguate terminology. */
  context?: string;
  /** Called by the "问 AI" action; the popover closes itself afterwards. */
  onAskAI?: () => void;
  /** Called exactly once when the popover is disposed. */
  onClose?: () => void;
}

interface LanguageOption {
  value: string;
  label: string;
}

export function getTranslateLanguageOptions(): LanguageOption[] {
  return [
    { value: "auto", label: t("chat-translate-lang-auto", "自动") },
    { value: "zh-CN", label: t("chat-translate-lang-zh", "中文") },
    { value: "en", label: t("chat-translate-lang-en", "English") },
    { value: "ja", label: t("chat-translate-lang-ja", "日本語") },
    { value: "de", label: t("chat-translate-lang-de", "Deutsch") },
    { value: "fr", label: t("chat-translate-lang-fr", "Français") },
    { value: "es", label: t("chat-translate-lang-es", "Español") },
    { value: "ru", label: t("chat-translate-lang-ru", "Русский") },
  ];
}

/** Fill `{name}` placeholders in fallback strings (Fluent uses `{ $name }`). */
function fillPlaceholders(
  text: string,
  values: Record<string, string | number>,
): string {
  return text.replace(/\{\s*\$?([a-zA-Z0-9_]+)\s*\}/g, (match, name) =>
    values[name] === undefined ? match : String(values[name]),
  );
}

let activePopover: { doc: Document; close: () => void } | null = null;

/** Close any open translation popover (safe to call when none is open). */
export function closeTranslatePopover(): void {
  const active = activePopover;
  activePopover = null;
  active?.close();
}

/**
 * Open the translation popover. Returns a disposer; calling it twice is safe.
 */
export function openTranslatePopover(
  options: TranslatePopoverOptions,
): () => void {
  const doc = options.doc;
  if (!doc || !doc.body) {
    options.onClose?.();
    return () => {};
  }
  // One popover at a time per reader document.
  if (activePopover) {
    const previous = activePopover;
    activePopover = null;
    if (previous.doc === doc) previous.close();
  }
  void injectStylesIntoDocument(doc);

  const win = doc.defaultView;
  const sourceText = String(options.text || "").trim();
  if (!win || !sourceText) {
    options.onClose?.();
    return () => {};
  }

  const controller = createAbortController();
  let disposed = false;
  let manualPosition: { left: number; top: number } | null = null;
  let renderTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingText = "";
  let translateSeq = 0;
  let language =
    String(getPref("translateTarget") || "").trim() ||
    getTranslateLanguageOptions()[0].value;

  /* ---------------- DOM ---------------- */
  const root = doc.createElement("section");
  root.className = "pm-root pm-translate-popover";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", t("chat-translate-title", "翻译"));

  const header = doc.createElement("header");
  header.className = "pm-translate-header";

  const title = doc.createElement("span");
  title.className = "pm-translate-title";
  title.textContent = t("chat-translate-title", "翻译");
  title.title = t("chat-translate-drag-hint", "拖动可移动");

  const select = doc.createElement("select");
  select.className = "pm-select pm-translate-lang";
  select.setAttribute("aria-label", t("chat-translate-lang", "目标语言"));
  for (const item of getTranslateLanguageOptions()) {
    const option = doc.createElement("option");
    option.value = item.value;
    option.textContent = item.label;
    select.appendChild(option);
  }
  if (!getTranslateLanguageOptions().some((item) => item.value === language)) {
    language = "auto";
  }
  select.value = language;

  const closeButton = doc.createElement("button");
  closeButton.type = "button";
  closeButton.className = "pm-icon-btn pm-translate-close";
  closeButton.textContent = "×";
  closeButton.title = t("chat-close", "关闭");
  closeButton.setAttribute("aria-label", t("chat-close", "关闭"));

  header.append(title, select, closeButton);

  const body = doc.createElement("div");
  body.className = "pm-translate-body";
  const output = doc.createElement("div");
  output.className = "pm-translate-text";
  output.textContent = sourceText;
  const loading = doc.createElement("div");
  loading.className = "pm-translate-loading";
  const spinner = doc.createElement("span");
  spinner.className = "pm-spinner";
  const loadingText = doc.createElement("span");
  loadingText.textContent = t("chat-translate-loading", "翻译中…");
  loading.append(spinner, loadingText);
  body.append(output, loading);

  const footer = doc.createElement("footer");
  footer.className = "pm-translate-footer";
  const status = doc.createElement("span");
  status.className = "pm-translate-status";
  const copyButton = doc.createElement("button");
  copyButton.type = "button";
  copyButton.className = "pm-btn pm-btn-ghost pm-translate-copy";
  copyButton.textContent = t("chat-copy", "复制");
  const settingsButton = doc.createElement("button");
  settingsButton.type = "button";
  settingsButton.className = "pm-btn pm-btn-ghost pm-translate-settings";
  settingsButton.textContent = t("chat-open-settings", "打开设置");
  settingsButton.hidden = true;
  const askButton = doc.createElement("button");
  askButton.type = "button";
  askButton.className = "pm-btn pm-btn-ghost pm-translate-ask";
  askButton.textContent = t("chat-ask-ai", "问 AI");
  askButton.hidden = !options.onAskAI;
  footer.append(status, copyButton, settingsButton, askButton);

  root.append(header, body, footer);
  doc.body.appendChild(root);

  /* ---------------- Positioning ---------------- */
  const place = () => {
    const rect = root.getBoundingClientRect();
    const documentElement = doc.documentElement;
    const viewport = {
      width: win.innerWidth || documentElement?.clientWidth || 0,
      height: win.innerHeight || documentElement?.clientHeight || 0,
    };
    const position = computePopoverPosition(
      options.anchor,
      { width: rect.width, height: rect.height },
      viewport,
      { preferred: manualPosition || undefined },
    );
    root.style.left = `${position.left}px`;
    root.style.top = `${position.top}px`;
  };
  place();

  /* ---------------- Translation ---------------- */
  const flushPending = () => {
    renderTimer = null;
    if (disposed) return;
    if (pendingText) {
      output.textContent = pendingText;
      body.scrollTop = body.scrollHeight;
    }
  };
  const scheduleFlush = () => {
    if (renderTimer) return;
    renderTimer = setTimeout(flushPending, 60);
  };

  const showError = (message: string) => {
    output.textContent = message;
    output.classList.add("pm-translate-error");
    loading.hidden = true;
    status.textContent = "";
    settingsButton.hidden = !/设置|API|Key|引擎/i.test(message);
    root.setAttribute("aria-busy", "false");
  };

  const runTranslation = async () => {
    const seq = ++translateSeq;
    pendingText = "";
    output.classList.remove("pm-translate-error");
    output.textContent = "";
    loading.hidden = false;
    status.textContent = "";
    settingsButton.hidden = true;
    root.setAttribute("aria-busy", "true");

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
      const result = await translateText(sourceText, {
        signal: controller.signal,
        targetLang: language,
        context: options.context,
        onDelta: (delta) => {
          if (seq !== translateSeq || disposed) return;
          pendingText += delta;
          scheduleFlush();
        },
      });
      if (seq !== translateSeq || disposed) return;
      pendingText = String(result || pendingText || "");
      flushPending();
      loading.hidden = true;
      root.setAttribute("aria-busy", "false");
      if (!output.textContent?.trim()) {
        showError(t("chat-translate-empty", "没有获取到译文，请重试。"));
      }
    } catch (error) {
      if (seq !== translateSeq || disposed) return;
      if ((error as { name?: string })?.name === "AbortError") {
        loading.hidden = true;
        return;
      }
      log("translate failed:", errorToString(error));
      const message = getTranslateErrorMessage(error);
      showError(
        fillPlaceholders(
          t("chat-translate-failed", "翻译失败：{message}", { message }),
          { message },
        ),
      );
    }
  };

  /* ---------------- Events ---------------- */
  const cleanupFns: Array<() => void> = [];
  type Listener = (event: Event) => void;
  const listen = (
    target: EventTarget,
    type: string,
    handler: Listener,
    capture = false,
  ) => {
    const options: AddEventListenerOptions = { capture };
    (target.addEventListener as any)(type, handler, options);
    cleanupFns.push(() =>
      (target.removeEventListener as any)(type, handler, options),
    );
  };
  const listenTemporary = (
    target: EventTarget,
    type: string,
    handler: Listener,
    capture = true,
  ): (() => void) => {
    (target.addEventListener as any)(type, handler, { capture });
    const remove = () =>
      (target.removeEventListener as any)(type, handler, { capture });
    cleanupFns.push(remove);
    return remove;
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    translateSeq += 1;
    controller.abort();
    if (renderTimer) {
      clearTimeout(renderTimer);
      renderTimer = null;
    }
    for (const cleanup of cleanupFns) {
      try {
        cleanup();
      } catch {
        // ignore
      }
    }
    root.remove();
    if (activePopover?.close === dispose) activePopover = null;
    options.onClose?.();
  };

  listen(closeButton, "click", () => dispose());
  listen(copyButton, "click", () => {
    try {
      Zotero.Utilities.Internal.copyTextToClipboard(output.textContent || "");
      status.textContent = t("chat-copied", "已复制");
      setTimeout(() => {
        if (!disposed) status.textContent = "";
      }, 1500);
    } catch (error) {
      log("copy translation failed:", error);
    }
  });
  listen(settingsButton, "click", () => {
    openPreferencesPane();
    dispose();
  });
  listen(askButton, "click", () => {
    const ask = options.onAskAI;
    dispose();
    ask?.();
  });
  listen(select, "change", () => {
    language = select.value || "auto";
    void runTranslation();
  });

  // Esc closes; pointerdown outside closes (deferred so the opening click does
  // not immediately dismiss the panel).
  listen(doc, "keydown", (event) => {
    if ((event as KeyboardEvent).key === "Escape") {
      event.preventDefault();
      dispose();
    }
  });
  const onPointerDown: Listener = (event) => {
    const target = event.target as Node | null;
    if (target && root.contains(target)) return;
    dispose();
  };
  setTimeout(() => {
    if (disposed) return;
    listen(doc, "pointerdown", onPointerDown, true);
  }, 0);

  // Dragging by the header, clamped to the viewport.
  let dragStart:
    | { x: number; y: number; left: number; top: number }
    | undefined;
  let removeDragListeners: (() => void) | null = null;
  const onPointerMove: Listener = (event) => {
    if (!dragStart) return;
    const pointer = event as PointerEvent;
    const rect = root.getBoundingClientRect();
    manualPosition = movePoint(
      { left: dragStart.left, top: dragStart.top },
      {
        dx: pointer.clientX - dragStart.x,
        dy: pointer.clientY - dragStart.y,
      },
      { width: rect.width, height: rect.height },
      { width: win.innerWidth, height: win.innerHeight },
    );
    place();
  };
  const onPointerUp: Listener = () => {
    dragStart = undefined;
    removeDragListeners?.();
    removeDragListeners = null;
  };
  listen(header, "pointerdown", (event) => {
    const pointer = event as PointerEvent;
    if ((pointer.target as Element)?.closest("select,button")) return;
    pointer.preventDefault();
    const rect = root.getBoundingClientRect();
    dragStart = {
      x: pointer.clientX,
      y: pointer.clientY,
      left: rect.left,
      top: rect.top,
    };
    removeDragListeners?.();
    const removeMove = listenTemporary(win, "pointermove", onPointerMove);
    const removeUp = listenTemporary(win, "pointerup", onPointerUp);
    removeDragListeners = () => {
      removeMove();
      removeUp();
    };
  });

  listen(win, "resize", () => place());

  activePopover = { doc, close: dispose };
  void runTranslation();
  return dispose;
}
