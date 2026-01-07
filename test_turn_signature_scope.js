const { transformClaudeRequestIn, transformClaudeResponseOut } = require("./src/transform/claude");

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

async function testCurrentTurnSignatureScoping() {
  await primeToolSignatureCache({ toolUseId: "toolu_test_prev", thoughtSignature: "sig_prev" });
  await primeToolSignatureCache({ toolUseId: "toolu_test_curr", thoughtSignature: "sig_curr" });

  const claudeReq = {
    model: "claude-haiku-4",
    messages: [
      { role: "user", content: [{ type: "text", text: "Do A" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_test_prev", name: "Read", input: { file_path: "/a" } }],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_test_prev", content: "ok" },
          // Claude Code may echo the previous task text after tool_result; this should NOT reset turn start.
          { type: "text", text: "Do A" },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
      // New user task: start of current turn.
      { role: "user", content: [{ type: "text", text: "Do B" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_test_curr", name: "Read", input: { file_path: "/b" } }],
      },
    ],
  };

  const { body } = transformClaudeRequestIn(claudeReq, "");
  const contents = body?.request?.contents || [];

  const prev = findFunctionCallPart(contents, "toolu_test_prev");
  if (!prev) throw new Error("Expected previous-turn functionCall part to exist");
  if ("thoughtSignature" in prev) {
    throw new Error("Expected previous-turn functionCall to NOT include thoughtSignature");
  }

  const curr = findFunctionCallPart(contents, "toolu_test_curr");
  if (!curr) throw new Error("Expected current-turn functionCall part to exist");
  if (curr.thoughtSignature !== "sig_curr") {
    throw new Error(`Expected current-turn thoughtSignature=sig_curr, got ${curr.thoughtSignature}`);
  }
}

async function testDummySignatureFallbackFirstToolOnly() {
  const prev = process.env.AG2API_THOUGHT_SIGNATURE_DUMMY;
  process.env.AG2API_THOUGHT_SIGNATURE_DUMMY = "true";
  try {
    const claudeReq = {
      model: "claude-haiku-4",
      messages: [
        { role: "user", content: [{ type: "text", text: "Do something" }] },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_missing_1", name: "Read", input: { file_path: "/x" } },
            { type: "tool_use", id: "toolu_missing_2", name: "Read", input: { file_path: "/y" } },
          ],
        },
      ],
    };

    const { body } = transformClaudeRequestIn(claudeReq, "");
    const contents = body?.request?.contents || [];

    const first = findFunctionCallPart(contents, "toolu_missing_1");
    if (!first) throw new Error("Expected first missing functionCall to exist");
    if (first.thoughtSignature !== "skip_thought_signature_validator") {
      throw new Error(`Expected dummy thoughtSignature on first FC, got ${first.thoughtSignature}`);
    }

    const second = findFunctionCallPart(contents, "toolu_missing_2");
    if (!second) throw new Error("Expected second missing functionCall to exist");
    if ("thoughtSignature" in second) {
      throw new Error("Expected NO dummy thoughtSignature on second (parallel) functionCall");
    }
  } finally {
    if (prev === undefined) delete process.env.AG2API_THOUGHT_SIGNATURE_DUMMY;
    else process.env.AG2API_THOUGHT_SIGNATURE_DUMMY = prev;
  }
}

async function main() {
  await testCurrentTurnSignatureScoping();
  await testDummySignatureFallbackFirstToolOnly();
  // eslint-disable-next-line no-console
  console.log("✅ test_turn_signature_scope: PASS");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("❌ test_turn_signature_scope: FAIL\n", err);
  process.exitCode = 1;
});

