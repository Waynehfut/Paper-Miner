import { assert } from "chai";
import {
  buildTencentAuthorization,
  mapTencentTarget,
} from "../src/modules/ai/translate";
import { buildTranslateMessages } from "../src/modules/ai/prompts";

describe("Tencent translation helpers", function () {
  it("maps internal language codes to Tencent TMT targets", function () {
    assert.equal(mapTencentTarget("zh-CN"), "zh");
    assert.equal(mapTencentTarget("zh-TW"), "zh");
    assert.equal(mapTencentTarget("en"), "en");
    assert.equal(mapTencentTarget("ja"), "ja");
    assert.equal(mapTencentTarget("unknown"), "en");
  });

  it("builds the TC3-HMAC-SHA256 Authorization header", async function () {
    const authorization = await buildTencentAuthorization({
      secretId: "AKIDTEST",
      secretKey: "SECRETTEST",
      payload:
        '{"SourceText":"Hello","Source":"auto","Target":"zh","ProjectId":0}',
      timestamp: 1700000000,
    });
    assert.equal(
      authorization,
      "TC3-HMAC-SHA256 Credential=AKIDTEST/2023-11-14/tmt/tc3_request, " +
        "SignedHeaders=content-type;host, " +
        "Signature=5e48cc31a8fbb42559f20e63e18fabe5c32f43dda5be287117e616bc59179fc8",
    );
  });

  it("appends the custom AI translation prompt", function () {
    const messages = buildTranslateMessages("hello", {
      targetLang: "zh",
      customPrompt: "CUSTOM-TRANSLATION-RULE",
    });
    assert.include(messages[0].content, "CUSTOM-TRANSLATION-RULE");
    assert.include(messages[0].content, "学术论文翻译");
  });
});
