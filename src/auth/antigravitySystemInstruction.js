const {
  ANTIGRAVITY_SYSTEM_INSTRUCTION,
  ANTIGRAVITY_SYSTEM_INSTRUCTION_IGNORE,
} = require("../prompts/antigravitySystemPrompt");

function shouldInjectAntigravitySystemInstruction(modelName) {
  const m = String(modelName || "").trim().toLowerCase();
  if (!m) return false;
  if (m.includes("claude")) return true;
  // v1internal alias: gemini-3-pro-preview -> gemini-3-pro-high
  if (m.includes("gemini-3-pro-preview")) return true;
  if (m.includes("gemini-3-pro-high")) return true;
  if (m.includes("gemini-3-pro-low")) return true;
  return false;
}

function inferModelNameFromBody(body) {
  if (!body || typeof body !== "object") return "";
  const top = body.model;
  if (typeof top === "string" && top.trim()) return top.trim();
  const reqModel = body?.request?.model;
  if (typeof reqModel === "string" && reqModel.trim()) return reqModel.trim();
  return "";
}

function ensureAntigravitySystemInstruction(body) {
  if (!body || typeof body !== "object") return;

  const modelName = inferModelNameFromBody(body);
  if (!shouldInjectAntigravitySystemInstruction(modelName)) return;

  const req = body.request;
  if (!req || typeof req !== "object") return;

  const injectedPart0 = { text: ANTIGRAVITY_SYSTEM_INSTRUCTION };
  const injectedPart1 = { text: ANTIGRAVITY_SYSTEM_INSTRUCTION_IGNORE };

  if (!req.systemInstruction || typeof req.systemInstruction !== "object") {
    req.systemInstruction = { role: "user", parts: [injectedPart0, injectedPart1] };
    return;
  }

  req.systemInstruction.role = "user";
  const existingParts = Array.isArray(req.systemInstruction.parts) ? req.systemInstruction.parts : [];

  // Idempotent: if already injected, keep existing parts untouched.
  if (
    existingParts.length >= 2 &&
    existingParts[0]?.text === injectedPart0.text &&
    existingParts[1]?.text === injectedPart1.text
  ) {
    req.systemInstruction.parts = existingParts;
    return;
  }

  // Mirror upstream behavior: set parts[0]/parts[1] and append original systemInstruction parts.
  req.systemInstruction.parts = [injectedPart0, injectedPart1, ...existingParts];
}

module.exports = {
  ensureAntigravitySystemInstruction,
  inferModelNameFromBody,
  shouldInjectAntigravitySystemInstruction,
};
