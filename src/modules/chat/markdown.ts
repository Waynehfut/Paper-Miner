/**
 * Markdown rendering for chat messages and translations.
 *
 * `html: false` keeps model output from injecting markup into the Zotero
 * window; links are opened through Zotero's launcher by the panel.
 */

import MarkdownIt from "markdown-it";

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: false,
});

md.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
  const token = tokens[idx];
  token.attrSet("target", "_blank");
  token.attrSet("rel", "noopener noreferrer");
  return self.renderToken(tokens, idx, options);
};

/** Render a full Markdown block to HTML. Never throws. */
export function renderMarkdown(text: string): string {
  const source = String(text || "");
  if (!source.trim()) return "";
  try {
    return md.render(source);
  } catch {
    return `<pre class="pm-chat-code-fallback">${escapeHtml(source)}</pre>`;
  }
}

/** Render a single line of Markdown without the wrapping paragraph. */
export function renderInlineMarkdown(text: string): string {
  try {
    return md.renderInline(String(text || ""));
  } catch {
    return escapeHtml(String(text || ""));
  }
}

export function escapeHtml(text: string): string {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
