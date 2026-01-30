const crypto = require("crypto");

const DEFAULT_V1INTERNAL_BASE_URLS = [
  "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal",
  "https://daily-cloudcode-pa.googleapis.com/v1internal",
  "https://cloudcode-pa.googleapis.com/v1internal",
];

const DEFAULT_CLOUDCODE_BASE_URLS = [
  "https://cloudcode-pa.googleapis.com",
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
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

function getCloudCodeBaseUrls() {
  const raw = process.env.AG2API_CLOUDCODE_BASE_URLS;
  if (raw && String(raw).trim()) {
    const urls = String(raw)
      .split(",")
      .map((u) => String(u || "").trim())
      .filter(Boolean);
    if (urls.length > 0) return urls;
  }
  return DEFAULT_CLOUDCODE_BASE_URLS;
}

function buildCloudCodeUrl(baseUrl, method, queryString = "") {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "");
  const qs = queryString ? String(queryString) : "";
  return `${base}/v1internal:${method}${qs}`;
}

function shouldTryNextCloudCodeEndpoint(status) {
  const code = Number.isFinite(status) ? status : null;
  if (code === null) return true;
  if (code === 404 || code === 408 || code === 429) return true;
  return code >= 500 && code <= 599;
}

const CLOUDCODE_METADATA = {
  ideType: "ANTIGRAVITY",
  platform: "PLATFORM_UNSPECIFIED",
  pluginType: "GEMINI",
};

function resolveAntigravityVersion() {
  const raw = process.env.AG2API_ANTIGRAVITY_VERSION;
  const v = typeof raw === "string" ? raw.trim() : "";
  return v;
}

function buildDefaultAntigravityUserAgent(version) {
  let platform = typeof process.platform === "string" ? process.platform : "linux";
  if (platform === "win32") platform = "windows";

  let arch = typeof process.arch === "string" ? process.arch : "amd64";
  if (arch === "x64") arch = "amd64";

  return `antigravity/${version} ${platform}/${arch}`;
}

function resolveAntigravityUserAgent() {
  const raw = process.env.AG2API_ANTIGRAVITY_USER_AGENT || process.env.AG2API_USER_AGENT;
  const ua = typeof raw === "string" ? raw.trim() : "";
  return ua || buildDefaultAntigravityUserAgent(resolveAntigravityVersion());
}

function extractProjectId(cloudaicompanionProject) {
  if (typeof cloudaicompanionProject === "string") {
    const trimmed = cloudaicompanionProject.trim();
    return trimmed ? trimmed : null;
  }

  if (cloudaicompanionProject && typeof cloudaicompanionProject === "object") {
    const id = cloudaicompanionProject.id;
    if (typeof id === "string") {
      const trimmed = id.trim();
      return trimmed ? trimmed : null;
    }
  }

  return null;
}

function pickOnboardTier(allowedTiers) {
  const tiers = Array.isArray(allowedTiers) ? allowedTiers : [];

  const defaultTier = tiers.find((tier) => {
    if (!tier || typeof tier !== "object") return false;
    if (!tier.isDefault) return false;
    return typeof tier.id === "string" && tier.id.trim();
  });
  if (defaultTier?.id) return String(defaultTier.id).trim();

  const firstTier = tiers.find((tier) => tier && typeof tier.id === "string" && tier.id.trim());
  if (firstTier?.id) return String(firstTier.id).trim();

  // Match vscode-antigravity-cockpit behavior.
  if (tiers.length > 0) return "LEGACY";

  return null;
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (timer && typeof timer.unref === "function") timer.unref();
  });
}

