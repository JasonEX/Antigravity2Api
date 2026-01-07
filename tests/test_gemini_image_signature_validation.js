const { GeminiApi } = require("../src/api");

async function testRejectsMissingSignatureOnModelImagePart() {
  let upstreamCalled = false;
  const geminiApi = new GeminiApi({
    upstreamClient: {
      callV1Internal() {
        upstreamCalled = true;
        throw new Error("Upstream should not be called for invalid requests");
      },
    },
  });

  const clientBody = {
    contents: [
      { role: "user", parts: [{ text: "Generate an image of a cat." }] },
      {
        role: "model",
        parts: [{ inline_data: { mime_type: "image/png", data: "BASE64_IMAGE" } }],
      },
      { role: "user", parts: [{ text: "Edit it to look like a tiger." }] },
    ],
    generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: "1:1", imageSize: "1K" } },
  };

  const result = await geminiApi.handleGenerate("gemini-3-pro-image", "generateContent", clientBody);
  if (result.status !== 400) {
    throw new Error(`Expected status 400, got ${result.status}`);
  }
  const body = result.body;
  if (!body?.error?.message?.includes("missing a thought_signature")) {
    throw new Error(`Expected missing thought_signature error, got:\n${JSON.stringify(body, null, 2)}`);
  }
  if (upstreamCalled) {
    throw new Error("Expected upstream not to be called");
  }
}

async function testAllowsSignedModelImagePart() {
  let upstreamCalled = false;
  const geminiApi = new GeminiApi({
    upstreamClient: {
      async callV1Internal() {
        upstreamCalled = true;
        return new Response(
          JSON.stringify({
            response: {
              candidates: [{ content: { role: "model", parts: [{ text: "ok" }] } }],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      },
    },
  });

  const clientBody = {
    contents: [
      { role: "user", parts: [{ text: "Generate an image of a cat." }] },
      {
        role: "model",
        parts: [
          {
            inline_data: { mime_type: "image/png", data: "BASE64_IMAGE" },
            thoughtSignature: "sig_123",
          },
        ],
      },
      { role: "user", parts: [{ text: "Edit it to look like a tiger." }] },
    ],
    generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: "1:1", imageSize: "1K" } },
  };

  const result = await geminiApi.handleGenerate("gemini-3-pro-image", "generateContent", clientBody);
  if (result.status !== 200) {
    throw new Error(`Expected status 200, got ${result.status}`);
  }
  if (!upstreamCalled) {
    throw new Error("Expected upstream to be called");
  }
}

async function main() {
  await testRejectsMissingSignatureOnModelImagePart();
  await testAllowsSignedModelImagePart();
  // eslint-disable-next-line no-console
  console.log("✅ test_gemini_image_signature_validation: PASS");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("❌ test_gemini_image_signature_validation: FAIL\n", err);
  process.exitCode = 1;
});
