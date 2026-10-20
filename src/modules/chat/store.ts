/**
 * Persistent chat session storage.
 *
 * Sessions are kept in memory while Zotero runs and mirrored into the shared
 * plugin cache (`pluginCache`, namespace `chat`) so they survive restarts when
 * the `chatPersist` preference is enabled. All normalisation helpers are pure
 * and unit-tested.
 */

import { pluginCache } from "../../utils/cache";
import { getItemTitle } from "../../utils/item";
import { log } from "../../utils/log";
import { getPref } from "../../utils/prefs";
import type { ChatRole, ChatSession, StoredChatMessage } from "./session";

export const CHAT_NAMESPACE = "chat";
export const MAX_STORED_MESSAGES = 200;
export const MAX_MESSAGE_CHARS = 20000;
export const MAX_QUOTE_CHARS = 4000;

/** Runtime mirror so a session can be shared across tabs without disk I/O. */
const memorySessions = new Map<string, ChatSession>();

export function sessionCacheKey(itemKey: string): string {
  const key = String(itemKey || "").trim();
  return key ? `session:${key}` : "session:";
}

export function isChatPersistEnabled(): boolean {
  try {
    return getPref("chatPersist") !== false;
  } catch {
    return true;
  }
}

function isChatRole(value: unknown): value is ChatRole {
  return value === "user" || value === "assistant";
}

function clampText(value: unknown, maxChars: number): string {
  const text = typeof value === "string" ? value : "";
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

/** Drop malformed messages and clamp oversized content. */
export function sanitizeMessage(
  raw: unknown,
  options: { maxChars?: number; maxQuoteChars?: number; now?: number } = {},
): StoredChatMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Partial<StoredChatMessage>;
  if (!isChatRole(source.role)) return null;
  const content = clampText(
    source.content,
    options.maxChars ?? MAX_MESSAGE_CHARS,
  ).trim();
  if (!content) return null;
  const quote = clampText(
    source.quote,
    options.maxQuoteChars ?? MAX_QUOTE_CHARS,
  ).trim();
  const createdAt = Number(source.createdAt);
  const message: StoredChatMessage = {
    id:
      typeof source.id === "string" && source.id
        ? source.id
        : createMessageId(options.now),
    role: source.role,
    content,
    createdAt:
      Number.isFinite(createdAt) && createdAt > 0 ? createdAt : Date.now(),
  };
  if (quote) message.quote = quote;
  if (source.incomplete) message.incomplete = true;
  return message;
}

/** Keep at most `max` messages (the newest ones) and clamp each one. */
export function trimMessages(
  messages: readonly unknown[],
  max: number = MAX_STORED_MESSAGES,
  options: { maxChars?: number; now?: number } = {},
): StoredChatMessage[] {
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : 0;
  const cleaned: StoredChatMessage[] = [];
  for (const raw of messages || []) {
    const message = sanitizeMessage(raw, options);
    if (message) cleaned.push(message);
  }
  return limit > 0 ? cleaned.slice(-limit) : cleaned;
}

let messageSeq = 0;

export function createMessageId(
  now = Date.now(),
  random = Math.random,
): string {
  messageSeq = (messageSeq + 1) % 100000;
  const suffix = Math.floor(random() * 100000)
    .toString(36)
    .padStart(4, "0");
  return `m${now.toString(36)}-${messageSeq.toString(36)}-${suffix}`;
}

/** Validate an unknown cache payload as a chat session. */
export function normalizeSession(
  raw: unknown,
  itemKey: string,
  options: { max?: number } = {},
): ChatSession | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Partial<ChatSession>;
  const messages = trimMessages(source.messages || [], options.max);
  const createdAt = Number(source.createdAt);
  const updatedAt = Number(source.updatedAt);
  return {
    itemKey: String(source.itemKey || itemKey || ""),
    itemID: Number(source.itemID) || 0,
    title: String(source.title || ""),
    messages,
    createdAt:
      Number.isFinite(createdAt) && createdAt > 0 ? createdAt : Date.now(),
    updatedAt:
      Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : Date.now(),
  };
}

