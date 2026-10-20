import { assert } from "chai";
import {
  buildSession,
  compareSessions,
  createMessageId,
  exportSessionMarkdown,
  normalizeSession,
  sanitizeMessage,
  serializeSession,
  sessionCacheKey,
  trimMessages,
  MAX_MESSAGE_CHARS,
  MAX_STORED_MESSAGES,
} from "../src/modules/chat/store";
import type {
  ChatSession,
  StoredChatMessage,
} from "../src/modules/chat/session";

function makeMessage(
  overrides: Partial<StoredChatMessage> = {},
): StoredChatMessage {
  return {
    id: "m1",
    role: "user",
    content: "hello",
    createdAt: 1000,
    ...overrides,
  };
}

/** Minimal Zotero.Item stand-in for pure session helpers. */
function makeItem(): Zotero.Item {
  return {
    id: 42,
    key: "ITEMKEY1",
    getField: (field: string) => (field === "title" ? "A Paper Title" : ""),
  } as unknown as Zotero.Item;
}

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    itemKey: "ITEMKEY1",
    itemID: 42,
    title: "A Paper Title",
    messages: [makeMessage()],
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

describe("chat store", function () {
  describe("sessionCacheKey", function () {
    it("namespaces by item key", function () {
      assert.equal(sessionCacheKey("ABCD1234"), "session:ABCD1234");
    });

    it("handles empty keys", function () {
      assert.equal(sessionCacheKey(""), "session:");
    });
  });

  describe("sanitizeMessage", function () {
    it("keeps valid messages", function () {
      const message = sanitizeMessage(makeMessage());
      assert.isNotNull(message);
      assert.equal(message?.role, "user");
      assert.equal(message?.content, "hello");
    });

    it("rejects invalid roles and empty content", function () {
      assert.isNull(sanitizeMessage({ role: "system", content: "x" }));
      assert.isNull(sanitizeMessage({ role: "user", content: "   " }));
      assert.isNull(sanitizeMessage(null));
      assert.isNull(sanitizeMessage("not a message"));
    });

    it("clamps long content and quotes", function () {
      const message = sanitizeMessage(
        makeMessage({
          content: "A".repeat(MAX_MESSAGE_CHARS + 100),
          quote: "Q".repeat(5000),
        }),
      );
      assert.equal(message?.content.length, MAX_MESSAGE_CHARS);
      assert.equal(message?.quote?.length, 4000);
    });

    it("keeps the incomplete flag", function () {
      const message = sanitizeMessage(makeMessage({ incomplete: true }));
      assert.isTrue(message?.incomplete);
    });

    it("generates an id when missing", function () {
      const message = sanitizeMessage({
        role: "assistant",
        content: "hi",
        createdAt: 5,
      });
      assert.isString(message?.id);
      assert.isNotEmpty(message?.id);
    });
  });

  describe("trimMessages", function () {
    it("keeps only the newest messages", function () {
      const messages = Array.from({ length: 10 }, (_value, index) =>
        makeMessage({ id: `m${index}`, content: `message ${index}` }),
      );
      const trimmed = trimMessages(messages, 3);
      assert.lengthOf(trimmed, 3);
      assert.equal(trimmed[0].content, "message 7");
      assert.equal(trimmed[2].content, "message 9");
    });

    it("drops malformed entries", function () {
      const trimmed = trimMessages(
        [null, { role: "user", content: "ok" }, { role: "user" }],
        10,
      );
      assert.lengthOf(trimmed, 1);
      assert.equal(trimmed[0].content, "ok");
    });

    it("defaults to the stored message cap", function () {
      const messages = Array.from(
        { length: MAX_STORED_MESSAGES + 25 },
        (_value, index) => makeMessage({ id: `m${index}` }),
      );
      assert.lengthOf(trimMessages(messages), MAX_STORED_MESSAGES);
    });
  });

  describe("normalizeSession", function () {
    it("returns null for garbage", function () {
      assert.isNull(normalizeSession(null, "K"));
      assert.isNull(normalizeSession("nope", "K"));
    });

    it("fills defaults and clamps messages", function () {
      const session = normalizeSession(
        { messages: [makeMessage(), makeMessage({ id: "m2" })] },
        "FALLBACK",
      );
      assert.isNotNull(session);
      assert.equal(session?.itemKey, "FALLBACK");
      assert.lengthOf(session?.messages || [], 2);
      assert.isAbove(session?.createdAt || 0, 0);
    });

    it("preserves a valid session", function () {
      const session = normalizeSession(
        {
          itemKey: "KEY",
          itemID: 7,
          title: "T",
          messages: [makeMessage()],
          createdAt: 10,
          updatedAt: 20,
        },
        "KEY",
      );
      assert.equal(session?.itemID, 7);
      assert.equal(session?.title, "T");
      assert.equal(session?.createdAt, 10);
      assert.equal(session?.updatedAt, 20);
    });
  });

  describe("buildSession", function () {
    it("uses the item title and timestamps", function () {
      const item = makeItem();
      const previous = makeSession({ createdAt: 111, title: "Old" });
      const session = buildSession(item, [makeMessage()], {
        now: 5000,
        previous,
      });
      assert.equal(session.itemKey, "ITEMKEY1");
      assert.equal(session.itemID, 42);
      assert.equal(session.createdAt, 111);
      assert.equal(session.updatedAt, 5000);
      assert.equal(session.title, "A Paper Title");
    });

    it("keeps the title override", function () {
      const session = buildSession(makeItem(), [], {
        now: 1,
        title: "Custom title",
      });
      assert.equal(session.title, "Custom title");
    });

    it("caps stored messages", function () {
      const messages = Array.from(
        { length: MAX_STORED_MESSAGES + 10 },
        (_value, index) => makeMessage({ id: `m${index}` }),
      );
      const session = buildSession(makeItem(), messages, { now: 1 });
      assert.lengthOf(session.messages, MAX_STORED_MESSAGES);
    });
  });

  describe("serializeSession", function () {
    it("caps messages without mutating timestamps", function () {
      const session = makeSession({
        messages: Array.from({ length: 5 }, (_value, index) =>
          makeMessage({ id: `m${index}` }),
        ),
      });
      const serialized = serializeSession(session);
      assert.lengthOf(serialized.messages, 5);
      assert.equal(serialized.createdAt, session.createdAt);
      assert.equal(serialized.updatedAt, session.updatedAt);
    });
  });

  describe("compareSessions", function () {
    it("orders by newest update", function () {
      const older = makeSession({ updatedAt: 100 });
      const newer = makeSession({ updatedAt: 200 });
      assert.isBelow(compareSessions(newer, older), 0);
      assert.isAbove(compareSessions(older, newer), 0);
      assert.equal(compareSessions(older, older), 0);
    });
  });

  describe("createMessageId", function () {
    it("is unique per call", function () {
      const first = createMessageId(1000, () => 0.5);
      const second = createMessageId(1000, () => 0.5);
      assert.notEqual(first, second);
    });
  });

  describe("exportSessionMarkdown", function () {
    it("renders roles, quotes and interruption notes", function () {
      const session = makeSession({
        messages: [
          makeMessage({
            id: "u1",
            role: "user",
            content: "What is the method?",
            quote: "We propose a reranker.",
          }),
          makeMessage({
            id: "a1",
            role: "assistant",
            content: "It reranks passages.",
            incomplete: true,
          }),
        ],
      });
      const markdown = exportSessionMarkdown(session, { now: 0 });
      assert.include(markdown, "# A Paper Title");
      assert.include(markdown, "## 用户");
      assert.include(markdown, "## PaperMiner");
      assert.include(markdown, "> We propose a reranker.");
      assert.include(markdown, "It reranks passages.");
      assert.include(markdown, "回答已中断");
    });

    it("produces a trailing newline", function () {
      const markdown = exportSessionMarkdown(makeSession());
      assert.isTrue(markdown.endsWith("\n"));
    });
  });
});
