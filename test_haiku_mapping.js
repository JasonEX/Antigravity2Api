const { mapClaudeModelToGemini } = require("./src/transform/claude");

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

function main() {
  assertEqual(mapClaudeModelToGemini("claude-haiku-4"), "gemini-3-flash", "claude-haiku-4 mapping");
  assertEqual(mapClaudeModelToGemini("claude-3-haiku-20240307"), "gemini-3-flash", "claude-3-haiku-20240307 mapping");
  assertEqual(mapClaudeModelToGemini("claude-haiku-4-5-20251001"), "gemini-3-flash", "claude-haiku-4-5-20251001 mapping");

  // eslint-disable-next-line no-console
  console.log("✅ test_haiku_mapping: PASS");
}

try {
  main();
} catch (err) {
  // eslint-disable-next-line no-console
  console.error("❌ test_haiku_mapping: FAIL\n", err);
  process.exitCode = 1;
}

