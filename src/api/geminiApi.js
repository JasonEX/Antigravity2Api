const { wrapRequest, unwrapResponse, createUnwrapStream } = require("../transform/gemini");

function headersToObject(headers) {
  const out = {};
  if (!headers || typeof headers.forEach !== "function") return out;
  headers.forEach((value, key) => {
    out[key] = value;
  });
  delete out["content-encoding"];
  delete out["content-length"];
  return out;
}

function isGemini3ProImageModel(modelName) {
  return String(modelName || "").startsWith("gemini-3-pro-image");
}

function getInnerRequest(clientBody) {
  if (clientBody && typeof clientBody.request === "object" && clientBody.request) {
    return clientBody.request;
  }
  return clientBody || {};
}

function getPartThoughtSignature(part) {
  if (!part || typeof part !== "object") return null;
  const sig = part.thoughtSignature ?? part.thought_signature;
  if (typeof sig !== "string") return null;
  const trimmed = sig.trim();
  return trimmed ? trimmed : null;
}

function getInlineData(part) {
  if (!part || typeof part !== "object") return null;
  return part.inlineData || part.inline_data || null;
}

function findMissingModelImageThoughtSignature(innerRequest) {
  const contents = Array.isArray(innerRequest?.contents) ? innerRequest.contents : [];
  for (let contentIndex = 0; contentIndex < contents.length; contentIndex++) {
    const content = contents[contentIndex];
    if (!content || typeof content !== "object") continue;
    const role = typeof content.role === "string" ? content.role.toLowerCase() : "";
    const isModel = role === "model" || role === "assistant";
    if (!isModel) continue;

    const parts = Array.isArray(content.parts) ? content.parts : [];
    for (let partIndex = 0; partIndex < parts.length; partIndex++) {
      const part = parts[partIndex];
      const inlineData = getInlineData(part);
      if (!inlineData) continue;

      const mimeType =
        typeof inlineData?.mimeType === "string"
          ? inlineData.mimeType
          : typeof inlineData?.mime_type === "string"
            ? inlineData.mime_type
            : "";
      const isImage = !mimeType || String(mimeType).toLowerCase().startsWith("image/");
      if (!isImage) continue;

      const sig = getPartThoughtSignature(part);
      if (!sig) {
        return { contentIndex, partIndex };
      }
    }
  }
  return null;
}

class GeminiApi {
  constructor(options = {}) {
    this.auth = options.authManager;
    this.upstream = options.upstreamClient;
    this.logger = options.logger || null;
    this.debugRequestResponse = !!options.debug;
  }

  log(title, data) {
    if (this.logger) {
      if (typeof this.logger.log === "function") {
        return this.logger.log(title, data);
      }
      if (typeof this.logger === "function") {
        return this.logger(title, data);
      }
    }
    if (data !== undefined && data !== null) {
      console.log(`[${title}]`, typeof data === "string" ? data : JSON.stringify(data, null, 2));
    } else {
      console.log(`[${title}]`);
    }
  }

  logDebug(title, data) {
    if (!this.debugRequestResponse) return;
    this.log("debug", `${title}`, data);
  }

  logStream(event, options = {}) {
    if (this.logger && typeof this.logger.logStream === "function") {
      return this.logger.logStream(event, options);
    }
    this.log("stream", { event, ...options });
  }

