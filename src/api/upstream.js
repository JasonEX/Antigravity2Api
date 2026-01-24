const path = require("path");

const httpClient = require("../auth/httpClient");
const QuotaRefresher = require("./QuotaRefresher");
const { ensureLogger } = require("../utils/logger");

function parseEnvNonNegativeInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null) return fallback;
  const n = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

// Fixed delay used for:
// - network error retry
// - 429 without retryDelay (and after account rotation)
// - 429 with retryDelay > 5000ms (after rotation)
const FIXED_RETRY_DELAY_MS = parseEnvNonNegativeInt("AG2API_RETRY_DELAY_MS", 1200);

// First request will wait up to this long for the initial quota refresh to complete.
const INITIAL_QUOTA_WAIT_MS = 3000;

class UpstreamClient {
  constructor(authManager, options = {}) {
    this.auth = authManager;
    this.logger = ensureLogger(options.logger);

    this.quotaRefresher = new QuotaRefresher(this.auth, { logger: this.logger, initialWaitMs: INITIAL_QUOTA_WAIT_MS });
    this.quotaRefresher.start();
  }

  // 上游调用日志
  logUpstream(action, options = {}) {
    return this.logger.logUpstream(action, options);
  }

  // 重试日志
  logRetry(reason, options = {}) {
    return this.logger.logRetry(reason, options);
  }

  // 配额日志
  logQuota(event, options = {}) {
    return this.logger.logQuota(event, options);
  }

  // 错误日志
  logError(message, error, options = {}) {
    return this.logger.logError(message, error, options);
  }

  getMaxAttempts() {
    const n = this.auth && typeof this.auth.getAccountCount === "function" ? this.auth.getAccountCount() : 0;
    return Math.max(1, n || 0);
  }

  getQuotaGroupFromModel(model) {
    const m = String(model || "").toLowerCase();
    if (m.includes("claude")) return "claude";
    if (m.startsWith("gpt-")) return "claude";
    if (m.includes("gemini")) return "gemini";
    return "gemini";
  }

  parseDurationMs(durationStr) {
    if (!durationStr) return null;
    const str = String(durationStr).trim();
    if (!str) return null;

    let totalMs = 0;
    let matched = false;
    const re = /([\d.]+)\s*(ms|s|m|h)/g;
    let m;
    while ((m = re.exec(str)) !== null) {
      matched = true;
      const value = parseFloat(m[1]);
      if (!Number.isFinite(value)) continue;
      const unit = m[2];
      if (unit === "ms") totalMs += value;
      else if (unit === "s") totalMs += value * 1000;
      else if (unit === "m") totalMs += value * 60 * 1000;
      else if (unit === "h") totalMs += value * 60 * 60 * 1000;
    }
    if (!matched) return null;
    return Math.round(totalMs);
  }

  parseRetryDelayMs(errText) {
    const raw = typeof errText === "string" ? errText : "";

    const parseRetryAfterSecondsFromText = (text) => {
      if (typeof text !== "string") return null;
      const m = text.match(/after\s+(\d+(?:\.\d+)?)s\.?/i);
      if (!m) return null;
      const ms = this.parseDurationMs(`${m[1]}s`);
      return ms != null ? ms : null;
    };

    let errObj;
    try {
      errObj = JSON.parse(raw);
    } catch (_) {
      // Fallback: parse from plain text body.
      return parseRetryAfterSecondsFromText(raw);
    }

    const details = errObj.error?.details || [];

    // RetryInfo.retryDelay like "1.203608125s"
    const retryInfo = details.find((d) => d["@type"]?.includes("RetryInfo"));
    if (retryInfo?.retryDelay) {
      const ms = this.parseDurationMs(retryInfo.retryDelay);
      if (ms != null) return ms;
    }

    // quotaResetDelay like "331.167174ms" or "1h16m0.667923083s"
    const metaDelay = details.find((d) => d.metadata?.quotaResetDelay)?.metadata?.quotaResetDelay;
    if (metaDelay) {
      const ms = this.parseDurationMs(metaDelay);
      if (ms != null) return ms;
    }

    // Fallback: parse from error.message "Your quota will reset after Xs."
    const message = errObj.error?.message;
    const msgMs = parseRetryAfterSecondsFromText(message);
    if (msgMs != null) return msgMs;

    return null;
  }

  getAccountKeyFromAccount(account) {
    return account?.keyName || (account?.filePath ? path.basename(account.filePath) : "unknown-account");
  }

