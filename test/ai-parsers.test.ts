import { assert } from "chai";
import {
  chunkTextForSummary,
  cleanModelMarkdown,
  countCjk,
  detectTextLanguage,
  languageDisplayName,
  languageFromSetting,
  resolveOutputLanguage,
  resolveTranslateTarget,
  splitText,
  stripCodeFence,
  SUMMARY_MAX_CHUNKS,
  SUMMARY_SINGLE_PASS_CHARS,
} from "../src/modules/ai/prompts";
import { extractJsonValue } from "../src/modules/ai/outline";
import { cleanExtractedText } from "../src/modules/ai/paperText";
import {
  cleanTranslation,
  computeYoudaoSign,
  mapDeepLTarget,
  mapYoudaoTarget,
  translateText,
  truncateYoudaoText,
  youdaoSignInput,
} from "../src/modules/ai/translate";

const ZH_SAMPLE =
  "本文提出了一种新的图神经网络训练框架，在多个基准数据集上取得了显著的性能提升。实验结果表明，该方法能够有效降低计算开销，同时保持较高的预测准确率。";

const EN_SAMPLE =
  "We propose a new training framework for graph neural networks. Experiments on several benchmarks show consistent improvements over strong baselines.";

function makeLongText(paragraphs: number, paragraphLength = 900): string {
  const sentence =
    "This paragraph describes the experimental setup, the datasets and the evaluation protocol used in this work. ";
  const body = sentence
    .repeat(Math.ceil(paragraphLength / sentence.length))
    .slice(0, paragraphLength);
  return Array.from(
    { length: paragraphs },
    (_, index) => `段落 ${index + 1} ${body}`,
  ).join("\n\n");
}

