/* eslint-disable mocha/max-top-level-suites */

import { assert } from "chai";
import {
  getCitationCountSync,
  getCitationDetails,
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
      assert.equal(getCitationCountSync(item), 1234);
    } finally {
      Zotero.HTTP.request = originalHTTP;
      (globalThis as any).fetch = originalFetch;
    }
  });
});

describe("OpenCitations fallback", function () {
  it("builds a citation list when OpenAlex details are rate-limited", async function () {
    const originalHTTP = Zotero.HTTP.request;
    const originalFetch = (globalThis as any).fetch;
    try {
      (Zotero.HTTP as any).request = async () => {
        throw new Error("HTTP 429");
      };
      (globalThis as any).fetch = async (url: string) => {
        if (url.includes("filter=cites")) {
          return new Response("rate limited", { status: 429 });
        }
        if (url.includes("/index/v2/citations/")) {
          return new Response(
            JSON.stringify([
              { citing: "omid:br/1 doi:10.1234/citing-paper openalex:W9" },
            ]),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.includes("/meta/v1/metadata/")) {
          return new Response(
            JSON.stringify([
              {
                title: "Citing Paper",
                author: "A Author [orcid:1]; B Author [orcid:2]",
                venue: "Journal [issn:1234]",
                pub_date: "2025-01",
              },
            ]),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
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
        id: 2,
        isRegularItem: () => true,
        getField: (field: string) =>
          field === "DOI"
            ? "10.48550/arXiv.1706.03762"
            : field === "title"
              ? "Attention is all you need"
              : "",
        getDisplayTitle: () => "Attention is all you need",
      } as any;
      let details: any;
      try {
        details = await getCitationDetails(item, { force: true });
      } catch (error) {
        await (globalThis as any).IOUtils.writeUTF8(
          "/tmp/oc-details-error.txt",
          JSON.stringify({
            name: (error as any)?.name,
            message: (error as any)?.message,
            code: (error as any)?.code,
            stack: (error as any)?.stack,
          }),
        );
        throw error;
      }
      await (globalThis as any).IOUtils.writeUTF8(
        "/tmp/oc-details.json",
        JSON.stringify(details, null, 2),
      );
      assert.equal(details.status, "ok", JSON.stringify(details.error));
      assert.equal(details.source, "opencitations");
      assert.isAbove(details.items.length, 0);
      assert.equal(details.items[0].title, "Citing Paper");
      assert.include(details.items[0].url, "doi.org/10.1234/citing-paper");
    } finally {
      Zotero.HTTP.request = originalHTTP;
      (globalThis as any).fetch = originalFetch;
    }
  });
});

describe("partial citation details", function () {
  it("keeps the known count when every citation-list source fails", async function () {
    const originalHTTP = Zotero.HTTP.request;
    const originalFetch = (globalThis as any).fetch;
    try {
      (Zotero.HTTP as any).request = async () => {
        throw new Error("HTTP 429");
      };
      (globalThis as any).fetch = async (url: string) => {
        if (url.includes("filter=cites") || url.includes("opencitations")) {
          return new Response("rate limited", { status: 429 });
        }
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
        id: 3,
        isRegularItem: () => true,
        getField: (field: string) =>
          field === "DOI"
            ? "10.48550/arXiv.1706.03762"
            : field === "title"
              ? "Attention is all you need"
              : "",
        getDisplayTitle: () => "Attention is all you need",
      } as any;
      const details = await getCitationDetails(item, { force: true });
      assert.equal(details.status, "ok");
      assert.equal(details.count, 1234);
      assert.equal(details.items.length, 0);
      assert.include(details.error || "", "429");
    } finally {
      Zotero.HTTP.request = originalHTTP;
      (globalThis as any).fetch = originalFetch;
    }
  });
});

describe("citation dialog layout", function () {
  it("keeps title and metadata in separate lines", async function () {
    const originalFetch = (globalThis as any).fetch;
    try {
      (globalThis as any).fetch = async (url: string) => {
        if (url.includes("filter=cites")) {
          return new Response(
            JSON.stringify({
              results: [
                {
                  id: "https://openalex.org/W1",
                  display_name:
                    "A very long citing paper title that should wrap onto a second line without overlapping its metadata",
                  cited_by_count: 1,
                  publication_year: 2025,
                  authorships: [{ author: { display_name: "Alice Author" } }],
                  primary_location: {
                    landing_page_url: "https://example.org/citing-1",
                    source: { display_name: "Journal of Testing" },
                  },
                },
                {
                  id: "https://openalex.org/W2",
                  display_name: "Second citing paper",
                  cited_by_count: 0,
                  publication_year: 2024,
                  authorships: [{ author: { display_name: "Bob Author" } }],
                  primary_location: {
                    landing_page_url: "https://example.org/citing-2",
                    source: { display_name: "Journal of Testing" },
                  },
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            id: "https://openalex.org/W999",
            display_name: "Layout Test Paper",
            cited_by_count: 2,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      };
      const item = {
        id: 99,
        isRegularItem: () => true,
        getField: (field: string) =>
          field === "DOI"
            ? "10.9999/papermier-layout-test"
            : field === "title"
              ? "Layout Test Paper"
              : "",
        getDisplayTitle: () => "Layout Test Paper",
      } as any;
      const { openCitationDialog } =
        await import("../src/modules/citations/dialog");
      openCitationDialog(item);
      await Zotero.Promise.delay(500);
      const doc = Zotero.getMainWindow().document;
      const rows = Array.from(
        doc.querySelectorAll(".pm-citation-item"),
      ) as HTMLElement[];
      assert.isAtLeast(rows.length, 2);
      for (const row of rows) {
        const title = row.querySelector(
          ".pm-citation-item-title",
        ) as HTMLElement;
        const meta = row.querySelector(".pm-citation-item-meta") as HTMLElement;
        assert.isAtLeast(row.getBoundingClientRect().height, 42);
        assert.isAtLeast(
          meta.getBoundingClientRect().top,
          title.getBoundingClientRect().bottom - 1,
          "metadata should be below the title",
        );
      }
      (doc.querySelector(".pm-citation-close") as HTMLElement)?.click();
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });
});
