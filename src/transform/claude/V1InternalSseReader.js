async function readV1InternalSseToJson(response) {
  const merged = {
    candidates: [
      {
        content: { role: "model", parts: [] },
      },
    ],
  };

  if (!response.body) return merged;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const candidate = merged.candidates[0];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trimEnd();
      if (!trimmed.startsWith("data:")) continue;

      const dataStr = trimmed.slice(5).trim();
      if (!dataStr || dataStr === "[DONE]") continue;

      let chunk;
      try {
        chunk = JSON.parse(dataStr);
      } catch (err) {
        try {
          const message = err && typeof err === "object" && "message" in err ? err.message : String(err);
          console.error("[ClaudeTransform] V1Internal SSE parse error:", message);
          console.error("[ClaudeTransform] V1Internal SSE data sample:", String(dataStr).slice(0, 2000));
        } catch (_) {}
        continue;
      }

      const rawJSON = chunk.response || chunk;

      if (rawJSON?.responseId) merged.responseId = rawJSON.responseId;
      if (rawJSON?.modelVersion) merged.modelVersion = rawJSON.modelVersion;
      if (rawJSON?.usageMetadata) merged.usageMetadata = rawJSON.usageMetadata;

      const c0 = rawJSON?.candidates?.[0];
      if (!c0) continue;

      if (c0?.finishReason) candidate.finishReason = c0.finishReason;
      if (c0?.groundingMetadata) candidate.groundingMetadata = c0.groundingMetadata;
      if (c0?.groundingChunks) candidate.groundingChunks = c0.groundingChunks;
      if (c0?.groundingSupports) candidate.groundingSupports = c0.groundingSupports;

      const parts = c0?.content?.parts;
      if (c0?.content?.role) candidate.content.role = c0.content.role;
      if (Array.isArray(parts) && parts.length > 0) {
        candidate.content.parts.push(...parts);
      }
    }
  }

  // Flush remaining buffer (if last chunk didn't end with newline)
  const last = buffer.trimEnd();
  if (last.startsWith("data:")) {
    const dataStr = last.slice(5).trim();
    if (dataStr && dataStr !== "[DONE]") {
      try {
        const chunk = JSON.parse(dataStr);
        const rawJSON = chunk.response || chunk;

        if (rawJSON?.responseId) merged.responseId = rawJSON.responseId;
        if (rawJSON?.modelVersion) merged.modelVersion = rawJSON.modelVersion;
        if (rawJSON?.usageMetadata) merged.usageMetadata = rawJSON.usageMetadata;

        const c0 = rawJSON?.candidates?.[0];
        if (c0) {
          if (c0?.finishReason) candidate.finishReason = c0.finishReason;
          if (c0?.groundingMetadata) candidate.groundingMetadata = c0.groundingMetadata;
          if (c0?.groundingChunks) candidate.groundingChunks = c0.groundingChunks;
          if (c0?.groundingSupports) candidate.groundingSupports = c0.groundingSupports;

          const parts = c0?.content?.parts;
          if (c0?.content?.role) candidate.content.role = c0.content.role;
          if (Array.isArray(parts) && parts.length > 0) {
            candidate.content.parts.push(...parts);
          }
        }
      } catch (err) {
        try {
          const message = err && typeof err === "object" && "message" in err ? err.message : String(err);
          console.error("[ClaudeTransform] V1Internal SSE parse error:", message);
          console.error("[ClaudeTransform] V1Internal SSE data sample:", String(dataStr).slice(0, 2000));
        } catch (_) {}
      }
    }
  }

  return merged;
}

module.exports = {
  readV1InternalSseToJson,
};
