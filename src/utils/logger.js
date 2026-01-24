const fs = require("fs");
const path = require("path");
const util = require("util");

// ANSI 颜色代码
const Colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  
  // 前景色
  black: "\x1b[30m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
  
  // 亮色
  brightRed: "\x1b[91m",
  brightGreen: "\x1b[92m",
  brightYellow: "\x1b[93m",
  brightBlue: "\x1b[94m",
  brightMagenta: "\x1b[95m",
  brightCyan: "\x1b[96m",
  
  // 背景色
  bgRed: "\x1b[41m",
  bgGreen: "\x1b[42m",
  bgYellow: "\x1b[43m",
  bgBlue: "\x1b[44m",
  bgMagenta: "\x1b[45m",
  bgCyan: "\x1b[46m",
};

// 日志级别配置
const LogLevels = {
  debug: { priority: 0, icon: "🔍", color: Colors.gray, label: "DEBUG" },
  info: { priority: 1, icon: "ℹ️ ", color: Colors.cyan, label: "INFO" },
  success: { priority: 1, icon: "✅", color: Colors.green, label: "SUCCESS" },
  warn: { priority: 2, icon: "⚠️ ", color: Colors.yellow, label: "WARN" },
  error: { priority: 3, icon: "❌", color: Colors.red, label: "ERROR" },
  fatal: { priority: 4, icon: "💀", color: Colors.brightRed, label: "FATAL" },
  
  // 特殊日志类型
  request: { priority: 1, icon: "📤", color: Colors.blue, label: "REQUEST" },
  response: { priority: 1, icon: "📥", color: Colors.green, label: "RESPONSE" },
  upstream: { priority: 1, icon: "🔗", color: Colors.magenta, label: "UPSTREAM" },
  retry: { priority: 2, icon: "🔄", color: Colors.yellow, label: "RETRY" },
  account: { priority: 1, icon: "👤", color: Colors.cyan, label: "ACCOUNT" },
  quota: { priority: 2, icon: "📊", color: Colors.yellow, label: "QUOTA" },
  stream: { priority: 0, icon: "📡", color: Colors.gray, label: "STREAM" },
};

// 边框字符
const Box = {
  topLeft: "┌",
  topRight: "┐",
  bottomLeft: "└",
  bottomRight: "┘",
  horizontal: "─",
  vertical: "│",
  teeRight: "├",
  teeLeft: "┤",
};

function ensureDir(dirPath) {
  if (fs.existsSync(dirPath)) return;
  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch (err) {
    console.error("Failed to create log directory:", err);
  }
}

function normalizeRetentionDays(value, fallbackDays) {
  if (value === undefined || value === null || value === "") return fallbackDays;
  const n = Number.parseInt(String(value).trim(), 10);
  if (!Number.isFinite(n) || n < 0) return fallbackDays;
  return n;
}

async function cleanupOldLogs(logDir, retentionDays) {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return { deleted: 0, scanned: 0 };

  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let entries = [];
  try {
    entries = await fs.promises.readdir(logDir, { withFileTypes: true });
  } catch {
    return { deleted: 0, scanned: 0 };
  }

  let scanned = 0;
  let deleted = 0;

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".log")) continue;
    scanned++;

    const filePath = path.join(logDir, entry.name);
    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.mtimeMs >= cutoffMs) continue;
      await fs.promises.unlink(filePath);
      deleted++;
    } catch {
      // ignore (locked file / permission / race)
    }
  }

  return { deleted, scanned };
}

function formatTimestamp() {
  const now = new Date();
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");
  const ms = String(now.getMilliseconds()).padStart(3, "0");
  return `${hours}:${minutes}:${seconds}.${ms}`;
}

