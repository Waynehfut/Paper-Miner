/* eslint-disable mocha/no-setup-in-describe */
import { assert } from "chai";
import {
  isTranslationConfigured,
  translateText,
} from "../src/modules/ai/translate";
import { getPref, setPref } from "../src/utils/prefs";

describe("free translation engines", function () {
  const originalFetch = (globalThis as any).fetch;
  const backup: Record<string, unknown> = {};

  before(function () {
    for (const key of [
      "translateEngine",
      "translateTarget",
      "translateMyMemoryEmail",
    ]) {
      backup[key] = getPref(key as any);
    }
    setPref("translateTarget", "zh-CN" as never);
    setPref("translateMyMemoryEmail", "" as never);
  });

  after(function () {
    (globalThis as any).fetch = originalFetch;
    for (const [key, value] of Object.entries(backup)) {
      setPref(key as any, value as never);
    }
  });

  it("translates through the free Bing endpoint", async function () {
    setPref("translateEngine", "bing" as never);
    assert.isTrue(isTranslationConfigured());
    let url = "";
    (globalThis as any).fetch = async (input: string) => {
      url = String(input);
      return new Response(
        JSON.stringify([
          { translations: [{ text: "你好，世界", to: "zh-Hans" }] },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    assert.equal(await translateText("Hello world"), "你好，世界");
    assert.include(url, "edge.microsoft.com/translate/translatetext");
    assert.include(url, "from=en");
    assert.include(url, "to=zh-Hans");
  });

  it("translates through MyMemory and sends an optional email", async function () {
    setPref("translateEngine", "mymemory" as never);
    setPref("translateMyMemoryEmail", "user@example.com" as never);
    assert.isTrue(isTranslationConfigured());
    let url = "";
    (globalThis as any).fetch = async (input: string) => {
      url = String(input);
      return new Response(
        JSON.stringify({
          responseStatus: 200,
          responseData: { translatedText: "你好，世界" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    assert.equal(await translateText("Hello world"), "你好，世界");
    assert.include(url, "api.mymemory.translated.net/get");
    assert.include(url, "langpair=en%7Czh-CN");
    assert.include(url, "de=user%40example.com");
  });
});
