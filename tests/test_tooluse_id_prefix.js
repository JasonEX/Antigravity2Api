const { transformClaudeResponseOut } = require("../src/transform/claude");

async function testToolUseIdUsesTooluPrefixWhenMissingUpstreamId() {
  const responseId = "test_fc_no_id";

  const chunk1 = {
    response: {
      candidates: [
        {
          content: {
            role: "model",
            parts: [
              {
                functionCall: {
                  name: "Read",
                  args: { file_path: "E:\\\\misc\\\\temp\\\\1\\\\fibonacci.js" },
                },
              },
            ],
          },
        },
      ],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 },
      modelVersion: "gemini-3-flash",
      responseId,
    },
  };

  const chunk2 = {
    response: {
      candidates: [
        {
          content: { role: "model", parts: [{ text: "" }] },
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

  const match = out.match(/"type":"tool_use","id":"([^"]+)","name":"Read"/);
  if (!match) {
    throw new Error(`Expected a tool_use content_block for Read, got:\n${out}`);
  }

  const toolUseId = match[1];
  if (!toolUseId.startsWith("toolu_")) {
    throw new Error(`Expected tool_use.id to start with "toolu_", got: ${toolUseId}`);
  }
}

async function main() {
  await testToolUseIdUsesTooluPrefixWhenMissingUpstreamId();
  // eslint-disable-next-line no-console
  console.log("✅ test_tooluse_id_prefix: PASS");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("❌ test_tooluse_id_prefix: FAIL\n", err);
  process.exitCode = 1;
});
