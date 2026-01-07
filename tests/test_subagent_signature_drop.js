const { transformClaudeResponseOut } = require("../src/transform/claude");

async function testDropTrailingSignatureWithoutThinking() {
  const responseId = "test_resp_1";

  const chunk1 = {
    response: {
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ text: "一句话自我介绍。" }],
          },
        },
      ],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 },
      modelVersion: "gemini-3-flash",
      responseId,
    },
  };

  // Gemini 在非 thinking 模式下也可能追加一个空文本 part，只携带 thoughtSignature
  const chunk2 = {
    response: {
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ thoughtSignature: "sig_xxx", text: "" }],
          },
          finishReason: "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 },
      modelVersion: "gemini-3-flash",
      responseId,
    },
  };

  const sse = `data: ${JSON.stringify(chunk1)}\n\ndata: ${JSON.stringify(chunk2)}\n\n`;
  const upstream = new Response(sse, { headers: { "Content-Type": "text/event-stream" } });
  const transformed = await transformClaudeResponseOut(upstream);
  const out = await transformed.text();

  if (out.includes("\"type\":\"thinking\"") || out.includes("\"type\":\"signature_delta\"")) {
    throw new Error("Expected no thinking/signature blocks for non-thinking response.");
  }
}

async function main() {
  await testDropTrailingSignatureWithoutThinking();
  // eslint-disable-next-line no-console
  console.log("✅ test_subagent_signature_drop: PASS");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("❌ test_subagent_signature_drop: FAIL\n", err);
  process.exitCode = 1;
});
