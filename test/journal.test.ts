import { assert } from "chai";
import {
  buildBadges,
  formatShortText,
  isWarningValue,
  normalizePublicationName,
  JOURNAL_FIELDS,
} from "../src/modules/journal/fields";
import {
  buildJournalResult,
  classifyErrorCode,
  detectJournalWarning,
  expandJournalAlias,
  extractApiMessage,
  journalCacheKey,
  mapErrorCode,
  normalizeJournalKey,
  parseEasyScholarResponse,
} from "../src/modules/journal/service";
import type { JournalRankData } from "../src/types";
import { getPref, setPref } from "../src/utils/prefs";

function makeData(
  official: Record<string, string>,
  select: Record<string, string> = {},
): JournalRankData {
  return {
    publication: "Nature",
    queriedName: "Nature",
    fetchedAt: Date.now(),
    official,
    select,
  };
}

describe("journal ranking", function () {
  describe("parseEasyScholarResponse", function () {
    it("parses officialRank.all and officialRank.select", function () {
      const parsed = parseEasyScholarResponse({
        code: 200,
        data: {
          officialRank: {
            all: { sciif: "12.3", sciUp: "1区", sciwarn: "无" },
            select: { sci: "1区", ccf: "A" },
          },
        },
      });
      assert.isNotNull(parsed);
      assert.equal(parsed!.official.sciif, "12.3");
      assert.equal(parsed!.official.sciUp, "1区");
      assert.equal(parsed!.select.sci, "1区");
      assert.equal(parsed!.select.ccf, "A");
    });

    it("unions the two maps so fields resolve regardless of API version", function () {
      const parsed = parseEasyScholarResponse({
        code: 200,
        data: {
          officialRank: { all: { sciif: "3.2" }, select: { sci: "3区" } },
        },
      });
      assert.isNotNull(parsed);
      // `sciif` came from `all`, `sci` from `select`, both must be reachable.
      assert.equal(parsed!.official.sci, "3区");
      assert.equal(parsed!.select.sciif, "3.2");
    });

    it("accepts a flat data payload", function () {
      const parsed = parseEasyScholarResponse({
        code: 200,
        data: { sci: "2区", sciif: "5.5" },
      });
      assert.isNotNull(parsed);
      assert.equal(parsed!.official.sci, "2区");
    });

    it("accepts a payload without a numeric code", function () {
      const parsed = parseEasyScholarResponse({
        data: { officialRank: { all: { sciif: "1.1" } } },
      });
      assert.isNotNull(parsed);
      assert.equal(parsed!.official.sciif, "1.1");
    });

    it("returns null for non-200 codes", function () {
      assert.isNull(
        parseEasyScholarResponse({
          code: 400,
          msg: "secretKey error",
          data: { officialRank: { all: { sciif: "1" } } },
        }),
      );
    });

    it("returns null when no rank data is present", function () {
      assert.isNull(parseEasyScholarResponse({ code: 200, data: {} }));
      assert.isNull(parseEasyScholarResponse({ code: 200, data: "oops" }));
      assert.isNull(parseEasyScholarResponse(null));
      assert.isNull(parseEasyScholarResponse(undefined));
    });
  });

  describe("warning detection", function () {
    it("handles placeholder warning values", function () {
      for (const value of [
        "",
        "无",
        "非预警",
        "未预警",
        "None",
        "0",
        "-",
        "null",
      ]) {
        assert.isFalse(isWarningValue(value), `value ${value} must not warn`);
        const data = makeData({ sciwarn: value }, { sciWarning: value });
        assert.isFalse(
          detectJournalWarning(data),
          `${value} must not be reported as warning`,
        );
      }
    });

    it("detects sciwarn and sciWarning", function () {
      assert.isTrue(isWarningValue("低"));
      assert.isTrue(detectJournalWarning(makeData({ sciwarn: "1" })));
      assert.isTrue(detectJournalWarning(makeData({}, { sciWarning: "中" })));
      assert.isTrue(
        detectJournalWarning(makeData({ sciwarn: "无", sciWarning: "高" })),
      );
    });

    it("detects unknown warn/alert/risk fields defensively", function () {
      assert.isTrue(detectJournalWarning(makeData({ someAlert: "yes" })));
      assert.isFalse(detectJournalWarning(makeData({ sciwarn: "无" })));
    });
  });

  describe("badges and column text", function () {
    it("only builds badges for enabled fields", function () {
      const data = makeData(
        { sciif: "12.3", sciif5: "11.1" },
        { sciUp: "1区", sciUpTop: "TOP" },
      );
      const badges = buildBadges(data, ["sciUp", "sciif"]);
      assert.deepEqual(
        badges.map((badge) => badge.key),
        ["sciUp", "sciif"],
      );
      assert.equal(badges[1].value, "12.3");
      assert.equal(badges[1].tone, "info");
    });

    it("formats a compact column text", function () {
      const data = makeData(
        { sciif: "12.3" },
        { sciUp: "1区", sciUpTop: "TOP" },
      );
      const text = formatShortText(data, ["sciUp", "sciUpTop", "sciif"]);
      assert.include(text, "1区");
      assert.include(text, "TOP");
      assert.include(text, "IF 12.3");
    });

    it("builds an ok JournalResult with warning flag and badges", function () {
      const previous = getPref("journalFields");
      try {
        setPref("journalFields", "sciUp,sciif,sciWarning" as never);
        const result = buildJournalResult(
          makeData({ sciif: "12.3", sciwarn: "低" }, { sciUp: "1区" }),
        );
        assert.equal(result.status, "ok");
        assert.equal(result.warning, true);
        assert.isTrue(result.badges.length >= 2);
        assert.include(result.shortText, "预警");
        assert.include(result.shortText, "IF 12.3");
      } finally {
        setPref("journalFields", previous as never);
      }
    });

    it("keeps warning independent of the enabled display fields", function () {
      const data = makeData({ sciwarn: "低" });
      assert.isTrue(buildJournalResult(data).warning);
    });
  });

  describe("journal name normalization", function () {
    it("trims and lowercases cache keys", function () {
      assert.equal(
        normalizeJournalKey("  Nature   Communications. "),
        "nature communications",
      );
      assert.equal(
        normalizePublicationName(" Nature   Communications. "),
        "Nature Communications",
      );
    });

    it("only exposes known field keys", function () {
      assert.isTrue(JOURNAL_FIELDS.length > 10);
    });
  });

  describe("EasyScholar error mapping", function () {
    it("classifies invalid / empty key business codes", function () {
      for (const code of [40001, 40002, 40003, 40004, 40005]) {
        assert.equal(classifyErrorCode(code), "key", `code ${code}`);
      }
      assert.equal(classifyErrorCode(401), "key");
      assert.equal(classifyErrorCode(403), "key");
      assert.equal(classifyErrorCode(400), "key");
    });

    it("classifies rate / quota business codes", function () {
      for (const code of [40006, 40007, 40008, 40009]) {
        assert.equal(classifyErrorCode(code), "rate", `code ${code}`);
      }
      assert.equal(classifyErrorCode(429), "rate");
    });

    it("classifies not-found and unknown codes", function () {
      assert.equal(classifyErrorCode(404), "notfound");
      assert.isUndefined(classifyErrorCode(12345));
      assert.isUndefined(classifyErrorCode(undefined));
      assert.isUndefined(classifyErrorCode("oops"));
    });

    it("maps 40002 / 40005 to an actionable key message", function () {
      const invalid = mapErrorCode(40002, "Key错误");
      assert.isString(invalid);
      assert.include(invalid!, "密钥无效或为空");
      assert.include(invalid!, "设置");
      assert.include(invalid!, "Key错误");
      assert.notInclude(invalid!, "接口返回");
      const empty = mapErrorCode(40005, "密钥不能为空");
      assert.include(empty!, "密钥无效或为空");
      assert.include(empty!, "密钥不能为空");
    });

    it("maps rate codes to a rate/quota message with detail", function () {
      const message = mapErrorCode(40006, "超出调用次数");
      assert.include(message!, "频繁");
      assert.include(message!, "超出调用次数");
      assert.include(mapErrorCode(429)!, "频繁");
    });

    it("returns undefined for unknown codes", function () {
      assert.isUndefined(mapErrorCode(undefined));
      assert.isUndefined(mapErrorCode(12345));
    });

    it("extracts the upstream msg field", function () {
      assert.equal(
        extractApiMessage({ code: 40002, msg: "Key错误", data: null }),
        "Key错误",
      );
      assert.equal(extractApiMessage({ code: 200 }), "");
      assert.equal(extractApiMessage(null), "");
    });
  });

  describe("journal name aliases", function () {
    const PNAS =
      "PROCEEDINGS OF THE NATIONAL ACADEMY OF SCIENCES OF THE UNITED STATES OF AMERICA";

    it("expands PNAS abbreviations and full-ish titles", function () {
      assert.equal(expandJournalAlias("PNAS"), PNAS);
      assert.equal(
        expandJournalAlias("Proceedings of the National Academy of Sciences"),
        PNAS,
      );
      assert.equal(
        expandJournalAlias(
          "Proceedings of the National Academy of Sciences of the United States of America.",
        ),
        PNAS,
      );
    });

    it("uses the same cache key for both PNAS forms", function () {
      assert.equal(
        journalCacheKey("Proceedings of the National Academy of Sciences"),
        journalCacheKey("PNAS"),
      );
      assert.isTrue(
        journalCacheKey("PNAS").includes("proceedings of the national academy"),
      );
    });

    it("leaves other journals untouched", function () {
      assert.equal(expandJournalAlias("Nature"), "Nature");
      assert.equal(
        expandJournalAlias("Proceedings of the Royal Society B"),
        "Proceedings of the Royal Society B",
      );
      assert.equal(expandJournalAlias("  "), "");
    });
  });
});
