/* eslint-disable mocha/max-top-level-suites */
import { assert } from "chai";
import {
  normalizeChatEndpoint,
  getLLMPreset,
  LLM_PRESETS,
} from "../src/modules/ai/presets";
import {
  parseCompletionBody,
  parseSSEPayload,
  LLMError,
} from "../src/modules/ai/llm";
import {
  DEFAULT_ENABLED_FIELDS,
  buildBadges,
  formatShortText,
  hasWarning,
  isWarningValue,
  normalizePublicationName,
} from "../src/modules/journal/fields";
import type { JournalRankData } from "../src/types";

describe("filesystem helpers", function () {
  it("resolves plugin data and downloads directories", async function () {
    const { getDownloadsDir, getPluginDataDir } =
      await import("../src/utils/fs");
    assert.isNotEmpty(getPluginDataDir());
    assert.include(getPluginDataDir(), "paperminer");
    assert.isNotEmpty(getDownloadsDir());
  });
});

describe("LLM presets", function () {
  it("normalizes base URLs into chat/completions endpoints", function () {
    assert.equal(
      normalizeChatEndpoint("https://api.deepseek.com/v1"),
      "https://api.deepseek.com/v1/chat/completions",
    );
    assert.equal(
      normalizeChatEndpoint("https://api.openai.com/v1/"),
      "https://api.openai.com/v1/chat/completions",
    );
    assert.equal(
      normalizeChatEndpoint("https://open.bigmodel.cn/api/paas/v4"),
      "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    );
    assert.equal(
      normalizeChatEndpoint("http://127.0.0.1:11434/v1"),
      "http://127.0.0.1:11434/v1/chat/completions",
    );
    assert.equal(
      normalizeChatEndpoint("https://example.com/v1/chat/completions"),
      "https://example.com/v1/chat/completions",
    );
    assert.equal(
      normalizeChatEndpoint(
        "https://generativelanguage.googleapis.com/v1beta/openai",
      ),
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    );
  });

  it("has unique preset ids and non-empty defaults", function () {
    const ids = new Set(LLM_PRESETS.map((preset) => preset.id));
    assert.equal(ids.size, LLM_PRESETS.length);
    for (const preset of LLM_PRESETS) {
      assert.isString(preset.label);
      if (preset.id !== "custom") {
        assert.isNotEmpty(preset.baseURL);
        assert.isNotEmpty(preset.defaultModel);
      }
    }
    assert.equal(getLLMPreset("missing").id, "custom");
  });
});

describe("LLM response parsing", function () {
  it("parses streaming deltas", function () {
    const delta = parseSSEPayload(
      JSON.stringify({
        choices: [{ delta: { content: "Hello" }, finish_reason: null }],
      }),
    );
    assert.equal(delta?.content, "Hello");
    assert.isFalse(!!delta?.done);
  });

  it("parses reasoning and done payloads", function () {
    const reasoning = parseSSEPayload(
      JSON.stringify({
        choices: [
          {
            delta: { reasoning_content: "thinking", content: "" },
            finish_reason: null,
          },
        ],
      }),
    );
    assert.equal(reasoning?.reasoning, "thinking");
    const done = parseSSEPayload("[DONE]");
    assert.isTrue(done?.done);
  });

  it("supports array content parts", function () {
    const delta = parseSSEPayload(
      JSON.stringify({
        choices: [{ delta: { content: [{ text: "A" }, { text: "B" }] } }],
      }),
    );
    assert.equal(delta?.content, "AB");
  });

  it("throws a typed error for provider errors", function () {
    let caught: unknown;
    try {
      parseSSEPayload(JSON.stringify({ error: { message: "bad key" } }));
    } catch (error) {
      caught = error;
    }
    assert.instanceOf(caught, LLMError);
    assert.include((caught as Error).message, "bad key");
  });

  it("parses non-streaming bodies", function () {
    assert.equal(
      parseCompletionBody(
        JSON.stringify({ choices: [{ message: { content: "answer" } }] }),
      ),
      "answer",
    );
    assert.throws(
      () => parseCompletionBody(JSON.stringify({ choices: [] })),
      LLMError,
    );
  });
});

const sample: JournalRankData = {
  publication: "Nature",
  queriedName: "nature",
  fetchedAt: 1,
  official: {
    sciif: "50.5",
    sciwarn: "无",
    jci: "10.1",
  },
  select: {
    sci: "Q1",
    sciUp: "1区 TOP",
    sciUpTop: "TOP",
  },
};

describe("EasyScholar field mapping", function () {
  it("builds badges for enabled fields", function () {
    const badges = buildBadges(sample, ["sciUp", "sciif"]);
    assert.equal(badges.length, 2);
    assert.equal(badges[0].value, "1区 TOP");
    assert.equal(badges[1].label, "影响因子 IF");
  });

  it("formats compact text", function () {
    assert.include(formatShortText(sample, ["sciUp", "sciif"]), "1区 TOP");
    assert.include(formatShortText(sample, ["sciUp", "sciif"]), "IF 50.5");
  });

  it("detects warnings, including the sciwarn alias", function () {
    assert.isFalse(hasWarning(sample, ["sciWarning"]));
    assert.isFalse(isWarningValue("无"));
    assert.isFalse(isWarningValue(""));
    assert.isTrue(isWarningValue("预警"));
    const warned: JournalRankData = {
      ...sample,
      official: { ...sample.official, sciwarn: "预警" },
    };
    assert.isTrue(hasWarning(warned, ["sciWarning"]));
  });

  it("normalizes publication names", function () {
    assert.equal(
      normalizePublicationName("  Journal of  Cleaner Production. "),
      "Journal of Cleaner Production",
    );
  });
});

describe("Chinese journal fields", function () {
  const cnData: JournalRankData = {
    publication: "中国社会科学",
    queriedName: "中国社会科学",
    fetchedAt: 1,
    official: {
      cssci: "CSSCI",
      pku: "1",
      cscd: "核心库",
      zhongguokejihexin: "中国科技核心期刊",
      cju: "T1综合性社会科学",
    },
    select: {
      cssci: "CSSCI",
      pku: "1",
      cscd: "核心库",
    },
  };

  it("enables Chinese core fields by default", function () {
    for (const key of ["cssci", "pku", "cscd", "zhongguokejihexin"]) {
      assert.include(DEFAULT_ENABLED_FIELDS, key);
    }
  });

  it("builds compact, categorised Chinese core badges", function () {
    const badges = buildBadges(cnData, DEFAULT_ENABLED_FIELDS);
    const byKey = new Map(badges.map((badge) => [badge.key, badge]));
    assert.equal(byKey.get("cssci")?.value, "收录");
    assert.equal(byKey.get("cssci")?.category, "index");
    assert.equal(byKey.get("pku")?.value, "收录");
    assert.equal(byKey.get("cscd")?.value, "核心库");
    assert.equal(byKey.get("cju")?.value, "T1");
  });

  it("shows Chinese core lists in the compact column text", function () {
    const text = formatShortText(cnData, DEFAULT_ENABLED_FIELDS);
    assert.include(text, "CSSCI");
    assert.include(text, "北大核心");
    assert.include(text, "科技核心");
  });

  it("merges the CAS TOP flag into the quartile badge", function () {
    const data: JournalRankData = {
      ...sample,
      select: { ...sample.select, sciUpTop: "TOP" },
    };
    const badges = buildBadges(data, DEFAULT_ENABLED_FIELDS);
    const sciUp = badges.find((badge) => badge.key === "sciUp");
    assert.ok(sciUp);
    assert.include(sciUp!.value, "TOP");
    assert.isUndefined(badges.find((badge) => badge.key === "sciUpTop"));
  });
});
