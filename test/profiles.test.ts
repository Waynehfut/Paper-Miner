/* eslint-disable mocha/no-setup-in-describe */
import { assert } from "chai";
import { getPref, setPref } from "../src/utils/prefs";
import {
  loadLLMProfiles,
  saveCurrentLLMProfile,
  switchLLMProvider,
} from "../src/modules/ai/profiles";

describe("LLM provider profiles", function () {
  const keys = [
    "llmPreset",
    "llmBaseURL",
    "llmApiKey",
    "llmModel",
    "llmSummaryModel",
    "llmTranslateModel",
    "llmPptModel",
    "llmDisableThinking",
    "llmProfiles",
  ] as const;
  const backup: Record<string, unknown> = {};

  before(function () {
    for (const key of keys) backup[key] = getPref(key);
  });

  after(function () {
    for (const key of keys) setPref(key, backup[key] as never);
  });

  it("saves and restores separate provider credentials", function () {
    setPref("llmProfiles", "{}" as never);
    setPref("llmPreset", "deepseek" as never);
    setPref("llmBaseURL", "https://api.deepseek.com/v1" as never);
    setPref("llmApiKey", "deepseek-key" as never);
    setPref("llmModel", "deepseek-chat" as never);
    saveCurrentLLMProfile();

    const openai = switchLLMProvider("openai");
    assert.isTrue(openai.configured === false);
    setPref("llmApiKey", "openai-key" as never);
    setPref("llmModel", "gpt-4o-mini" as never);
    saveCurrentLLMProfile();

    const back = switchLLMProvider("deepseek");
    assert.equal(back.presetId, "deepseek");
    assert.equal(getPref("llmApiKey"), "deepseek-key");
    assert.equal(getPref("llmModel"), "deepseek-chat");
    assert.include(getPref("llmBaseURL"), "deepseek.com");

    const profiles = loadLLMProfiles();
    assert.equal(profiles.openai?.apiKey, "openai-key");
    assert.equal(profiles.deepseek?.apiKey, "deepseek-key");
  });
});
