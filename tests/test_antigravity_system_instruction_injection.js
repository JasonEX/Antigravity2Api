const {
  ensureAntigravitySystemInstruction,
  shouldInjectAntigravitySystemInstruction,
} = require("../src/auth/antigravitySystemInstruction");
const {
  ANTIGRAVITY_SYSTEM_INSTRUCTION,
  ANTIGRAVITY_SYSTEM_INSTRUCTION_IGNORE,
} = require("../src/prompts/antigravitySystemPrompt");

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

function assert(condition, label) {
  if (!condition) {
    throw new Error(label);
  }
}

function main() {
  assertEqual(shouldInjectAntigravitySystemInstruction("claude-sonnet-4-5"), true, "inject claude");
  assertEqual(shouldInjectAntigravitySystemInstruction("gemini-3-pro-preview"), true, "inject preview");
  assertEqual(shouldInjectAntigravitySystemInstruction("gemini-3-pro-high"), true, "inject high");
  assertEqual(shouldInjectAntigravitySystemInstruction("gemini-3-pro-low"), true, "inject low");
  assertEqual(shouldInjectAntigravitySystemInstruction("gemini-2.5-flash"), false, "skip flash");

  const body = {
    model: "claude-sonnet-4-5",
    request: { systemInstruction: { role: "user", parts: [{ text: "user system" }] } },
  };
  ensureAntigravitySystemInstruction(body);
  assertEqual(body.request.systemInstruction.role, "user", "role forced to user");
  assertEqual(body.request.systemInstruction.parts[0].text, ANTIGRAVITY_SYSTEM_INSTRUCTION, "injected part0");
  assertEqual(body.request.systemInstruction.parts[1].text, ANTIGRAVITY_SYSTEM_INSTRUCTION_IGNORE, "injected part1");
  assertEqual(body.request.systemInstruction.parts[2].text, "user system", "original parts appended");

  const beforeLen = body.request.systemInstruction.parts.length;
  ensureAntigravitySystemInstruction(body);
  assertEqual(body.request.systemInstruction.parts.length, beforeLen, "idempotent injection");

  const body2 = { model: "gemini-2.5-flash", request: {} };
  ensureAntigravitySystemInstruction(body2);
  assert(body2.request.systemInstruction == null, "non-target model should not be modified");

  const body3 = { model: "gemini-3-pro-preview", request: {} };
  ensureAntigravitySystemInstruction(body3);
  assertEqual(body3.request.systemInstruction.parts.length, 2, "inject when missing systemInstruction");
  assertEqual(body3.request.systemInstruction.parts[0].text, ANTIGRAVITY_SYSTEM_INSTRUCTION, "part0 set");
  assertEqual(body3.request.systemInstruction.parts[1].text, ANTIGRAVITY_SYSTEM_INSTRUCTION_IGNORE, "part1 set");

  // eslint-disable-next-line no-console
  console.log("✅ test_antigravity_system_instruction_injection: PASS");
}

try {
  main();
} catch (err) {
  // eslint-disable-next-line no-console
  console.error("❌ test_antigravity_system_instruction_injection: FAIL\n", err);
  process.exitCode = 1;
}
