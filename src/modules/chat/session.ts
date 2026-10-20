/**
 * Persistent chat sessions per library item. Owned by the chat module.
 *
 * The types live here (they are part of the chat module's public surface) and
 * the storage/pure helpers live in `store.ts`.
 */

import {
  clearChatSession as clearStoredSession,
  loadChatSession as loadStoredSession,
  saveChatSession as saveStoredSession,
} from "./store";

export type ChatRole = "user" | "assistant";

export interface StoredChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
  /** Optional quote from the PDF/annotation that prompted the message. */
  quote?: string;
  /** Set while a streaming reply was interrupted. */
  incomplete?: boolean;
}

export interface ChatSession {
  itemKey: string;
  itemID: number;
  title: string;
  messages: StoredChatMessage[];
  createdAt: number;
  updatedAt: number;
}

export async function loadChatSession(
  item: Zotero.Item,
): Promise<ChatSession | null> {
  return loadStoredSession(item);
}

export async function saveChatSession(session: ChatSession): Promise<void> {
  return saveStoredSession(session);
}

export async function clearChatSession(item: Zotero.Item): Promise<void> {
  return clearStoredSession(item);
}
