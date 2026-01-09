const crypto = require("crypto");

const { ensureAntigravitySystemInstruction } = require("./antigravitySystemInstruction");

const DEFAULT_V1INTERNAL_BASE_URLS = [
  "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal",
  "https://daily-cloudcode-pa.googleapis.com/v1internal",
  "https://cloudcode-pa.googleapis.com/v1internal",
];

function normalizeV1InternalBaseUrl(baseUrl) {
  const raw = String(baseUrl || "").trim();
  if (!raw) return "";
  const trimmed = raw.replace(/\/+$/, "");
  if (trimmed.endsWith("/v1internal")) return trimmed;
  return `${trimmed}/v1internal`;
}

function getV1InternalBaseUrlCandidates() {
  const custom =
    process.env.AG2API_V1INTERNAL_BASE_URL ||
    process.env.AG2API_BASE_URL ||
    process.env.V1INTERNAL_BASE_URL;
  if (custom && String(custom).trim()) {
    const normalized = normalizeV1InternalBaseUrl(custom);
    return normalized ? [normalized] : DEFAULT_V1INTERNAL_BASE_URLS;
  }
  return DEFAULT_V1INTERNAL_BASE_URLS;
}

function buildV1InternalUrl(method, queryString = "", baseUrl) {
  const resolvedBaseUrl = baseUrl || DEFAULT_V1INTERNAL_BASE_URLS[0];
  const qs = queryString ? String(queryString) : "";
  return `${resolvedBaseUrl}:${method}${qs}`;
}

// OAuth client configuration: allow env override, fallback to built-in defaults (same as Antigravity2api)
function getOAuthClient() {
  const defaultClientId =
    "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
  const defaultClientSecret = "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";
  const clientId =
    process.env.GOOGLE_OAUTH_CLIENT_ID ||
    process.env.GCP_CLIENT_ID ||
    process.env.CLIENT_ID ||
    defaultClientId;
  const clientSecret =
    process.env.GOOGLE_OAUTH_CLIENT_SECRET ||
    process.env.GCP_CLIENT_SECRET ||
    process.env.CLIENT_SECRET ||
    defaultClientSecret;
  return { clientId, clientSecret };
}

async function waitForApiSlot(limiter) {
  if (limiter && typeof limiter.wait === "function") {
    await limiter.wait();
  }
}

/**
 * Raw v1internal call helper.
 * This is the single place where v1internal is fetched (with base URL fallbacks).
 *
 * @param {string} method - v1internal method name (e.g. "generateContent", "countTokens")
 * @param {string} accessToken
 * @param {object} body
 * @param {object} [options]
 * @param {string} [options.queryString] - Includes leading "?" (e.g. "?alt=sse")
 * @param {object} [options.headers] - Extra headers to merge.
 * @param {any} [options.limiter] - RateLimiter instance (must have wait()).
 * @returns {Promise<Response>}
 */
async function callV1Internal(method, accessToken, body, options = {}) {
  const queryString = options.queryString || "";
  const extraHeaders = options.headers && typeof options.headers === "object" ? options.headers : {};
  const limiter = options.limiter;

  await waitForApiSlot(limiter);

  // Ensure Antigravity defaults for agent requests.
  const needsSystemPrompt = method === "generateContent" || method === "streamGenerateContent";
  if (needsSystemPrompt) {
    if (body && typeof body === "object") {
      if (!body.userAgent) body.userAgent = "antigravity";
      if (!body.requestType) body.requestType = "agent";
      ensureAntigravitySystemInstruction(body);
    }
  }

  const baseUrls = getV1InternalBaseUrlCandidates();
  let last429 = null;
  let lastErr = null;

  for (let i = 0; i < baseUrls.length; i++) {
    const baseUrl = baseUrls[i];
    try {
      const resp = await fetch(buildV1InternalUrl(method, queryString, baseUrl), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
          "User-Agent": "antigravity/1.11.9 windows/amd64",
          ...extraHeaders,
        },
        body: JSON.stringify(body || {}),
      });

      if (resp.status === 429 && i + 1 < baseUrls.length) {
        last429 = resp;
        try {
          resp.body?.cancel();
        } catch (_) {}
        continue;
      }

      return resp;
    } catch (err) {
      lastErr = err;
      if (i + 1 < baseUrls.length) continue;
      throw err;
    }
  }

  if (last429) return last429;
  throw lastErr || new Error("v1internal: no base URL available");
}