  async logStreamContent(stream, label) {
    if (!stream) return stream;
    try {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let bufferStr = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunkStr = decoder.decode(value, { stream: true });
        bufferStr += chunkStr;
      }
      if (bufferStr) {
        this.log(`${label}`, bufferStr);
      }
    } catch (err) {
      this.log("warn", `Raw stream log failed for ${label}: ${err.message || err}`);
    }
    return stream;
  }

  async handleListModels() {
    try {
      const remoteModelsMap = await this.auth.fetchAvailableModels();

      const entries = Array.isArray(remoteModelsMap)
        ? remoteModelsMap
        : Object.keys(remoteModelsMap || {}).map((id) => {
            const info = remoteModelsMap[id];
            return typeof info === "object" ? { id, ...info } : { id };
          });

      const models = [];
      for (const entry of entries) {
        const rawId =
          (typeof entry === "object" && (entry.id || entry.name || entry.model)) ||
          (typeof entry === "string" ? entry : null);
        if (!rawId || typeof rawId !== "string") continue;
        if (!rawId.toLowerCase().includes("gemini")) continue;

        const normalizedName = rawId.startsWith("models/") ? rawId : `models/${rawId}`;
        const supportedGenerationMethods =
          entry.supportedGenerationMethods &&
          Array.isArray(entry.supportedGenerationMethods) &&
          entry.supportedGenerationMethods.length > 0
            ? entry.supportedGenerationMethods
            : ["generateContent", "streamGenerateContent"];

        const modelInfo = {
          name: normalizedName,
          displayName: entry.displayName || rawId,
          description: entry.description || entry.reason || entry.message || "",
          supportedGenerationMethods,
        };

        const inputLimit = entry.inputTokenLimit || entry.maxInputTokens || entry.contextWindow || entry.context_window;
        if (inputLimit) {
          modelInfo.inputTokenLimit = inputLimit;
        }

        const outputLimit = entry.outputTokenLimit || entry.maxOutputTokens;
        if (outputLimit) {
          modelInfo.outputTokenLimit = outputLimit;
        }

        models.push(modelInfo);
      }

      return { status: 200, headers: { "Content-Type": "application/json" }, body: { models } };
    } catch (e) {
      return {
        status: 500,
        headers: { "Content-Type": "application/json" },
        body: { error: { message: e.message || e } },
      };
    }
  }

  async handleGetModel(targetName) {
    try {
      const normalized = targetName.startsWith("models/") ? targetName : `models/${targetName}`;
      const models = (await this.handleListModels()).body.models || [];
      const hit = models.find((m) => m.name === normalized);
      if (!hit) {
        return {
          status: 404,
          headers: { "Content-Type": "application/json" },
          body: { error: { message: `Model not found: ${targetName}` } },
        };
      }
      return { status: 200, headers: { "Content-Type": "application/json" }, body: hit };
    } catch (e) {
      return {
        status: 500,
        headers: { "Content-Type": "application/json" },
        body: { error: { message: e.message || e } },
      };
    }
  }

  async handleGenerate(modelName, method, clientBody, queryString = "") {
    try {
      this.logDebug("Gemini Request Raw", clientBody || "(empty body)");

      const clientBodyJson = JSON.stringify(clientBody || {});
      const parsedClientBody = JSON.parse(clientBodyJson);

      // Pre-validate Gemini 3 Pro Image requests: model-generated image parts in history MUST carry thought signatures.
      // Otherwise upstream will reject with: "Image part is missing a thought_signature ..."
      if (isGemini3ProImageModel(modelName)) {
        const innerRequest = getInnerRequest(parsedClientBody);
        const missing = findMissingModelImageThoughtSignature(innerRequest);
        if (missing) {
          const { contentIndex, partIndex } = missing;
          return {
            status: 400,
            headers: { "Content-Type": "application/json" },
            body: {
              error: {
                code: 400,
                status: "INVALID_ARGUMENT",
                message: `Image part is missing a thought_signature in content position ${contentIndex}, part position ${partIndex}.`,
                details: {
                  hint:
                    "You must pass back the exact thoughtSignature/thought_signature from the previous Gemini 3 Pro Image response when including model-generated images in contents history.",
                },
              },
            },
          };
        }
      }

      const quotaProbe = wrapRequest(parsedClientBody, { projectId: "", modelName });
      const modelForQuota = quotaProbe.mappedModelName || modelName;

      let loggedWrapped = false;
      const upstreamResponse = await this.upstream.callV1Internal(method, {
        model: modelForQuota,
        queryString: queryString || "",
        buildBody: (projectId) => {
          const { wrappedBody } = wrapRequest(JSON.parse(clientBodyJson), { projectId, modelName });
          if (!loggedWrapped) {
            this.logDebug("Gemini Request Wrapped", wrappedBody);
            loggedWrapped = true;
          }
          return wrappedBody;
        },
      });

      let responseForClient = upstreamResponse;
      if (this.debugRequestResponse && upstreamResponse.body) {
        try {
          const [logBranch, processBranch] = upstreamResponse.body.tee();
          this.logStreamContent(logBranch, "Gemini Response Raw");
          responseForClient = new Response(processBranch, {
            status: upstreamResponse.status,
            statusText: upstreamResponse.statusText,
            headers: upstreamResponse.headers,
          });
        } catch (e) {
          this.log("Error teeing Gemini native stream for logging", e.message || e);
        }
      }

      if (!responseForClient.ok) {
        return {
          status: responseForClient.status,
          headers: headersToObject(responseForClient.headers),
          body: responseForClient.body,
        };
      }

      const contentType = responseForClient.headers.get("content-type") || "";

      // JSON response: unwrap payload and return JSON object
      if (contentType.includes("application/json")) {
        const jsonPayload = await responseForClient.clone().json();
        const unwrapped = unwrapResponse(jsonPayload);
        this.logDebug("Gemini Response Wrapped", unwrapped);

        const respHeaders = headersToObject(responseForClient.headers);
        if (!respHeaders["content-type"] && !respHeaders["Content-Type"]) {
          respHeaders["Content-Type"] = "application/json";
        }

        return { status: responseForClient.status, headers: respHeaders, body: unwrapped };
      }

      // Stream response: unwrap each SSE line payload
      if (contentType.includes("stream") && responseForClient.body) {
        const stream = createUnwrapStream(responseForClient.body, {
          onChunk: (chunk) => this.logDebug("Gemini Response Wrapped (Stream)", chunk),
        });

        const respHeaders = headersToObject(responseForClient.headers);
        if (!respHeaders["content-type"] && !respHeaders["Content-Type"]) {
          respHeaders["Content-Type"] = "text/event-stream";
        }

        return { status: responseForClient.status, headers: respHeaders, body: stream };
      }

      // Fallback: passthrough raw body as stream if present
      const respHeaders = headersToObject(responseForClient.headers);

      return { status: responseForClient.status, headers: respHeaders, body: responseForClient.body };
    } catch (error) {
      this.log("Error processing Gemini Request Raw", error.message || error);
      return {
        status: 500,
        headers: { "Content-Type": "application/json" },
        body: { error: { message: error.message || error } },
      };
    }
  }

  async handleCountTokens(modelName, clientBody) {
    try {
      const innerRequest =
        clientBody && typeof clientBody.request === "object" && clientBody.request ? clientBody.request : clientBody || {};

      const countTokensBody = {
        request: {
          model: modelName,
          contents: innerRequest.contents || [],
        },
      };

      const response = await this.upstream.countTokens(countTokensBody, { model: modelName });
      if (!response.ok) {
        return {
          status: response.status,
          headers: headersToObject(response.headers),
          body: response.body,
        };
      }

      const json = await response.json().catch(async () => ({ error: await response.text().catch(() => "") }));
      return { status: response.status, headers: { "Content-Type": "application/json" }, body: json };
    } catch (error) {
      return {
        status: 500,
        headers: { "Content-Type": "application/json" },
        body: { error: { message: error.message || error } },
      };
    }
  }
}

module.exports = GeminiApi;
