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
  dialog.setAttribute("aria-label", t("citation-title", "谷歌他引"));

  const header = el(doc, "header", "pm-citation-dialog-head");
  const heading = el(doc, "div", "pm-citation-dialog-heading");
  const title = el(
    doc,
    "h2",
    "pm-citation-dialog-title",
    t("citation-title", "谷歌他引"),
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
        : "";
    subtitle.textContent = sourceNote ? `${count} · ${sourceNote}` : count;
    options.onSummary?.(summary);
    if (summary.status === "ok") {
      sourceButton.hidden = false;
      sourceButton.textContent =
        summary.source === "openalex"
          ? t("citation-open-openalex", "在 OpenAlex 查看全部")
          : t("citation-open-scholar", "在 Google Scholar 查看全部");
      sourceButton.dataset.url =
        summary.publicUrl || summary.citesUrl || summary.sourceUrl;
    }
  };

  const renderDetails = (details: CitationDetails) => {
    renderSummary(details);
    body.replaceChildren();
    if (details.status !== "ok") {
      const error = el(
        doc,
        "div",
        "pm-citation-empty pm-citation-error",
        details.error || t("citation-error", "获取引用失败"),
      );
      body.appendChild(error);
      if (details.sourceUrl) {
        const retry = el(
          doc,
          "button",
          "pm-citation-retry",
          t("citation-retry", "重试"),
        );
        retry.type = "button";
        retry.addEventListener("click", () => void load(true));
        body.appendChild(retry);
      }
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

  const load = async (force = false) => {
    renderLoading();
    try {
      const details = await getCitationDetails(item, { force });
      if (disposed) return;
      renderDetails(details);
    } catch (error) {
      if (disposed) return;
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
