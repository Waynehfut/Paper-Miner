import { assert } from "chai";
import {
  formatDateParts,
  interpretZoteroData,
  mergeRetractionOutcomes,
  parseCrossrefWork,
  parseOpenAlexWork,
  type RetractionSourceOutcome,
} from "../src/modules/retraction/service";

function outcome(
  source: RetractionSourceOutcome["source"],
  patch: Partial<RetractionSourceOutcome> = {},
): RetractionSourceOutcome {
  return {
    source,
    consulted: true,
    retracted: false,
    ...patch,
  };
}

describe("retraction detection", function () {
  describe("parseOpenAlexWork", function () {
    it("reads is_retracted and updated_date", function () {
      const info = parseOpenAlexWork({
        id: "https://openalex.org/W123",
        doi: "https://doi.org/10.1000/abc",
        is_retracted: true,
        updated_date: "2021-02-03T12:00:00.000000",
      });
      assert.isNotNull(info);
      assert.isTrue(info!.retracted);
      assert.equal(info!.date, "2021-02-03");
      assert.equal(info!.openAlexId, "https://openalex.org/W123");
    });

    it("reads a not-retracted work", function () {
      const info = parseOpenAlexWork({
        id: "https://openalex.org/W1",
        is_retracted: false,
      });
      assert.isNotNull(info);
      assert.isFalse(info!.retracted);
    });

    it("rejects payloads without is_retracted", function () {
      assert.isNull(parseOpenAlexWork({ id: "x" }));
      assert.isNull(parseOpenAlexWork({ error: "not found" }));
      assert.isNull(parseOpenAlexWork(null));
    });
  });

  describe("parseCrossrefWork", function () {
    it("detects a retraction via update-to", function () {
      const info = parseCrossrefWork({
        status: "ok",
        message: {
          DOI: "10.1000/abc",
          "update-to": [
            {
              type: "retraction",
              DOI: "10.1000/notice",
              updated: { "date-parts": [[2020, 4, 5]] },
            },
          ],
        },
      });
      assert.isNotNull(info);
      assert.isTrue(info!.retracted);
      assert.equal(info!.noticeDOI, "10.1000/notice");
      assert.equal(info!.date, "2020-04-05");
      assert.equal(info!.noticeType, "retraction");
    });

    it("detects a withdrawal notice", function () {
      const info = parseCrossrefWork({
        message: {
          "update-to": [{ type: "withdrawal", DOI: "10.1000/w" }],
        },
      });
      assert.isNotNull(info);
      assert.isTrue(info!.retracted);
      assert.equal(info!.noticeType, "withdrawal");
    });

    it("detects is-retracted-by relations", function () {
      const info = parseCrossrefWork({
        message: {
          relation: {
            "is-retracted-by": [
              { "id-type": "doi", id: "https://doi.org/10.1000/notice2" },
            ],
          },
        },
      });
      assert.isNotNull(info);
      assert.isTrue(info!.retracted);
      assert.equal(info!.noticeDOI, "10.1000/notice2");
    });

    it("ignores corrections", function () {
      const info = parseCrossrefWork({
        message: {
          "update-to": [{ type: "correction", DOI: "10.1000/correction" }],
          relation: { "is-corrected-by": [{ id: "10.1000/correction" }] },
        },
      });
      assert.isNotNull(info);
      assert.isFalse(info!.retracted);
    });

    it("rejects payloads without a message", function () {
      assert.isNull(parseCrossrefWork({}));
      assert.isNull(parseCrossrefWork({ message: "oops" }));
      assert.isNull(parseCrossrefWork(undefined));
    });
  });

  describe("interpretZoteroData", function () {
    it("reads retraction notice DOI, date and reasons", function () {
      const info = interpretZoteroData({
        doi: "https://doi.org/10.1000/notice",
        date: "2020-01-01T00:00:00.000Z",
        reasons: ["Concerns/Issues about Image", ""],
        urls: ["https://retractionwatch.com/x"],
      });
      assert.isTrue(info.retracted);
      assert.equal(info.noticeDOI, "10.1000/notice");
      assert.equal(info.date, "2020-01-01");
      assert.deepEqual(info.reasons, ["Concerns/Issues about Image"]);
      assert.deepEqual(info.urls, ["https://retractionwatch.com/x"]);
    });

    it("accepts a Date instance", function () {
      const info = interpretZoteroData({
        date: new Date(2021, 1, 3),
        reasons: [],
      });
      assert.equal(info.date, "2021-02-03");
    });

    it("handles empty data", function () {
      const info = interpretZoteroData(false);
      assert.isFalse(info.retracted);
      assert.deepEqual(info.reasons, []);
    });
  });

  describe("formatDateParts", function () {
    it("formats date-parts, timestamps and strings", function () {
      assert.equal(
        formatDateParts({ "date-parts": [[2020, 5, 1]] }),
        "2020-05-01",
      );
      assert.equal(formatDateParts({ "date-parts": [[2020]] }), "2020-01-01");
      assert.equal(formatDateParts("2022-12-31"), "2022-12-31");
      assert.isUndefined(formatDateParts(undefined));
    });
  });

  describe("mergeRetractionOutcomes", function () {
    it("prefers Zotero data and fills gaps from other sources", function () {
      const result = mergeRetractionOutcomes("10.1000/abc", [
        outcome("zotero", {
          retracted: true,
          reason: "Concerns/Issues about Image",
          date: "2020-01-01",
        }),
        outcome("crossref", {
          retracted: true,
          noticeDOI: "10.1000/notice",
          date: "2020-02-02",
        }),
      ]);
      assert.equal(result.status, "retracted");
      assert.isTrue(result.retracted);
      assert.deepEqual(result.sources, ["zotero", "crossref"]);
      assert.equal(result.reason, "Concerns/Issues about Image");
      assert.equal(result.date, "2020-01-01");
      assert.equal(result.noticeDOI, "10.1000/notice");
    });

    it("returns clear when every consulted source says no", function () {
      const result = mergeRetractionOutcomes("10.1000/abc", [
        outcome("zotero"),
        outcome("openalex"),
      ]);
      assert.equal(result.status, "clear");
      assert.isFalse(result.retracted);
      assert.deepEqual(result.sources, ["zotero", "openalex"]);
    });

    it("keeps a positive finding when another source errored", function () {
      const result = mergeRetractionOutcomes("10.1000/abc", [
        outcome("openalex", { retracted: false, error: "timeout" }),
        outcome("crossref", {
          retracted: true,
          noticeDOI: "10.1000/notice",
        }),
      ]);
      assert.equal(result.status, "retracted");
      assert.isTrue(result.retracted);
    });

    it("returns error when no source produced an answer", function () {
      const result = mergeRetractionOutcomes("10.1000/abc", [
        {
          source: "openalex",
          consulted: false,
          retracted: false,
          error: "boom",
        },
      ]);
      assert.equal(result.status, "error");
      assert.equal(result.error, "boom");
    });

    it("returns unknown when no source was consulted", function () {
      const result = mergeRetractionOutcomes("10.1000/abc", []);
      assert.equal(result.status, "unknown");
    });
  });
});
