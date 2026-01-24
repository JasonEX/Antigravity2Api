const crypto = require("crypto");

function makeToolUseId() {
  // Claude Code expects tool_use ids to look like official "toolu_*" ids.
  return `toolu_vrtx_${crypto.randomBytes(16).toString("base64url")}`;
}

// 转换 usageMetadata 为 Claude 格式
function toClaudeUsage(usageMetadata = {}) {
  const prompt = usageMetadata.promptTokenCount || 0;
  const candidates = usageMetadata.candidatesTokenCount || 0;
  const thoughts = usageMetadata.thoughtsTokenCount || 0;

  if (usageMetadata.totalTokenCount && usageMetadata.totalTokenCount >= prompt) {
    return {
      input_tokens: prompt,
      output_tokens: usageMetadata.totalTokenCount - prompt,
    };
  }

  return {
    input_tokens: prompt,
    output_tokens: candidates + thoughts,
  };
}

module.exports = {
  makeToolUseId,
  toClaudeUsage,
};

