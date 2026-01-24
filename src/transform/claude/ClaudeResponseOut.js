/**
 * ClaudeResponseOut - Claude 格式请求/响应转换器
 *
 * 基于 ThoughtSignatures Gemini API 官方文档实现
 * 支持 thinking、签名、函数调用等场景
 */

const { handleStreamingResponse } = require("./ClaudeResponseStreaming");
const { handleNonStreamingResponse } = require("./ClaudeResponseNonStreaming");
const { readV1InternalSseToJson } = require("./V1InternalSseReader");

// ==================== 响应转换相关 ====================

/**
 * 转换 Claude 格式响应
 */
async function transformClaudeResponseOut(response, options = {}) {
  const contentType = response.headers.get("Content-Type") || "";

  if (contentType.includes("application/json")) {
    return handleNonStreamingResponse(response, options);
  }

  if (contentType.includes("stream")) {
    if (options?.forceNonStreaming) {
      return handleStreamingResponseAsNonStreaming(response, options);
    }
    return handleStreamingResponse(response, options);
  }

  return response;
}

async function handleStreamingResponseAsNonStreaming(response, options = {}) {
  const rawJSON = await readV1InternalSseToJson(response);
  const jsonResponse = new Response(JSON.stringify(rawJSON), {
    status: response.status,
    headers: { "Content-Type": "application/json" },
  });
  return handleNonStreamingResponse(jsonResponse, options);
}

// ==================== 导出 ====================
module.exports = {
  transformClaudeResponseOut,
};