  parseErrorDetails(errText) {
    try {
      const errObj = JSON.parse(errText);
      return {
        code: errObj.error?.code,
        message: errObj.error?.message,
        status: errObj.error?.status,
        details: errObj.error?.details,
      };
    } catch (_) {
      return { message: errText };
    }
  }

  sleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      if (timer && typeof timer.unref === "function") timer.unref();
    });
  }

  /**
   * v1internal call with 429 retry + per-model quota group rotation.
   * @param {string} method - v1internal method (e.g. "generateContent")
   * @param {object} options
   * @param {string} [options.group] - "claude" | "gemini" (defaults to inferred from model)
   * @param {string} [options.model] - Used to infer group when group is not provided
   * @param {string} [options.queryString]
   * @param {(projectId: string) => object} options.buildBody
   * @param {object} [options.headers]
   * @returns {Promise<Response>}
   */
  async callV1Internal(method, options = {}) {
    const buildBody = options.buildBody;
    if (typeof buildBody !== "function") {
      throw new Error("UpstreamClient.callV1Internal requires options.buildBody(projectId)");
    }

    const quotaGroup = this.getQuotaGroupFromModel(options.group || options.model);
    const modelId = String(options.model || "").trim();
    const queryString = options.queryString || "";
    const headers = options.headers && typeof options.headers === "object" ? options.headers : {};

    let lastResponse = null;
    let lastNetworkError = null;
    const maxAttempts = this.getMaxAttempts();

    this.logUpstream(`开始调用 v1internal:${method}`, {
      method,
      group: quotaGroup,
      model: modelId || options.model,
      maxAttempts,
    });

    // Best-effort: wait for initial quota refresh so the first request can pick the best account.
    if (modelId && this.quotaRefresher) {
      try {
        await this.quotaRefresher.waitInitialRefresh(INITIAL_QUOTA_WAIT_MS);
      } catch (_) {}
    }

    const triedAccountIndices = new Set();
    let waitedForCooldown = false;
    let attemptNum = 0;

    while (attemptNum < maxAttempts) {
      const now = Date.now();

      let accountIndex;
      if (modelId && this.quotaRefresher) {
        const decision = this.quotaRefresher.pickAccountIndex(modelId, {
          now,
          excludeAccountIndices: triedAccountIndices,
          cooldownWaitThresholdMs: 5000,
        });

        if (decision?.kind === "wait") {
          if (waitedForCooldown) {
            const cached = this.quotaRefresher.getCachedErrorResponse(modelId);
            if (cached) return cached;
            if (lastResponse) return lastResponse;
            if (lastNetworkError) throw lastNetworkError;
            throw new Error(`All accounts are in cooldown for model ${modelId}`);
          }

          waitedForCooldown = true;
          const waitMs = Math.max(0, Number(decision.waitMs) || 0);
          this.logRetry("所有账户冷却中，等待后重试", {
            attempt: attemptNum + 1,
            maxAttempts,
            delayMs: waitMs,
            nextAction: "等待冷却结束后重新选择账户",
          });
          await this.sleep(waitMs);
          triedAccountIndices.clear();
          continue;
        }

        if (decision?.kind === "fast_fail") {
          if (decision.response) return decision.response;
          const cached = this.quotaRefresher.getCachedErrorResponse(modelId);
          if (cached) return cached;
          if (lastResponse) return lastResponse;
          if (lastNetworkError) throw lastNetworkError;
          throw new Error(`No accounts available for model ${modelId}`);
        }

        if (decision?.kind !== "pick" || !Number.isInteger(decision.accountIndex)) {
          const cached = this.quotaRefresher.getCachedErrorResponse(modelId);
          if (cached) return cached;
          if (lastResponse) return lastResponse;
          if (lastNetworkError) throw lastNetworkError;
          throw new Error(`Failed to pick an account for model ${modelId}`);
        }

        accountIndex = decision.accountIndex;
      } else {
        accountIndex = this.auth?.getCurrentAccountIndex ? this.auth.getCurrentAccountIndex(quotaGroup) : 0;
      }

      triedAccountIndices.add(accountIndex);
      attemptNum++;

      if (this.auth?.setCurrentAccountIndex && modelId) {
        this.auth.setCurrentAccountIndex(quotaGroup, accountIndex);
      }

      let creds;
      try {
        creds = await this.auth.getCredentialsByIndex(accountIndex, quotaGroup);
      } catch (e) {
        this.logError(`获取凭证失败 [${quotaGroup}]`, e, { attempt: attemptNum, maxAttempts });
        throw e;
      }

      const accountName = this.getAccountKeyFromAccount(creds.account);
      const requestBody = buildBody(creds.projectId);
      let startTime = Date.now();

      this.logUpstream(`发送请求`, {
        method,
        account: accountName,
        group: quotaGroup,
        attempt: attemptNum,
        maxAttempts,
        model: modelId || options.model,
      });

      let response;
      try {
        response = await httpClient.callV1Internal(method, creds.accessToken, requestBody, {
          queryString,
          headers,
          limiter: this.auth.apiLimiter,
        });
      } catch (netErr) {
        const duration = Date.now() - startTime;
        lastNetworkError = netErr;

        this.logError(`网络错误`, netErr, {
          context: {
            method: `v1internal:${method}`,
            group: quotaGroup,
            account: accountName,
            attempt: attemptNum,
            maxAttempts,
            duration,
          },
        });

        if (maxAttempts === 1) {
          this.logRetry("网络错误，等待重试", {
            attempt: attemptNum,
            maxAttempts,
            delayMs: FIXED_RETRY_DELAY_MS,
            account: accountName,
            error: netErr.message || netErr,
            nextAction: "同账户重试",
          });

          await this.sleep(FIXED_RETRY_DELAY_MS);

          startTime = Date.now();
          try {
            response = await httpClient.callV1Internal(method, creds.accessToken, requestBody, {
              queryString,
              headers,
              limiter: this.auth.apiLimiter,
            });
          } catch (netErr2) {
            const retryDuration = Date.now() - startTime;
            lastNetworkError = netErr2;
            this.logError(`重试时网络错误`, netErr2, {
              context: {
                method: `v1internal:${method}`,
                group: quotaGroup,
                account: accountName,
                attempt: attemptNum,
                maxAttempts,
                duration: retryDuration,
              },
            });
            throw netErr2;
          }
        } else {
          this.logRetry("网络错误，切换账户重试", {
            attempt: attemptNum,
            maxAttempts,
            delayMs: FIXED_RETRY_DELAY_MS,
            account: accountName,
            error: netErr.message || netErr,
            nextAction: "轮换到下一个账户",
          });

          await this.sleep(FIXED_RETRY_DELAY_MS);
          continue;
        }
      }

      const duration = Date.now() - startTime;

      if (response.ok) {
        this.logUpstream(`请求成功`, {
          method,
          account: accountName,
          group: quotaGroup,
          attempt: attemptNum,
          maxAttempts,
          status: response.status,
          duration,
        });
        return response;
      }

      if (modelId && this.quotaRefresher) {
        await this.quotaRefresher.cacheLastErrorResponse(modelId, response);
      }

      // Non-429 4xx: do not retry/rotate, pass through as-is.
      if (response.status !== 429) {
        let errorText = "";
        try {
          errorText = await response.clone().text();
        } catch (_) {}

        const errorDetails = this.parseErrorDetails(errorText);
        
        this.logUpstream(`请求失败 (${response.status})`, {
          method,
          account: accountName,
          group: quotaGroup,
          attempt: attemptNum,
          maxAttempts,
          status: response.status,
          duration,
          error: errorDetails,
        });
        return response;
      }

      lastResponse = response;

      // 429: decide short-wait retry vs rotate.
      let errorText = "";
      try {
        errorText = await response.clone().text();
      } catch (_) {}

      const errorDetails = this.parseErrorDetails(errorText);
      let retryMs = this.parseRetryDelayMs(errorText);

      this.logQuota(`收到 429 限流响应`, {
        account: accountName,
        group: quotaGroup,
        resetDelay: retryMs,
      });

      this.logger.log("error", `🚫 Google API 429 错误详情`, errorDetails);

      if (modelId && this.quotaRefresher) {
        const cooldownUntil = now + (retryMs != null ? Math.max(0, retryMs) : FIXED_RETRY_DELAY_MS);
        this.quotaRefresher.setCooldownUntil(modelId, accountName, cooldownUntil);
      }

      if (maxAttempts === 1) {
        if (retryMs != null && retryMs > 5000) {
          // Long cooldown: do not wait, just return the 429 as-is.
          return response;
        }

        const delay = retryMs == null ? FIXED_RETRY_DELAY_MS : Math.max(0, retryMs + 200);
        const reason = retryMs == null ? "429 无重试信息，延迟后同账户重试" : "短时间限流，延迟后同账户重试";
        this.logRetry(reason, {
          attempt: attemptNum,
          maxAttempts,
          delayMs: delay,
          account: accountName,
          nextAction: "同账户重试",
        });

        await this.sleep(delay);

        startTime = Date.now();
        let retryResp;
        try {
          retryResp = await httpClient.callV1Internal(method, creds.accessToken, requestBody, {
            queryString,
            headers,
            limiter: this.auth.apiLimiter,
          });
        } catch (netErr2) {
          const retryDuration = Date.now() - startTime;
          lastNetworkError = netErr2;
          this.logError(`重试时网络错误`, netErr2, {
            context: {
              method: `v1internal:${method}`,
              group: quotaGroup,
              account: accountName,
              attempt: attemptNum,
              maxAttempts,
              duration: retryDuration,
            },
          });
          throw netErr2;
        }

        const retryDuration = Date.now() - startTime;
        if (retryResp.ok) {
          this.logUpstream(`重试成功`, {
            method,
            account: accountName,
            group: quotaGroup,
            attempt: attemptNum,
            maxAttempts,
            status: retryResp.status,
            duration: retryDuration,
          });
          return retryResp;
        }

        if (modelId && this.quotaRefresher) {
          await this.quotaRefresher.cacheLastErrorResponse(modelId, retryResp);
        }

        if (retryResp.status !== 429) {
          this.logUpstream(`重试返回非 429 错误`, {
            method,
            account: accountName,
            group: quotaGroup,
            attempt: attemptNum,
            maxAttempts,
            status: retryResp.status,
            duration: retryDuration,
          });
          return retryResp;
        }

        lastResponse = retryResp;
        return retryResp;
      }

      if (retryMs == null) {
        this.logRetry("429 无重试信息，延迟后切换账户", {
          attempt: attemptNum,
          maxAttempts,
          delayMs: FIXED_RETRY_DELAY_MS,
          account: accountName,
          nextAction: "延迟后轮换到下一个账户",
        });
        await this.sleep(FIXED_RETRY_DELAY_MS);
      } else {
        this.logRetry("429 可解析重试信息，立即切换账户", {
          attempt: attemptNum,
          maxAttempts,
          delayMs: retryMs,
          account: accountName,
          nextAction: "立即轮换到下一个账户",
        });
      }
    }

    if (lastResponse) {
      this.logError(`所有账户都已耗尽`, null, {
        context: {
          method: `v1internal:${method}`,
          group: quotaGroup,
          totalAttempts: maxAttempts,
          model: modelId || options.model,
        },
      });
      return lastResponse;
    }

    if (lastNetworkError) {
      throw lastNetworkError;
    }

    const cached = modelId && this.quotaRefresher ? this.quotaRefresher.getCachedErrorResponse(modelId) : null;
    if (cached) return cached;

    const error = new Error(`Upstream call exhausted without a response (v1internal:${method})`);
    error.status = 500;
    this.logError(`上游调用失败`, error, {
      context: { method: `v1internal:${method}`, group: quotaGroup, model: modelId || options.model },
    });
    throw error;
  }

  async fetchAvailableModels() {
    const { accessToken, projectId } = await this.auth.getCredentials();
    this.logger.log("info", `📋 获取可用模型列表 (projectId: ${projectId || "none"})`);
    return httpClient.fetchAvailableModels(accessToken, this.auth.apiLimiter, projectId);
  }

  async fetchAvailableModelsByAccountIndex(accountIndex) {
    if (!this.quotaRefresher) {
      throw new Error("QuotaRefresher not initialized");
    }
    return this.quotaRefresher.fetchModelsByAccountIndex(accountIndex);
  }

  /**
   * v1internal:countTokens with 429 rotation policy (final 429 passthrough).
   * @param {object} body - Raw countTokens request body (typically { request: { model, contents } })
   * @param {object} [options]
   * @param {string} [options.group]
   * @param {string} [options.model]
   * @returns {Promise<Response>}
   */
  async countTokens(body, options = {}) {
    const inferredModel = options.model || body?.request?.model || body?.model;
    this.logger.log("info", `🔢 计算 Token 数量 (${inferredModel || "unknown model"})`);
    return this.callV1Internal("countTokens", {
      group: options.group,
      model: inferredModel,
      buildBody: () => body || {},
    });
  }
}

module.exports = UpstreamClient;
