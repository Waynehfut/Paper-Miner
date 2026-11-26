import { assert } from "chai";
import { __testing } from "../src/modules/ai/llm";

function config(presetId: string, model: string) {
  return {
    presetId,
    baseURL: "https://api.openai.com/v1",
    apiKey: "test",
    model,
    temperature: 0.3,
    maxTokens: 1000,
    stream: false,
  } as any;
}

describe("LLM token parameter compatibility", function () {
  it("uses max_completion_tokens and omits temperature for GPT-5", function () {
    const body = __testing.buildRequestBody(
      config("openai", "gpt-5"),
      [{ role: "user", content: "hi" }],
      false,
      {},
    );
    assert.equal(body.max_completion_tokens, 1000);
    assert.notProperty(body, "max_tokens");
    assert.notProperty(body, "temperature");
  });

  it("keeps max_tokens for DeepSeek", function () {
    const body = __testing.buildRequestBody(
      config("deepseek", "deepseek-chat"),
      [{ role: "user", content: "hi" }],
      false,
      {},
    );
    assert.equal(body.max_tokens, 1000);
    assert.notProperty(body, "max_completion_tokens");
  });

  it("adapts a max_tokens rejection to max_completion_tokens", function () {
    const adapted = __testing.adaptRequestBodyForParameterError(
      { max_tokens: 1000, temperature: 0.3 },
      "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
    );
    assert.ok(adapted);
    assert.equal(adapted!.max_completion_tokens, 1000);
    assert.notProperty(adapted!, "max_tokens");
  });
});