async function fetchProjectId(accessToken, limiter) {
  const response = await callV1Internal(
    "loadCodeAssist",
    accessToken,
    { metadata: { ideType: "ANTIGRAVITY" } },
    {
      limiter,
      headers: {
        // Preserve prior behavior.
        "Accept-Encoding": "gzip",
      },
    }
  );

  const rawBody = await response.text().catch(() => "");

  if (!response.ok) {
    throw new Error(
      `Failed to fetch projectId: ${response.status} ${response.statusText} ${rawBody}`.trim()
    );
  }

  let data = {};
  try {
    data = rawBody ? JSON.parse(rawBody) : {};
  } catch (err) {}

  return { projectId: data?.cloudaicompanionProject, rawBody };
}

async function fetchAvailableModels(accessToken, limiter) {
  const response = await callV1Internal("fetchAvailableModels", accessToken, {}, { limiter });

  if (!response.ok) {
    throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return data.models || {};
}

async function fetchUserInfo(accessToken, limiter) {
  try {
    await waitForApiSlot(limiter);
    const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.ok) {
      return await res.json();
    }
  } catch (e) {}
  return null;
}

function resolveRedirectUri(portOrRedirectUri) {
  if (typeof portOrRedirectUri === "string" && portOrRedirectUri.trim()) {
    return portOrRedirectUri.trim();
  }

  if (
    portOrRedirectUri &&
    typeof portOrRedirectUri === "object" &&
    typeof portOrRedirectUri.redirectUri === "string" &&
    portOrRedirectUri.redirectUri.trim()
  ) {
    return portOrRedirectUri.redirectUri.trim();
  }

  const port =
    typeof portOrRedirectUri === "number"
      ? portOrRedirectUri
      : typeof portOrRedirectUri?.port === "number"
        ? portOrRedirectUri.port
        : 50000;
  return `http://localhost:${port}/oauth-callback`;
}

async function exchangeCodeForToken(code, portOrRedirectUri = 50000, limiter) {
  const { clientId, clientSecret } = getOAuthClient();
  const redirectUri = resolveRedirectUri(portOrRedirectUri);
  await waitForApiSlot(limiter);
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      accept: "*/*",
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      "user-agent": "google-api-nodejs-client/10.3.0",
      "x-goog-api-client": "gl-node/22.18.0",
      Host: "oauth2.googleapis.com",
      Connection: "close",
    },
    body: new URLSearchParams({
      client_id: clientId,
      code: code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      client_secret: clientSecret,
    }).toString(),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(`Failed to get token: ${data.error_description || data.error}`);
  }

  // Add expiry timestamp
  data.expiry_date = new Date().getTime() + data.expires_in * 1000 - 1000 * 60;
  delete data.expires_in;

  const userInfo = await fetchUserInfo(data.access_token, limiter);
  const email = userInfo ? userInfo.email : null;

  // Format data to save (keep same shape as current credentials)
  const formattedData = {
    access_token: data.access_token,
    expiry_date: data.expiry_date,
    expires_in: data.expires_in || Math.floor((data.expiry_date - Date.now()) / 1000),
    refresh_token: data.refresh_token || "",
    scope: data.scope,
    token_type: data.token_type,
    id_token: data.id_token || "",
    email: email,
  };

  return formattedData;
}

async function refreshToken(refreshTokenValue, limiter) {
  const { clientId, clientSecret } = getOAuthClient();
  await waitForApiSlot(limiter);
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshTokenValue,
      grant_type: "refresh_token",
    }),
  });

  const data = await response.json();
  if (data.error) {
    throw new Error("Failed to refresh token: " + JSON.stringify(data));
  }

  data.expiry_date = new Date().getTime() + data.expires_in * 1000 - 1000 * 60;
  if (!data.refresh_token) {
    data.refresh_token = refreshTokenValue;
  }
  delete data.expires_in;

  return data;
}

function randomId() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
}

module.exports = {
  getOAuthClient,
  callV1Internal,
  fetchProjectId,
  fetchAvailableModels,
  fetchUserInfo,
  exchangeCodeForToken,
  refreshToken,
  randomId,
};