describe("AI parsers", function () {
  describe("language helpers", function () {
    it("detects Chinese and English text", function () {
      assert.equal(detectTextLanguage(ZH_SAMPLE), "zh");
      assert.equal(detectTextLanguage(EN_SAMPLE), "en");
      assert.isAbove(countCjk(ZH_SAMPLE), 20);
      assert.equal(countCjk(EN_SAMPLE), 0);
      assert.equal(detectTextLanguage(""), "en");
    });

    it("resolves the summary/slide output language", function () {
      assert.equal(resolveOutputLanguage("auto", ZH_SAMPLE), "zh");
      assert.equal(resolveOutputLanguage("auto", EN_SAMPLE), "en");
      assert.equal(resolveOutputLanguage("zh", EN_SAMPLE), "zh");
      assert.equal(resolveOutputLanguage("en", ZH_SAMPLE), "en");
      assert.equal(resolveOutputLanguage("zh-CN", EN_SAMPLE), "zh");
      assert.equal(resolveOutputLanguage(undefined, EN_SAMPLE), "en");
      assert.equal(languageFromSetting("zh-CN"), "zh");
      assert.equal(languageFromSetting("en"), "en");
      assert.isNull(languageFromSetting("auto"));
      assert.isNull(languageFromSetting(undefined));
    });

    it("resolves auto translation direction", function () {
      assert.equal(resolveTranslateTarget("auto", ZH_SAMPLE), "en");
      assert.equal(resolveTranslateTarget("auto", EN_SAMPLE), "zh-CN");
      assert.equal(resolveTranslateTarget(undefined, EN_SAMPLE), "zh-CN");
      assert.equal(resolveTranslateTarget("ja", ZH_SAMPLE), "ja");
      assert.equal(languageDisplayName("zh-CN"), "简体中文");
      assert.equal(languageDisplayName("ja"), "日本語");
      assert.equal(languageDisplayName("auto"), "简体中文");
    });
  });

  describe("text chunking", function () {
    it("keeps short text in a single chunk", function () {
      const chunks = splitText("hello world", 12000);
      assert.deepEqual(chunks, ["hello world"]);
      assert.deepEqual(splitText("", 12000), []);
    });

    it("splits on paragraph boundaries and preserves content", function () {
      const text = makeLongText(40);
      const chunks = chunkTextForSummary(text);
      assert.isAbove(chunks.length, 1);
      assert.isAtMost(chunks.length, SUMMARY_MAX_CHUNKS);
      for (const chunk of chunks) assert.isAbove(chunk.trim().length, 0);
      // No content is lost while chunking.
      assert.equal(
        chunks.join("").replace(/\s+/g, ""),
        text.replace(/\s+/g, ""),
      );
    });

    it("bounds the number of chunks for huge inputs", function () {
      const text = "x".repeat(SUMMARY_SINGLE_PASS_CHARS * 4);
      const chunks = splitText(text, 12000, SUMMARY_MAX_CHUNKS);
      assert.equal(chunks.length, SUMMARY_MAX_CHUNKS);
      assert.equal(
        chunks.join("").replace(/\s+/g, "").length,
        text.replace(/\s+/g, "").length,
      );
    });

    it("does not chunk papers below the single-pass threshold", function () {
      const text = "a".repeat(SUMMARY_SINGLE_PASS_CHARS - 10);
      const chunks = chunkTextForSummary(text);
      assert.lengthOf(chunks, 1);
      assert.equal(chunks[0].length, text.length);
    });
  });

  describe("output cleaning", function () {
    it("strips code fences and conversational openers", function () {
      assert.equal(stripCodeFence('```json\n{"a":1}\n```'), '{"a":1}');
      assert.equal(stripCodeFence('{"a":1}'), '{"a":1}');
      const cleaned = cleanModelMarkdown(
        "好的，以下是这篇论文的摘要：\n\n## 一句话总结\n本文提出了新方法。",
      );
      assert.isFalse(cleaned.includes("好的"));
      assert.include(cleaned, "## 一句话总结");
    });

    it("cleans translated output", function () {
      assert.equal(cleanTranslation("译文：这是译文。"), "这是译文。");
      assert.equal(
        cleanTranslation("```\nThis is a translation.\n```"),
        "This is a translation.",
      );
      assert.equal(cleanTranslation("  Translation: hello  "), "hello");
    });
  });

  describe("JSON extraction", function () {
    it("extracts JSON surrounded by prose", function () {
      const raw =
        '这是大纲：\n```json\n{"title":"A","slides":[{"title":"B","bullets":["c"]}]}\n```\n希望有帮助';
      const parsed = extractJsonValue(raw) as any;
      assert.equal(parsed.title, "A");
      assert.equal(parsed.slides[0].title, "B");
    });

    it("repairs trailing commas and keeps smart quotes as content", function () {
      const raw = '{"title":"含“引号”的标题", "slides":[],}';
      const parsed = extractJsonValue(raw) as any;
      assert.equal(parsed.title, "含“引号”的标题");
      assert.deepEqual(parsed.slides, []);
    });

    it("returns null for text without JSON", function () {
      assert.isNull(extractJsonValue("抱歉，我无法生成大纲。"));
      assert.isNull(extractJsonValue(""));
    });
  });

  describe("PDF text cleaning", function () {
    it("joins hyphenated line breaks and drops page numbers", function () {
      const raw =
        "This paper investigates informa-\ntion extraction.\n\n12\n\nSeveral methods are compared carefully and the results show clear gains over baselines.\n13";
      const cleaned = cleanExtractedText(raw);
      assert.include(cleaned, "information extraction");
      assert.notMatch(cleaned, /^\s*12\s*$/m);
      assert.notMatch(cleaned, /^\s*13\s*$/m);
    });

    it("drops repeated running headers and collapses blank lines", function () {
      const header = "Journal of Testing 2024;12(3):1-20";
      const raw = [
        header,
        "First paragraph of the paper body with enough words to stay.",
        "",
        "",
        header,
        "Second paragraph of the paper body appears here.",
        "",
        "",
        header,
        "Third paragraph of the paper body appears here.",
        "",
        header,
        "Fourth paragraph of the paper body appears here.",
      ].join("\n");
      const cleaned = cleanExtractedText(raw);
      assert.notInclude(cleaned, header);
      assert.notInclude(cleaned, "\n\n\n");
      assert.include(cleaned, "First paragraph");
    });

    it("returns an empty string for empty input", function () {
      assert.equal(cleanExtractedText(""), "");
      assert.equal(cleanExtractedText(" \n\n "), "");
    });
  });

  describe("translation helpers", function () {
    it("maps DeepL target languages", function () {
      assert.equal(mapDeepLTarget("zh-CN"), "ZH-HANS");
      assert.equal(mapDeepLTarget("zh-TW"), "ZH-HANT");
      assert.equal(mapDeepLTarget("en"), "EN");
      assert.equal(mapDeepLTarget("en-US"), "EN-US");
      assert.equal(mapDeepLTarget("ja"), "JA");
    });

    it("maps Youdao target languages", function () {
      assert.equal(mapYoudaoTarget("zh-CN"), "zh-CHS");
      assert.equal(mapYoudaoTarget("zh-TW"), "zh-CHT");
      assert.equal(mapYoudaoTarget("en"), "en");
      assert.equal(mapYoudaoTarget("ja"), "ja");
    });

    it("builds the Youdao v3 signature input", function () {
      assert.equal(truncateYoudaoText("short text"), "short text");
      const long = "abcdefghij1234567890KLMNOPQRST";
      assert.equal(
        truncateYoudaoText(long),
        `abcdefghij${long.length}KLMNOPQRST`,
      );
      assert.equal(
        youdaoSignInput("appKey", "hello", "salt", "1700000000", "secret"),
        "appKeyhellosalt1700000000secret",
      );
    });

    it("computes a SHA-256 signature", async function () {
      try {
        const digest = await computeYoudaoSign("abc");
        assert.equal(
          digest,
          "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        );
      } catch (error) {
        // Some restricted environments do not expose crypto.subtle.
        if (String(error).includes("SHA-256")) this.skip();
        else throw error;
      }
    });

    it("rejects with an AbortError when cancelled", async function () {
      const controller = new AbortController();
      controller.abort();
      try {
        await translateText("hello world", { signal: controller.signal });
        assert.fail("translateText should have thrown");
      } catch (error) {
        assert.equal((error as Error).name, "AbortError");
      }
    });
  });
});
