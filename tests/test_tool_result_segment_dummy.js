const { transformClaudeRequestIn, transformClaudeResponseOut } = require("../src/transform/claude");

async function primeToolSignatureCache({ toolUseId, thoughtSignature }) {
  const payload = {
    response: {
      candidates: [
        {
          content: {
            role: "model",
            parts: [
              {
                functionCall: { name: "Read", args: { file_path: "/tmp/x" }, id: toolUseId },
                thoughtSignature,
              },
            ],
          },
        },
      ],
      modelVersion: "gemini-3-flash",
      responseId: `resp_${toolUseId}`,
    },
  };

  const upstream = new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" },
  });

  // The transformer caches tool_use.id -> thoughtSignature as a side-effect.
  await transformClaudeResponseOut(upstream);
}

function findFunctionCallPart(contents, toolUseId) {
  for (const content of contents || []) {
    const parts = content?.parts || [];
    for (const part of parts) {
      const fc = part?.functionCall;
      if (fc && fc.id === toolUseId) return part;
    }
  }
  return null;
}

async function testToolResultTurnDoesNotInjectDummyOutsideSignatureSegment() {
  await primeToolSignatureCache({ toolUseId: "toolu_test_seg", thoughtSignature: "sig_real" });

  const prev = process.env.AG2API_THOUGHT_SIGNATURE_DUMMY;
  process.env.AG2API_THOUGHT_SIGNATURE_DUMMY = "true";
  try {
    const claudeReq = {
      model: "claude-haiku-4", // mapped to gemini-3-flash
      messages: [
        { role: "user", content: [{ type: "text", text: "Do something" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_test_seg", name: "Read", input: { file_path: "/x" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_test_seg", content: "ok" }] },
      ],
    };

    const { body } = transformClaudeRequestIn(claudeReq, "", { signatureSegmentStartIndex: claudeReq.messages.length });
    const contents = body?.request?.contents || [];

    const fc = findFunctionCallPart(contents, "toolu_test_seg");
    if (!fc) throw new Error("Expected functionCall part to exist");
    if ("thoughtSignature" in fc) {
      throw new Error(`Expected NO dummy signature outside signature segment, got ${fc.thoughtSignature}`);
    }
  } finally {
    if (prev === undefined) delete process.env.AG2API_THOUGHT_SIGNATURE_DUMMY;
    else process.env.AG2API_THOUGHT_SIGNATURE_DUMMY = prev;
  }
}

async function main() {
  await testToolResultTurnDoesNotInjectDummyOutsideSignatureSegment();
  // eslint-disable-next-line no-console
  console.log("✅ test_tool_result_segment_dummy: PASS");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("❌ test_tool_result_segment_dummy: FAIL\n", err);
  process.exitCode = 1;
});