/** Build (or refresh) a session object for an item. Pure: pass `now` in tests. */
export function buildSession(
  item: Zotero.Item,
  messages: readonly StoredChatMessage[],
  options: { now?: number; previous?: ChatSession | null; title?: string } = {},
): ChatSession {
  const now = options.now ?? Date.now();
  const previous = options.previous;
  return {
    itemKey: item.key,
    itemID: item.id,
    title:
      String(options.title || "").trim() ||
      getItemTitle(item) ||
      String(previous?.title || "").trim() ||
      item.key,
    messages: trimMessages(messages, MAX_STORED_MESSAGES),
    createdAt: previous?.createdAt || now,
    updatedAt: now,
  };
}

/** Serialise a session for the cache (message list capped). */
export function serializeSession(session: ChatSession): ChatSession {
  return {
    itemKey: session.itemKey,
    itemID: session.itemID,
    title: session.title,
    messages: trimMessages(session.messages, MAX_STORED_MESSAGES),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

/** Sort helper: sessions with the newest activity first. */
export function compareSessions(a: ChatSession, b: ChatSession): number {
  return (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0);
}

/** Markdown export used by "导出对话" / copy-to-clipboard. */
export function exportSessionMarkdown(
  session: ChatSession,
  options: { now?: number; includeQuotes?: boolean } = {},
): string {
  const includeQuotes = options.includeQuotes !== false;
  const lines: string[] = [
    `# ${session.title || session.itemKey}`,
    "",
    `- 条目：${session.itemKey}`,
    `- 消息数：${session.messages.length}`,
  ];
  if (options.now) {
    lines.push(`- 导出时间：${new Date(options.now).toISOString()}`);
  }
  lines.push("");
  for (const message of session.messages) {
    lines.push(message.role === "user" ? "## 用户" : "## PaperMiner");
    lines.push("");
    if (includeQuotes && message.quote) {
      lines.push(
        ...message.quote
          .split("\n")
          .map((line) => `> ${line}`)
          .concat([""]),
      );
    }
    lines.push(message.content);
    if (message.incomplete) lines.push("");
    if (message.incomplete) lines.push("（回答已中断）");
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

/* ------------------------------------------------------------------ */
/* Cache-backed API                                                    */
/* ------------------------------------------------------------------ */

export async function loadChatSession(
  item: Zotero.Item,
): Promise<ChatSession | null> {
  if (!item?.key) return null;
  const cached = memorySessions.get(item.key);
  if (cached) return cached;
  if (!isChatPersistEnabled()) return null;
  try {
    const raw = await pluginCache.get<unknown>(
      CHAT_NAMESPACE,
      sessionCacheKey(item.key),
    );
    const session = normalizeSession(raw, item.key);
    if (!session || !session.messages.length) return null;
    if (!session.itemID) session.itemID = item.id;
    if (!session.title) session.title = getItemTitle(item) || item.key;
    memorySessions.set(item.key, session);
    return session;
  } catch (error) {
    log("loadChatSession failed:", error);
    return null;
  }
}

export async function saveChatSession(session: ChatSession): Promise<void> {
  if (!session?.itemKey) return;
  const serialized = serializeSession(session);
  memorySessions.set(serialized.itemKey, serialized);
  if (!isChatPersistEnabled()) return;
  try {
    await pluginCache.set(
      CHAT_NAMESPACE,
      sessionCacheKey(serialized.itemKey),
      serialized,
    );
  } catch (error) {
    log("saveChatSession failed:", error);
  }
}

export async function clearChatSession(item: Zotero.Item): Promise<void> {
  if (!item?.key) return;
  memorySessions.delete(item.key);
  try {
    await pluginCache.delete(CHAT_NAMESPACE, sessionCacheKey(item.key));
  } catch (error) {
    log("clearChatSession failed:", error);
  }
}

/** Drop the in-memory copy only (used on shutdown). */
export function releaseChatSessions(): void {
  memorySessions.clear();
}
