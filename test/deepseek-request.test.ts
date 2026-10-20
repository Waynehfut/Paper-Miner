/* eslint-disable mocha/no-setup-in-describe */
import { assert } from "chai";
import { chatCompletion } from "../src/modules/ai/llm";
import { getPref, setPref } from "../src/utils/prefs";

describe("DeepSeek request options", function () {
  const originalFetch = (globalThis as any).fetch;
  const backup: Record<string, unknown> = {};

  before(function () {
    for (const key of [
      "llmBaseURL",
      "llmApiKey",
      "llmModel",
      "llmStream",
      "llmDisableThinking",
      "llmPreset",
    ]) {
      backup[key] = getPref(key as any);
    }
    setPref("llmPreset", "deepseek" as never);
    setPref("llmBaseURL", "https://api.deepseek.com/v1" as never);
    setPref("llmApiKey", "test-key" as never);
    setPref("llmModel", "deepseek-chat" as never);
    setPref("llmStream", false as never);
    setPref("llmDisableThinking", true as never);
  });

  after(function () {
    (globalThis as any).fetch = originalFetch;
    for (const [key, value] of Object.entries(backup)) {
      setPref(key as any, value as never);
    }
  });

  it("sends thinking disabled only for providers with that capability", async function () {
    let body: any = null;
    (globalThis as any).fetch = async (_url: string, init: any) => {
      body = JSON.parse(init.body);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "OK" } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const answer = await chatCompletion([{ role: "user", content: "ping" }], {
      stream: false,
      maxTokens: 16,
    });
    assert.equal(answer, "OK");
    assert.equal(body?.thinking?.type, "disabled");

    // Switching to a custom provider must not leak the DeepSeek-specific
    // parameter into the request.
    setPref("llmPreset", "custom" as never);
    body = null;
    await chatCompletion([{ role: "user", content: "ping" }], {
      stream: false,
      maxTokens: 16,
    });
    assert.isUndefined(body?.thinking);
  });
});
