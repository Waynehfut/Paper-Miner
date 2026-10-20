/**
 * DOM helpers for the journal / retraction UI.
 *
 * Items are created with the XHTML namespace on purpose: the Zotero main
 * window document is a XUL document, where `document.createElement("div")`
 * produces elements that are not real HTML elements (and therefore ignore
 * most layout/button semantics). The reader iframe is an HTML document, but
 * `createElementNS(HTML_NS, ...)` works for both.
 */

import type { ElementChild, ElementProps } from "../../utils/html";
import { createZoteroIcon } from "../../utils/icons";

export const HTML_NS = "http://www.w3.org/1999/xhtml";

export function htmlEl<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  props: ElementProps = {},
  ...children: ElementChild[]
): HTMLElementTagNameMap[K] {
  const node = doc.createElementNS(HTML_NS, tag) as HTMLElementTagNameMap[K];
  const element = node as unknown as HTMLElement;
  if (props.class) element.className = props.class;
  if (props.id) element.id = props.id;
  if (props.text !== undefined) element.textContent = props.text;
  if (props.title) element.title = props.title;
  if (props.type) element.setAttribute("type", props.type);
  if (props.placeholder) element.setAttribute("placeholder", props.placeholder);
  if (props.href) element.setAttribute("href", props.href);
  if (props.src) element.setAttribute("src", props.src);
  if (props.alt) element.setAttribute("alt", props.alt);
  if (props.disabled !== undefined) {
    (element as HTMLButtonElement).disabled = props.disabled;
  }
  if (props.value !== undefined) {
    (element as HTMLInputElement).value = props.value;
  }
  if (props.checked !== undefined) {
    (element as HTMLInputElement).checked = props.checked;
  }
  if (props.style) Object.assign(element.style, props.style);
  for (const [key, value] of Object.entries(props.attrs || {})) {
    if (value === undefined || value === null) continue;
    element.setAttribute(key, String(value));
  }
  for (const [key, value] of Object.entries(props.dataset || {})) {
    element.dataset[key] = value;
  }
  for (const [key, handler] of Object.entries(props.on || {})) {
    element.addEventListener(key, handler);
  }
  appendChildren(element, children);
  return node;
}

export function appendChildren(parent: Node, children: ElementChild[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (typeof child === "string") {
      parent.appendChild(
        (parent.ownerDocument || (parent as Document)).createTextNode(child),
      );
    } else {
      parent.appendChild(child);
    }
  }
}

/** Zotero-style monochrome icon element for a built-in icon. */
export function zoteroIconImg(
  doc: Document,
  name: string,
  className = "",
): HTMLElement {
  return createZoteroIcon(doc, name, { className });
}

/** PaperMiner brand icon (`chrome://paperminer/content/icons/...`). */
export function pluginIconImg(
  doc: Document,
  name = "paperminer",
  className = "pm-plugin-icon",
): HTMLElement {
  const icon = htmlEl(doc, "span", {
    class: className,
    attrs: { "aria-hidden": "true" },
  });
  icon.style.backgroundImage = `url("chrome://paperminer/content/icons/${name}.svg")`;
  return icon;
}

export interface IconButtonOptions {
  title: string;
  className?: string;
  disabled?: boolean;
  onClick: (event: Event) => void;
}

/** Small icon-only `<button>` used in section headers. */
export function iconButton(
  doc: Document,
  iconName: string,
  options: IconButtonOptions,
): HTMLButtonElement {
  const button = htmlEl(doc, "button", {
    class: `pm-icon-btn ${options.className || ""}`.trim(),
    title: options.title,
    attrs: { type: "button", "aria-label": options.title },
    disabled: options.disabled,
    on: {
      click: (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
        options.onClick(event);
      },
    },
  });
  button.appendChild(zoteroIconImg(doc, iconName));
  return button;
}

/** Loading row with the shared spinner. */
export function loadingRow(doc: Document, text: string): HTMLElement {
  const row = htmlEl(doc, "div", { class: "pm-row pm-journal-status" });
  row.appendChild(htmlEl(doc, "span", { class: "pm-spinner" }));
  row.appendChild(htmlEl(doc, "span", { class: "pm-muted", text }));
  return row;
}

/** Muted informational text (with optional clickable action). */
export function statusText(
  doc: Document,
  text: string,
  options: {
    tone?: "muted" | "warn" | "danger";
    actionLabel?: string;
    onAction?: () => void;
  } = {},
): HTMLElement {
  const row = htmlEl(doc, "div", {
    class:
      options.tone === "warn"
        ? "pm-journal-note pm-journal-note-warn"
        : options.tone === "danger"
          ? "pm-journal-note pm-journal-note-danger"
          : "pm-journal-note pm-muted",
  });
  row.appendChild(htmlEl(doc, "span", { text }));
  if (options.actionLabel && options.onAction) {
    const link = htmlEl(doc, "button", {
      class: "pm-link pm-journal-link-btn",
      text: options.actionLabel,
      attrs: { type: "button" },
      on: {
        click: (event: Event) => {
          event.preventDefault();
          event.stopPropagation();
          options.onAction?.();
        },
      },
    });
    row.appendChild(htmlEl(doc, "span", { text: " " }));
    row.appendChild(link);
  }
  return row;
}