// OAuth client configuration: allow env override, fallback to built-in defaults (same as Antigravity2api)
function getOAuthClient() {
  const defaultClientId = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
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
          "User-Agent": resolveAntigravityUserAgent(),
          "Accept-Encoding": "gzip",
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

async function requestJson(method, accessToken, body, options = {}) {
  const limiter = options.limiter;
  const queryString = options.queryString || "";
  const extraHeaders = options.headers && typeof options.headers === "object" ? options.headers : {};

  const response = await callV1Internal(method, accessToken, body, { limiter, queryString, headers: extraHeaders });
  const text = await response.text().catch(() => "");
  let data = null;
  try {
    data = text ? JSON.parse(text) : {};
  } catch (_) {
    data = {};
  }
  return { response, text, data };
}

async function tryOnboardUser(accessToken, tierId, limiter, options = {}) {
  const maxAttempts = Number.isInteger(options.maxAttempts) ? options.maxAttempts : 3;
  const delayMs = Number.isFinite(options.delayMs) ? options.delayMs : 1000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { response, data, text } = await requestJson(
      "onboardUser",
      accessToken,
      { tierId, metadata: CLOUDCODE_METADATA },
      { limiter },
    );

    if (!response.ok) {
      throw new Error(`onboardUser failed: ${response.status} ${response.statusText} ${text}`.trim());
    }

    if (data?.done) {
      return extractProjectId(data?.response?.cloudaicompanionProject);
    }

    if (attempt < maxAttempts) {
      await sleep(delayMs);
    }
  }

  return null;
}

/**
 * Resolve projectId from Cloud Code.
 *
 * Strategy (matches vscode-antigravity-cockpit-main):
 * 1) call loadCodeAssist -> read cloudaicompanionProject (string or {id})
 * 2) if missing, pick tier from allowedTiers/currentTier/paidTier and call onboardUser until done
 * 3) retry the whole flow up to maxAttempts
 *
 * @param {string} accessToken
 * @param {any} limiter
 * @param {object} [options]
 * @param {number} [options.maxAttempts]
 * @param {object} [options.onboard]
 * @returns {Promise<string>}
 */
async function fetchProjectId(accessToken, limiter, options = {}) {
  const maxAttempts = Number.isInteger(options.maxAttempts) ? options.maxAttempts : 3;
  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { response, data, text } = await requestJson(
        "loadCodeAssist",
        accessToken,
        { metadata: CLOUDCODE_METADATA },
        { limiter },
      );

      if (!response.ok) {
        throw new Error(`loadCodeAssist failed: ${response.status} ${response.statusText} ${text}`.trim());
      }

      const projectId = extractProjectId(data?.cloudaicompanionProject);
      if (projectId) {
        return projectId;
      }

      const tierIdRaw = data?.paidTier?.id || data?.currentTier?.id;
      const tierId = tierIdRaw ? String(tierIdRaw).trim() : "";
      const onboardTier = pickOnboardTier(data?.allowedTiers) || tierId;
      if (!onboardTier) {
        throw new Error("loadCodeAssist returned no projectId and no tierId/allowedTiers to onboard");
      }

      const onboarded = await tryOnboardUser(accessToken, onboardTier, limiter, options.onboard);
      if (onboarded) {
        return onboarded;
      }

      throw new Error("loadCodeAssist/onboardUser did not return a projectId");
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw new Error(`Failed to resolve projectId after ${maxAttempts} attempts: ${lastErr?.message || "unknown error"}`);
}

async function fetchAvailableModels(accessToken, limiter, projectId) {
  await waitForApiSlot(limiter);
  // Pass projectId to get real quota data (not default 100%)
  const payload = projectId ? { project: projectId } : {};
  const baseUrls = getCloudCodeBaseUrls();
  let lastErr = null;

  for (let i = 0; i < baseUrls.length; i++) {
    const baseUrl = baseUrls[i];
    try {
      const response = await fetch(buildCloudCodeUrl(baseUrl, "fetchAvailableModels"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
          "User-Agent": resolveAntigravityUserAgent(),
        },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        const data = await response.json().catch(() => ({}));
        return data.models || {};
      }

      const text = await response.text().catch(() => "");
      const err = new Error(
        `Failed to fetch models: ${response.status} ${response.statusText}${text ? ` ${text}` : ""}`.trim(),
      );
      err.status = response.status;
      lastErr = err;

      if (i < baseUrls.length - 1 && shouldTryNextCloudCodeEndpoint(response.status)) {
        continue;
      }
      throw err;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (i < baseUrls.length - 1) {
        continue;
      }
      throw lastErr;
    }
  }

  throw lastErr || new Error("Failed to fetch models");
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
