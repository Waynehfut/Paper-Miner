/** Small DOM helpers shared by the UI modules. */

export interface ElementProps {
  class?: string;
  id?: string;
  text?: string;
  title?: string;
  type?: string;
  value?: string;
  placeholder?: string;
  href?: string;
  src?: string;
  alt?: string;
  disabled?: boolean;
  checked?: boolean;
  style?: Partial<CSSStyleDeclaration>;
  attrs?: Record<string, string | number | boolean | null | undefined>;
  dataset?: Record<string, string>;
  on?: Record<string, (event: Event) => void>;
}

export type ElementChild = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  props: ElementProps = {},
  ...children: ElementChild[]
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.id) node.id = props.id;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.title) node.title = props.title;
  if (props.type) node.setAttribute("type", props.type);
  if (props.placeholder) node.setAttribute("placeholder", props.placeholder);
  if (props.href) node.setAttribute("href", props.href);
  if (props.src) node.setAttribute("src", props.src);
  if (props.alt) node.setAttribute("alt", props.alt);
  if (props.disabled !== undefined)
    (node as HTMLButtonElement).disabled = props.disabled;
  if (props.value !== undefined) (node as HTMLInputElement).value = props.value;
  if (props.checked !== undefined)
    (node as HTMLInputElement).checked = props.checked;
  if (props.style) Object.assign(node.style, props.style);
  for (const [key, value] of Object.entries(props.attrs || {})) {
    if (value === undefined || value === null) continue;
    node.setAttribute(key, String(value));
  }
  for (const [key, value] of Object.entries(props.dataset || {})) {
    node.dataset[key] = value;
  }
  for (const [key, handler] of Object.entries(props.on || {})) {
    node.addEventListener(key, handler);
  }
  appendChildren(node, children);
  return node;
}

export function appendChildren(parent: Node, children: ElementChild[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (typeof child === "string") {
      const doc = parent.ownerDocument || Zotero.getMainWindow().document;
      parent.appendChild(doc.createTextNode(child));
    } else {
      parent.appendChild(child);
    }
  }
}

export function clearChildren(node: Element | null | undefined): void {
  if (!node) return;
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function escapeHtml(text: string): string {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function debounce<T extends (...args: any[]) => void>(
  fn: T,
  wait = 300,
): T & { cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const debounced = ((...args: Parameters<T>) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  }) as T & { cancel: () => void };
  debounced.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return debounced;
}
