const { wrapRequest } = require("../src/transform/gemini");

function assert(condition, label) {
  if (!condition) {
    throw new Error(label);
  }
}

function main() {
  const clientJson = { request: { contents: [{ role: "user", parts: [{ text: "hi" }] }] } };
  const { wrappedBody } = wrapRequest(clientJson, { projectId: "p", modelName: "gemini-2.5-pro" });

  assert(wrappedBody && typeof wrappedBody === "object", "wrappedBody should be object");
  assert(wrappedBody.request && typeof wrappedBody.request === "object", "wrappedBody.request should be object");
  assert(
    wrappedBody.request.generationConfig && typeof wrappedBody.request.generationConfig === "object",
    "generationConfig should be created when missing"
  );
  assert(
    wrappedBody.request.generationConfig.maxOutputTokens === 65535,
    "maxOutputTokens should be forced even when generationConfig missing"
  );

  // eslint-disable-next-line no-console
  console.log("✅ test_gemini_wrap_request_generation_config_default: PASS");
}

try {
  main();
} catch (err) {
  // eslint-disable-next-line no-console
  console.error("❌ test_gemini_wrap_request_generation_config_default: FAIL\n", err);
  process.exitCode = 1;
}