function formatFullTimestamp() {
  return new Date().toISOString();
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = ((ms % 60000) / 1000).toFixed(1);
  return `${minutes}m ${seconds}s`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

function truncateString(str, maxLen = 200) {
  if (!str || str.length <= maxLen) return str;
  return str.substring(0, maxLen) + `... (${str.length - maxLen} more chars)`;
}

function formatLogContent(data, options = {}) {
  const { indent = 2, maxDepth = 4, compact = false } = options;
  
  if (data instanceof Error) {
    const payload = {
      name: data.name,
      message: data.message,
      ...(data.stack ? { stack: data.stack } : {}),
    };
    return JSON.stringify(payload, null, compact ? 0 : indent);
  }

  if (typeof data === "string") {
    try {
      const parsed = JSON.parse(data);
      return JSON.stringify(parsed, null, compact ? 0 : indent);
    } catch (e) {
      return data;
    }
  }
  if (data !== undefined && data !== null) {
    try {
      return JSON.stringify(data, null, compact ? 0 : indent);
    } catch (e) {
      return String(data);
    }
  }
  return "";
}

function createBoxedMessage(title, content, options = {}) {
  const { width = 80, color = Colors.cyan } = options;
  const lines = [];
  
  const titleLine = ` ${title} `;
  const paddingLen = Math.max(0, width - titleLine.length - 2);
  const leftPad = Math.floor(paddingLen / 2);
  const rightPad = paddingLen - leftPad;
  
  lines.push(
    `${color}${Box.topLeft}${Box.horizontal.repeat(leftPad)}${Colors.bold}${titleLine}${Colors.reset}${color}${Box.horizontal.repeat(rightPad)}${Box.topRight}${Colors.reset}`
  );
  
  if (content) {
    const contentLines = content.split("\n");
    for (const line of contentLines) {
      const truncated = line.length > width - 4 ? line.substring(0, width - 7) + "..." : line;
      const padRight = Math.max(0, width - truncated.length - 4);
      lines.push(`${color}${Box.vertical}${Colors.reset} ${truncated}${" ".repeat(padRight)} ${color}${Box.vertical}${Colors.reset}`);
    }
  }
  
  lines.push(`${color}${Box.bottomLeft}${Box.horizontal.repeat(width - 2)}${Box.bottomRight}${Colors.reset}`);
  
  return lines.join("\n");
}

function createSeparator(char = "─", length = 60, color = Colors.gray) {
  return `${color}${char.repeat(length)}${Colors.reset}`;
}

const CONSOLE_CAPTURE_STATE_KEY = "__AG2API_CONSOLE_CAPTURE_STATE__";

function attachConsoleCaptureToLogFile(logFile, rawConsole) {
  if (!logFile) return;

  const g = globalThis;
  const state =
    (g[CONSOLE_CAPTURE_STATE_KEY] && typeof g[CONSOLE_CAPTURE_STATE_KEY] === "object"
      ? g[CONSOLE_CAPTURE_STATE_KEY]
      : null) || { installed: false, logFile: null };

  state.logFile = logFile;
  g[CONSOLE_CAPTURE_STATE_KEY] = state;

  if (state.installed) return;
  state.installed = true;

  const errOut = (rawConsole && typeof rawConsole.error === "function" ? rawConsole.error : rawConsole?.log) || (() => {});
  const safeWrite = (level, args) => {
    try {
      const target = g[CONSOLE_CAPTURE_STATE_KEY]?.logFile;
      if (!target) return;
      const text = util.format(...(Array.isArray(args) ? args : [args]));
      const line = `[${new Date().toISOString()}] [CONSOLE.${level}] ${text}\n`;
      fs.appendFile(target, line, (err) => {
        if (err) errOut("Failed to write captured console output:", err);
      });
    } catch (e) {
      errOut("Failed to capture console output:", e);
    }
  };

  const raw = {
    log: (rawConsole && typeof rawConsole.log === "function" ? rawConsole.log : console.log).bind(console),
    info: (rawConsole && typeof rawConsole.info === "function" ? rawConsole.info : console.info || console.log).bind(console),
    warn: (rawConsole && typeof rawConsole.warn === "function" ? rawConsole.warn : console.warn || console.log).bind(console),
    error: (rawConsole && typeof rawConsole.error === "function" ? rawConsole.error : console.error || console.log).bind(console),
    debug: (rawConsole && typeof rawConsole.debug === "function" ? rawConsole.debug : console.debug || console.log).bind(console),
  };

  console.log = (...args) => {
    raw.log(...args);
    safeWrite("LOG", args);
  };
  console.info = (...args) => {
    raw.info(...args);
    safeWrite("INFO", args);
  };
  console.warn = (...args) => {
    raw.warn(...args);
    safeWrite("WARN", args);
  };
  console.error = (...args) => {
    raw.error(...args);
    safeWrite("ERROR", args);
  };
  console.debug = (...args) => {
    raw.debug(...args);
    safeWrite("DEBUG", args);
  };
}

/**
 * 创建增强的日志记录器
 */
function createLogger(options = {}) {
  const rawConsole = {
    log: typeof console.log === "function" ? console.log.bind(console) : () => {},
    info: typeof console.info === "function" ? console.info.bind(console) : null,
    warn: typeof console.warn === "function" ? console.warn.bind(console) : null,
    error: typeof console.error === "function" ? console.error.bind(console) : null,
    debug: typeof console.debug === "function" ? console.debug.bind(console) : null,
  };

  const logDir = options.logDir || path.resolve(process.cwd(), "log");
  ensureDir(logDir);

  const retentionDays = normalizeRetentionDays(
    options.retentionDays ?? options.logRetentionDays ?? options.retention_days,
    3
  );

  // Reuse retentionDays for rotation (no extra env vars):
  // - When retention is enabled (>0), rotate every N days.
  // - On rotation, delete older log files (keep only the new log).
  const rotationPeriodMs = retentionDays > 0 ? retentionDays * 24 * 60 * 60 * 1000 : null;
  let lastRotationAtMs = Date.now();
  let rotationInProgress = false;

  const formatDateKey = (date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

  const formatLogFileName = (date, sequence) => {
    const base = `${formatDateKey(date)}_${String(date.getHours()).padStart(2, "0")}-${String(date.getMinutes()).padStart(
      2
    )}-${String(date.getSeconds()).padStart(2, "0")}`;
    const suffix = sequence > 0 ? `_${String(sequence).padStart(3, "0")}` : "";
    return `${base}${suffix}.log`;
  };

  const pickLogFilePath = (date) => {
    for (let seq = 0; seq < 1000; seq++) {
      const filePath = path.join(logDir, formatLogFileName(date, seq));
      if (!fs.existsSync(filePath)) return filePath;
    }
    // Fallback: should be practically unreachable.
    return path.join(logDir, formatLogFileName(date, Math.floor(Math.random() * 1000) + 1));
  };

  let currentLogFile = pickLogFilePath(new Date());

  const purgeOtherLogs = async () => {
    const keepPath = path.resolve(currentLogFile);
    let entries = [];
    try {
      entries = await fs.promises.readdir(logDir, { withFileTypes: true });
    } catch {
      return;
    }

    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isFile()) return;
        if (!entry.name.endsWith(".log")) return;

        const filePath = path.resolve(path.join(logDir, entry.name));
        if (filePath === keepPath) return;

        try {
          await fs.promises.unlink(filePath);
        } catch {
          // ignore (locked file / permission / race)
        }
      })
    );
  };

  const rotateLogFile = (reason) => {
    const now = new Date();
    currentLogFile = pickLogFilePath(now);
    attachConsoleCaptureToLogFile(currentLogFile, rawConsole);

    // Emit a small marker so operators can see rotation boundaries.
    console.log(`${Colors.gray}[${formatTimestamp()}]${Colors.reset} ${Colors.cyan}🌀${Colors.reset} 日志轮转 (${reason}) -> ${currentLogFile}`);

    // Best-effort: purge old logs shortly after switching the target file.
    const timer = setTimeout(() => {
      purgeOtherLogs().catch(() => {});
    }, 1500);
    if (typeof timer.unref === "function") timer.unref();
  };

  attachConsoleCaptureToLogFile(currentLogFile, rawConsole);
  
  const minLevel = options.minLevel || "debug";
  const minPriority = (LogLevels[minLevel] || LogLevels.debug).priority;

  // 请求计数器和统计
  const stats = {
    requests: 0,
    responses: 0,
    errors: 0,
    retries: 0,
    upstreamCalls: 0,
    startTime: Date.now(),
  };

  console.log(`${Colors.cyan}${Box.topLeft}${Box.horizontal.repeat(58)}${Box.topRight}${Colors.reset}`);
  console.log(`${Colors.cyan}${Box.vertical}${Colors.reset}  ${Colors.bold}📝 日志系统初始化${Colors.reset}${" ".repeat(39)}${Colors.cyan}${Box.vertical}${Colors.reset}`);
  console.log(
    `${Colors.cyan}${Box.vertical}${Colors.reset}  ${Colors.gray}文件: ${currentLogFile}${Colors.reset}${" ".repeat(
      Math.max(0, 56 - 7 - currentLogFile.length)
    )}${Colors.cyan}${Box.vertical}${Colors.reset}`
  );
  console.log(`${Colors.cyan}${Box.bottomLeft}${Box.horizontal.repeat(58)}${Box.bottomRight}${Colors.reset}`);

  // 日志清理
  if (retentionDays > 0) {
    cleanupOldLogs(logDir, retentionDays)
      .then(({ deleted }) => {
        if (deleted > 0) {
          console.log(`${Colors.gray}[${formatTimestamp()}]${Colors.reset} ${Colors.yellow}🧹${Colors.reset} 已清理 ${Colors.bold}${deleted}${Colors.reset} 个过期日志文件 (保留 ${retentionDays} 天)`);
        }
      })
      .catch(() => {});

    const intervalMs = options.cleanupIntervalMs ?? 12 * 60 * 60 * 1000;
    const timer = setInterval(() => {
      cleanupOldLogs(logDir, retentionDays).catch(() => {});
    }, intervalMs);
    if (typeof timer.unref === "function") timer.unref();
  }

  const maybeRotate = (reason) => {
    if (!rotationPeriodMs) return;
    const nowMs = Date.now();
    if (nowMs - lastRotationAtMs < rotationPeriodMs) return;
    if (rotationInProgress) return;

    rotationInProgress = true;
    try {
      lastRotationAtMs = nowMs;
      rotateLogFile(reason);
    } finally {
      rotationInProgress = false;
    }
  };

  if (rotationPeriodMs) {
    const MAX_TIMEOUT_MS = 2 ** 31 - 1;
    const scheduleNextRotation = () => {
      const elapsed = Date.now() - lastRotationAtMs;
      const remaining = rotationPeriodMs - elapsed;
      const delayMs = Math.min(Math.max(1000, remaining), MAX_TIMEOUT_MS);
      const timer = setTimeout(() => {
        try {
          maybeRotate("retention");
        } finally {
          scheduleNextRotation();
        }
      }, delayMs);
      if (typeof timer.unref === "function") timer.unref();
    };

    scheduleNextRotation();
  }

  /**
   * 核心日志函数
   * 兼容调用方式：
   * - log(level, message, meta)（新）
   * - log(title, data)（旧，常见于历史代码）
   */
  const toPlainError = (err) => ({
    name: err?.name,
    message: err?.message,
    ...(err?.stack ? { stack: err.stack } : {}),
  });

  const isKnownLevel = (value) => {
    if (typeof value !== "string") return false;
    return Object.prototype.hasOwnProperty.call(LogLevels, value);
  };

  const pickMessageFromMeta = (value) => {
    if (!value || typeof value !== "object") return "";
    if (value instanceof Error) return value.message || "Error";
    const keys = ["message", "action", "event", "reason", "name", "type"];
    for (const k of keys) {
      const v = value[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return "";
  };

  const normalizeLogArgs = (rawArgs) => {
    const [a0, a1, a2] = rawArgs;

    // New signature: log(level, message, meta)
    if (rawArgs.length >= 3 && isKnownLevel(a0)) {
      const msg = typeof a1 === "string" ? a1 : a1 != null ? String(a1) : "";
      const meta = a2 instanceof Error ? toPlainError(a2) : a2 ?? null;
      return { level: a0, message: msg, meta };
    }

    // Legacy signature: log(title, data)
    if (!isKnownLevel(a0)) {
      const title = a0 != null ? String(a0) : "";
      if (rawArgs.length >= 3) {
        return { level: "info", message: title, meta: { data: a1, meta: a2 } };
      }
      const meta = a1 instanceof Error ? toPlainError(a1) : a1 ?? null;
      return { level: "info", message: title, meta };
    }

    // Known level with (level, message) or (level, meta)
    const level = a0;
    if (typeof a1 === "string") {
      return { level, message: a1, meta: null };
    }
    if (a1 instanceof Error) {
      return { level, message: a1.message || "Error", meta: toPlainError(a1) };
    }
    if (a1 && typeof a1 === "object") {
      const msg = pickMessageFromMeta(a1);
      return { level, message: msg, meta: a1 };
    }
    return { level, message: a1 != null ? String(a1) : "", meta: null };
  };

  const log = (...args) => {
    const { level, message, meta } = normalizeLogArgs(args);
    const levelConfig = LogLevels[level] || LogLevels.info;
    
    // 过滤低优先级日志
    if (levelConfig.priority < minPriority) return;

    // Rotation fallback (in case timer is skipped / clock drift)
    maybeRotate("retention");
    
    const timestamp = formatTimestamp();
    const fullTimestamp = formatFullTimestamp();
    
    // 更新统计
    if (level === "request") stats.requests++;
    if (level === "response") stats.responses++;
    if (level === "error" || level === "fatal") stats.errors++;
    if (level === "retry") stats.retries++;
    if (level === "upstream") stats.upstreamCalls++;
    
    // 控制台输出（带颜色）
    const icon = levelConfig.icon;
    const coloredLevel = `${levelConfig.color}${levelConfig.label.padEnd(8)}${Colors.reset}`;
    const timeStr = `${Colors.gray}[${timestamp}]${Colors.reset}`;
    
    const safeMessage = typeof message === "string" ? message : message != null ? String(message) : "";
    let consoleOutput = `${timeStr} ${icon} ${coloredLevel} ${safeMessage}`;
    
    // 如果有元数据，格式化输出
    if (meta !== null && meta !== undefined) {
      const metaStr = formatLogContent(meta);
      if (metaStr) {
        // 多行数据使用缩进显示
        if (metaStr.includes("\n")) {
          const indentedMeta = metaStr.split("\n").map(line => `   ${Colors.dim}│${Colors.reset} ${line}`).join("\n");
          consoleOutput += `\n${indentedMeta}`;
        } else {
          consoleOutput += ` ${Colors.dim}→${Colors.reset} ${Colors.gray}${truncateString(metaStr, 100)}${Colors.reset}`;
        }
      }
    }
    
    rawConsole.log(consoleOutput);
    
    // 文件日志（纯文本，无颜色）
    const separator = "-".repeat(60);
    const metaContent = meta !== null && meta !== undefined ? formatLogContent(meta) : "";
    const fileEntry = `[${fullTimestamp}] [${levelConfig.label}] ${safeMessage}\n${metaContent ? metaContent + "\n" : ""}${separator}\n`;

    fs.appendFile(currentLogFile, fileEntry, (err) => {
      if (err && typeof rawConsole.error === "function") rawConsole.error("Failed to write to log file:", err);
    });
  };

  /**
   * 记录 HTTP 请求
   */
  const logRequest = (method, url, options = {}) => {
    const { headers, body, requestId } = options;
    const reqIdStr = requestId ? ` ${Colors.dim}[${requestId}]${Colors.reset}` : "";
    
    console.log(`\n${createSeparator("═", 70, Colors.blue)}`);
    log("request", `${Colors.bold}${method}${Colors.reset} ${url}${reqIdStr}`);
    
    if (headers && Object.keys(headers).length > 0) {
      const safeHeaders = { ...headers };
      if (safeHeaders.Authorization) safeHeaders.Authorization = "[REDACTED]";
      if (safeHeaders["x-api-key"]) safeHeaders["x-api-key"] = "[REDACTED]";
      log("debug", "请求头", safeHeaders);
    }
    
    if (body) {
      log("debug", "请求体", body);
    }
    
    return { startTime: Date.now(), requestId };
  };

  /**
   * 记录 HTTP 响应
   */
  const logResponse = (status, options = {}) => {
    const { duration, size, requestId, headers, body } = options;
    const reqIdStr = requestId ? ` ${Colors.dim}[${requestId}]${Colors.reset}` : "";
    
    const statusColor = status >= 500 ? Colors.red : status >= 400 ? Colors.yellow : Colors.green;
    const statusIcon = status >= 500 ? "❌" : status >= 400 ? "⚠️" : "✅";
    
    let metaInfo = [];
    if (duration) metaInfo.push(`⏱️  ${formatDuration(duration)}`);
    if (size) metaInfo.push(`📦 ${formatBytes(size)}`);
    
    log("response", `${statusIcon} ${statusColor}${Colors.bold}${status}${Colors.reset}${reqIdStr} ${Colors.dim}${metaInfo.join(" | ")}${Colors.reset}`);
    
    if (headers) {
      log("debug", "响应头", headers);
    }
    
    if (body) {
      log("debug", "响应体", body);
    }
    
    console.log(`${createSeparator("═", 70, Colors.green)}\n`);
  };

  /**
   * 记录上游 API 调用
   */
  const logUpstream = (action, options = {}) => {
    const { method, account, model, group, attempt, maxAttempts, status, duration, error } = options;
    
    const attemptStr = attempt && maxAttempts ? `[${attempt}/${maxAttempts}]` : "";
    const accountStr = account ? `${Colors.cyan}@${account}${Colors.reset}` : "";
    const modelStr = model ? `${Colors.magenta}${model}${Colors.reset}` : "";
    const groupStr = group ? `[${group}]` : "";
    
    let message = `${action} ${attemptStr} ${groupStr} ${accountStr} ${modelStr}`.trim();
    
    if (status) {
      const statusColor = status >= 500 ? Colors.red : status >= 400 ? Colors.yellow : Colors.green;
      message += ` → ${statusColor}${status}${Colors.reset}`;
    }
    
    if (duration) {
      message += ` ${Colors.dim}(${formatDuration(duration)})${Colors.reset}`;
    }
    
    if (error) {
      log("upstream", message, { error });
    } else {
      log("upstream", message);
    }
  };

  /**
   * 记录重试事件
   */
  const logRetry = (reason, options = {}) => {
    const { attempt, maxAttempts, delayMs, account, error, nextAction } = options;
    
    const attemptStr = attempt && maxAttempts ? `[${attempt}/${maxAttempts}]` : "";
    const delayStr = delayMs ? `延迟 ${formatDuration(delayMs)}` : "";
    const accountStr = account ? `账户: ${account}` : "";
    const nextStr = nextAction ? `→ ${nextAction}` : "";
    
    let message = `${reason} ${attemptStr}`;
    const details = [delayStr, accountStr, nextStr].filter(Boolean).join(" | ");
    if (details) message += ` ${Colors.dim}(${details})${Colors.reset}`;
    
    if (error) {
      log("retry", message, { error });
    } else {
      log("retry", message);
    }
  };

  /**
   * 记录配额/限流事件
   */
  const logQuota = (event, options = {}) => {
    const { account, group, resetDelay, remaining, limit } = options;
    
    const accountStr = account ? `${Colors.cyan}@${account}${Colors.reset}` : "";
    const groupStr = group ? `[${group}]` : "";
    const resetStr = resetDelay ? `重置: ${formatDuration(resetDelay)}` : "";
    const quotaStr = remaining !== undefined && limit ? `${remaining}/${limit}` : "";
    
    let message = `${event} ${groupStr} ${accountStr}`.trim();
    const details = [resetStr, quotaStr].filter(Boolean).join(" | ");
    if (details) message += ` ${Colors.dim}(${details})${Colors.reset}`;
    
    log("quota", message);
  };

  /**
   * 记录账户事件
   */
  const logAccount = (action, options = {}) => {
    const { email, account, group, reason } = options;
    
    const emailStr = email ? `${Colors.cyan}${email}${Colors.reset}` : "";
    const accountStr = account ? `${Colors.cyan}@${account}${Colors.reset}` : "";
    const groupStr = group ? `[${group}]` : "";
    const reasonStr = reason ? `${Colors.dim}(${reason})${Colors.reset}` : "";
    
    const message = `${action} ${groupStr} ${emailStr || accountStr} ${reasonStr}`.trim();
    log("account", message);
  };

  /**
   * 记录流式传输事件
   */
  const logStream = (event, options = {}) => {
    const { chunks, bytes, duration, error } = options;
    
    let message = event;
    const details = [];
    if (chunks) details.push(`${chunks} chunks`);
    if (bytes) details.push(formatBytes(bytes));
    if (duration) details.push(formatDuration(duration));
    
    if (details.length > 0) {
      message += ` ${Colors.dim}(${details.join(" | ")})${Colors.reset}`;
    }
    
    if (error) {
      log("stream", message, { error });
    } else {
      log("stream", message);
    }
  };

  /**
   * 记录错误（带堆栈）
   */
  const logError = (message, error, options = {}) => {
    const { context, requestId } = options;
    const reqIdStr = requestId ? ` [${requestId}]` : "";
    
    console.log(`\n${Colors.red}${Box.topLeft}${Box.horizontal.repeat(68)}${Box.topRight}${Colors.reset}`);
    
    const errorMessage = error?.message || String(error);
    log("error", `${message}${reqIdStr}`, { 
      message: errorMessage,
      ...(error?.stack ? { stack: error.stack } : {}),
      ...(context || {})
    });
    
    console.log(`${Colors.red}${Box.bottomLeft}${Box.horizontal.repeat(68)}${Box.bottomRight}${Colors.reset}\n`);
  };

  /**
   * 获取运行统计
   */
  const getStats = () => {
    return {
      ...stats,
      uptime: Date.now() - stats.startTime,
      uptimeFormatted: formatDuration(Date.now() - stats.startTime),
    };
  };

  /**
   * 打印统计摘要
   */
  const logStats = () => {
    const s = getStats();
    console.log(`\n${createSeparator("═", 60, Colors.cyan)}`);
    console.log(`${Colors.bold}📊 运行统计${Colors.reset}`);
    console.log(`${Colors.dim}├${Colors.reset} 运行时长: ${s.uptimeFormatted}`);
    console.log(`${Colors.dim}├${Colors.reset} 请求总数: ${s.requests}`);
    console.log(`${Colors.dim}├${Colors.reset} 响应总数: ${s.responses}`);
    console.log(`${Colors.dim}├${Colors.reset} 上游调用: ${s.upstreamCalls}`);
    console.log(`${Colors.dim}├${Colors.reset} 重试次数: ${s.retries}`);
    console.log(`${Colors.dim}└${Colors.reset} 错误次数: ${s.errors}`);
    console.log(`${createSeparator("═", 60, Colors.cyan)}\n`);
  };

  return { 
    log, 
    get logFile() {
      return currentLogFile;
    },
    logRequest,
    logResponse,
    logUpstream,
    logRetry,
    logQuota,
    logAccount,
    logStream,
    logError,
    getStats,
    logStats,
    // 便捷方法
    debug: (msg, meta) => log("debug", msg, meta),
    info: (msg, meta) => log("info", msg, meta),
    success: (msg, meta) => log("success", msg, meta),
    warn: (msg, meta) => log("warn", msg, meta),
    error: (msg, meta) => log("error", msg, meta),
    // 辅助工具
    formatDuration,
    formatBytes,
    Colors,
    Box,
  };
}

function ensureLogger(input) {
  const noop = () => {};

  const base =
    input && typeof input.log === "function"
      ? input
      : typeof input === "function"
        ? { log: (...args) => input(...args) }
        : null;

  const logger = base || { log: noop };
  const pick = (fn) => (typeof fn === "function" ? fn : noop);

  return {
    ...logger,
    log: pick(logger.log),
    logStream: pick(logger.logStream),
    logUpstream: pick(logger.logUpstream),
    logRetry: pick(logger.logRetry),
    logQuota: pick(logger.logQuota),
    logError: pick(logger.logError),
    logRequest: pick(logger.logRequest),
    logResponse: pick(logger.logResponse),
    logAccount: pick(logger.logAccount),
  };
}

module.exports = {
  createLogger,
  ensureLogger,
  Colors,
  LogLevels,
  Box,
};
