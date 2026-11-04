/* eslint-disable mocha/max-top-level-suites */

import { assert } from "chai";
import {
  getCitationSummary,
  parseScholarCitations,
  parseScholarSearch,
} from "../src/modules/citations/service";

describe("Google Scholar citation parsing", function () {
  it("parses the search hit, count and cited-by URL", function () {
    const hits = parseScholarSearch(`
      <div class="gs_r gs_or gs_scl" data-cid="ABC123">
        <h3 class="gs_rt"><a href="https://example.org/paper">Example Paper</a></h3>
        <div class="gs_a">A Author - Journal, 2024 - example.org</div>
        <div class="gs_fl">
          <a href="/scholar?cites=123456&as_sdt=2005&hl=en">Cited by 42</a>
        </div>
      </div>
    `);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].title, "Example Paper");
    assert.equal(hits[0].count, 42);
    assert.equal(hits[0].clusterId, "ABC123");
    assert.equal(hits[0].url, "https://example.org/paper");
    assert.include(hits[0].citesUrl, "cites=123456");
    assert.include(hits[0].meta, "Journal, 2024");
  });

  it("parses citing works and falls back to a Scholar search URL", function () {
    const items = parseScholarCitations(`
      <div class="gs_r gs_or gs_scl" data-cid="DEF456">
        <h3 class="gs_rt"><a href="https://example.org/citing">A Citing Paper</a></h3>
        <div class="gs_a">B Author - Venue, 2025 - example.org</div>
      </div>
      <div class="gs_r gs_or gs_scl" data-cid="GHI789">
        <h3 class="gs_rt">A Paper Without Link</h3>
        <div class="gs_a">C Author - Venue, 2023</div>
      </div>
    `);
    assert.equal(items.length, 2);
    assert.equal(items[0].title, "A Citing Paper");
    assert.equal(items[0].url, "https://example.org/citing");
    assert.equal(items[1].title, "A Paper Without Link");
    assert.include(items[1].url, "scholar.google.com/scholar?");
  });
});

describe("citation fallback", function () {
  it("falls back to OpenAlex when Google Scholar is unavailable", async function () {
    const originalHTTP = Zotero.HTTP.request;
    const originalFetch = (globalThis as any).fetch;
    try {
      (Zotero.HTTP as any).request = async () => {
        throw new Error("HTTP 429");
      };
      (globalThis as any).fetch = async (url: string) => {
        assert.include(url, "api.openalex.org");
        return new Response(
          JSON.stringify({
            id: "https://openalex.org/W123",
            display_name: "Attention Is All You Need",
            cited_by_count: 1234,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      };
      const item = {
        id: 1,
        isRegularItem: () => true,
        getField: (field: string) =>
          field === "DOI"
            ? "10.48550/arXiv.1706.03762"
            : field === "title"
              ? "Attention is all you need"
              : "",
        getDisplayTitle: () => "Attention is all you need",
      } as any;
      const summary = await getCitationSummary(item, { force: true });
      assert.equal(summary.status, "ok");
      assert.equal(summary.source, "openalex");
      assert.equal(summary.count, 1234);
      assert.include(summary.citesUrl, "openalex.org");
    } finally {
      Zotero.HTTP.request = originalHTTP;
      (globalThis as any).fetch = originalFetch;
    }
  });
});
