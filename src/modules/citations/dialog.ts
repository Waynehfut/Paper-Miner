/**
 * Resizable citation dialog opened from the item pane.
 *
 * Google Scholar result pages are parsed by citations/service.ts; this module
 * only handles presentation, refresh, and opening citing works.
 */

import { t } from "../../utils/i18n";
import { log } from "../../utils/log";
import {
  getCitationDetails,
  type CitationDetails,
  type CitationSummary,
} from "./service";

export interface CitationDialogOptions {
  onSummary?: (summary: CitationSummary) => void;
}

let activeDialog: (() => void) | null = null;

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className = "",
  text = "",
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag) as HTMLElementTagNameMap[K];
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function openURL(url: string): void {
  try {
    Zotero.launchURL(url);
  } catch (error) {
    log("open citation URL failed:", error);
  }
}

function formatCount(count: number): string {
  return count > 0
    ? t("citation-count", "共 { count } 篇引用", { count })
    : t("citation-empty", "暂未找到引用记录");
}

export function openCitationDialog(
  item: Zotero.Item,
  options: CitationDialogOptions = {},
): void {
  const win = Zotero.getMainWindow();
  const doc = win?.document;
  if (!doc) return;
  // Keep one dialog at a time.
  activeDialog?.();
  const existing = doc.getElementById("pm-citation-dialog-overlay");
  existing?.remove();

  const overlay = el(doc, "div", "pm-citation-overlay");
  overlay.id = "pm-citation-dialog-overlay";
  const dialog = el(doc, "section", "pm-citation-dialog");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", t("citation-title", "他引"));

  const header = el(doc, "header", "pm-citation-dialog-head");
  const heading = el(doc, "div", "pm-citation-dialog-heading");
  const title = el(
    doc,
    "h2",
    "pm-citation-dialog-title",
    t("citation-title", "他引"),
  );
  const subtitle = el(
    doc,
    "p",
    "pm-citation-dialog-subtitle",
    t("citation-loading", "正在从 Google Scholar 获取引用…"),
  );
  heading.append(title, subtitle);
  const close = el(doc, "button", "pm-citation-close", "×");
  close.type = "button";
  close.title = t("chat-close", "关闭");
  close.setAttribute("aria-label", t("chat-close", "关闭"));
  header.append(heading, close);

  const body = el(doc, "div", "pm-citation-dialog-body");
  const footer = el(doc, "footer", "pm-citation-dialog-footer");
  const sourceButton = el(
    doc,
    "button",
    "pm-citation-footer-btn",
    t("citation-open-scholar", "在 Google Scholar 查看全部"),
  );
  sourceButton.type = "button";
  sourceButton.hidden = true;
  const refresh = el(
    doc,
    "button",
    "pm-citation-footer-btn",
    t("citation-refresh", "刷新"),
  );
  refresh.type = "button";
  footer.append(sourceButton, refresh);
  dialog.append(header, body, footer);
  overlay.appendChild(dialog);
  (doc.documentElement || doc.body)?.appendChild(overlay);

  let disposed = false;
  const closeDialog = () => {
    if (disposed) return;
    disposed = true;
    doc.removeEventListener("keydown", onKeyDown, true);
    overlay.remove();
    if (activeDialog === closeDialog) activeDialog = null;
  };
  activeDialog = closeDialog;
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeDialog();
    }
  };
  doc.addEventListener("keydown", onKeyDown, true);

  close.addEventListener("click", closeDialog);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) closeDialog();
  });

  const renderLoading = () => {
    body.replaceChildren(
      el(
        doc,
        "div",
        "pm-citation-loading",
        t("citation-loading", "正在从 Google Scholar 获取引用…"),
      ),
    );
    sourceButton.hidden = true;
  };

  const renderSummary = (summary: CitationSummary) => {
    const count =
      summary.status === "ok"
        ? formatCount(summary.count)
        : summary.error || t("citation-error", "获取引用失败");
    const sourceNote =
      summary.status === "ok" && summary.source === "openalex"
        ? t("citation-source-openalex", "OpenAlex（Google Scholar 暂时不可用）")
        : summary.status === "ok" && summary.source === "opencitations"
          ? t(
              "citation-source-opencitations",
              "OpenCitations（Google Scholar / OpenAlex 暂时不可用）",
            )
          : "";
    subtitle.textContent = sourceNote ? `${count} · ${sourceNote}` : count;
    options.onSummary?.(summary);
    if (summary.status === "ok") {
      sourceButton.hidden = false;
      sourceButton.textContent =
        summary.source === "openalex"
          ? t("citation-open-openalex", "在 OpenAlex 查看全部")
          : summary.source === "opencitations"
            ? t("citation-open-opencitations", "在 OpenCitations 查看")
            : t("citation-open-scholar", "在 Google Scholar 查看全部");
      sourceButton.dataset.url =
        summary.publicUrl || summary.citesUrl || summary.sourceUrl;
    } else if (summary.sourceUrl) {
      // Even when both data sources are rate-limited, keep a way out to the
      // Scholar search page instead of leaving the dialog with no action.
      sourceButton.hidden = false;
      sourceButton.textContent = t(
        "citation-open-scholar-search",
        "在 Google Scholar 搜索",
      );
      sourceButton.dataset.url = summary.sourceUrl;
    }
  };

  const renderDetails = (details: CitationDetails) => {
    renderSummary(details);
    body.replaceChildren();
    if (details.status !== "ok" || details.error) {
      const message =
        details.status === "ok" && details.error
          ? `${t("citation-list-unavailable", "引用列表暂时无法加载")}：${details.error}`
          : details.error || t("citation-error", "获取引用失败");
      const error = el(
        doc,
        "div",
        "pm-citation-empty pm-citation-error",
        message,
      );
      body.appendChild(error);
      const retry = el(
        doc,
        "button",
        "pm-citation-retry",
        t("citation-retry", "重试"),
      );
      retry.type = "button";
      retry.addEventListener("click", () => void load(true));
      body.appendChild(retry);
      return;
    }
    if (!details.items.length) {
      body.appendChild(
        el(
          doc,
          "div",
          "pm-citation-empty",
          t("citation-empty", "暂未找到引用记录"),
        ),
      );
      return;
    }
    const list = el(doc, "div", "pm-citation-list");
    details.items.forEach((entry, index) => {
      const row = el(doc, "button", "pm-citation-item");
      row.type = "button";
      row.title = t("citation-open-item", "打开论文页");
      const number = el(
        doc,
        "span",
        "pm-citation-item-index",
        String(index + 1),
      );
      const content = el(doc, "span", "pm-citation-item-content");
      const name = el(doc, "span", "pm-citation-item-title", entry.title);
      const meta = el(doc, "span", "pm-citation-item-meta", entry.meta);
      content.append(name, ...(meta.textContent ? [meta] : []));
      const arrow = el(doc, "span", "pm-citation-item-arrow", "↗");
      row.append(number, content, arrow);
      row.addEventListener("click", () => openURL(entry.url));
      list.appendChild(row);
    });
    body.appendChild(list);
    if (details.partial || details.count > details.items.length) {
      body.appendChild(
        el(
          doc,
          "p",
          "pm-citation-partial",
          t(
            "citation-partial",
            "显示前 { shown } 篇，共 { total } 篇；可在 Google Scholar 查看全部。",
            {
              shown: details.items.length,
              total: details.count,
            },
          ),
        ),
      );
    }
  };

  let loadSequence = 0;
  const load = async (force = false) => {
    const sequence = ++loadSequence;
    renderLoading();
    const timeout = setTimeout(() => {
      if (disposed || sequence !== loadSequence) return;
      renderDetails({
        status: "error",
        count: 0,
        clusterId: "",
        citesUrl: "",
        title: "",
        sourceUrl: "",
        source: "google",
        fetchedAt: Date.now(),
        error: t(
          "citation-timeout",
          "获取引用超时。Google Scholar 可能正在限流，请稍后重试。",
        ),
        items: [],
      });
    }, 45_000);
    try {
      const details = await getCitationDetails(item, { force });
      if (disposed || sequence !== loadSequence) return;
      renderDetails(details);
    } catch (error) {
      if (disposed || sequence !== loadSequence) return;
      renderDetails({
        status: "error",
        count: 0,
        clusterId: "",
        citesUrl: "",
        title: "",
        sourceUrl: "",
        source: "google",
        fetchedAt: Date.now(),
        error: String((error as Error)?.message || error),
        items: [],
      });
    } finally {
      clearTimeout(timeout);
    }
  };

  sourceButton.addEventListener("click", () => {
    const url = sourceButton.dataset.url;
    if (url) openURL(url);
  });
  refresh.addEventListener("click", () => void load(true));
  close.focus();
  void load(false);
}
