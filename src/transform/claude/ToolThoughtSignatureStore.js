/**
 * tool_use.id -> thoughtSignature（跨 turn）
 *
 * 规范要求：如果模型响应里出现 thoughtSignature，下一轮发送历史记录时必须原样带回到对应的 part。
 * 但 Claude Code 下一次请求不会回传 `tool_use.signature`（非标准字段），
 * 所以需要代理进程内维护一份 tool_use.id -> thoughtSignature 的映射，并在转回 v1internal 时补回。
 *
 * 注意：该缓存会随请求增长，需定期清理避免长期运行导致内存占用不断上涨。
 */

const fs = require("fs");
const path = require("path");

const TOOL_THOUGHT_SIGNATURE_TTL_DAYS = 21;
const TOOL_THOUGHT_SIGNATURE_TTL_MS = TOOL_THOUGHT_SIGNATURE_TTL_DAYS * 24 * 60 * 60 * 1000;
const TOOL_THOUGHT_SIGNATURE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const toolThoughtSignatures = new Map(); // tool_use.id -> { sig: string, expiresAt: number, createdAt?: number, updatedAt?: number }
let lastToolThoughtSignatureCleanupAt = 0;
const TOOL_THOUGHT_SIGNATURE_CACHE_FILE = path.resolve(__dirname, "tool_thought_signatures.json");
let toolThoughtSignaturesLoadedFromDisk = false;

function isDebugEnabled() {
  const raw = process.env.AG2API_DEBUG;
  if (!raw) return false;
  const v = String(raw).trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function loadToolThoughtSignaturesFromDisk() {
  if (toolThoughtSignaturesLoadedFromDisk) return;
  toolThoughtSignaturesLoadedFromDisk = true;

  try {
    if (!fs.existsSync(TOOL_THOUGHT_SIGNATURE_CACHE_FILE)) return;
    const raw = fs.readFileSync(TOOL_THOUGHT_SIGNATURE_CACHE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return;

    const now = Date.now();
    let needsPersist = false;
    for (const [id, entry] of Object.entries(parsed)) {
      if (!id) continue;

      let sig = null;
      let expiresAt = null;
      let createdAt = null;
      let updatedAt = null;

      if (typeof entry === "string") {
        sig = entry;
        needsPersist = true;
      } else if (entry && typeof entry === "object") {
        if (typeof entry.sig === "string") sig = entry.sig;
        if (Number.isFinite(entry.expiresAt)) expiresAt = entry.expiresAt;
        if (Number.isFinite(entry.createdAt)) createdAt = entry.createdAt;
        if (Number.isFinite(entry.updatedAt)) updatedAt = entry.updatedAt;
        if (!Number.isFinite(expiresAt) || !Number.isFinite(createdAt) || !Number.isFinite(updatedAt)) {
          needsPersist = true;
        }
      } else {
        needsPersist = true;
      }

      if (!sig) {
        needsPersist = true;
        continue;
      }
      if (!Number.isFinite(expiresAt)) {
        expiresAt = now + TOOL_THOUGHT_SIGNATURE_TTL_MS;
        needsPersist = true;
      }
      if (expiresAt <= now) {
        needsPersist = true;
        continue;
      }
      if (!Number.isFinite(createdAt)) {
        createdAt = now;
        needsPersist = true;
      }
      if (!Number.isFinite(updatedAt)) {
        updatedAt = createdAt;
        needsPersist = true;
      }

      toolThoughtSignatures.set(String(id), { sig: String(sig), expiresAt, createdAt, updatedAt });
    }

    // Garbage-collect expired/invalid entries from disk on startup (best-effort).
    if (needsPersist) persistToolThoughtSignaturesToDisk();
  } catch (_) {}
}

function persistToolThoughtSignaturesToDisk() {
  loadToolThoughtSignaturesFromDisk();

  if (toolThoughtSignatures.size === 0) {
    try {
      if (fs.existsSync(TOOL_THOUGHT_SIGNATURE_CACHE_FILE)) {
        fs.unlinkSync(TOOL_THOUGHT_SIGNATURE_CACHE_FILE);
      }
    } catch (_) {}
    return;
  }

  const out = {};
  for (const [id, entry] of toolThoughtSignatures.entries()) {
    if (!id) continue;
    if (typeof entry === "string") {
      const now = Date.now();
      out[id] = { sig: entry, expiresAt: now + TOOL_THOUGHT_SIGNATURE_TTL_MS, createdAt: now, updatedAt: now };
      continue;
    }
    if (!entry || typeof entry !== "object" || typeof entry.sig !== "string") continue;
    out[id] = {
      sig: entry.sig,
      expiresAt: Number.isFinite(entry.expiresAt) ? entry.expiresAt : Date.now() + TOOL_THOUGHT_SIGNATURE_TTL_MS,
      createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : Date.now(),
      updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : Date.now(),
    };
  }

  const content = JSON.stringify(out);
  const tmp = `${TOOL_THOUGHT_SIGNATURE_CACHE_FILE}.tmp`;
  try {
    fs.writeFileSync(tmp, content, "utf8");
    try {
      fs.renameSync(tmp, TOOL_THOUGHT_SIGNATURE_CACHE_FILE);
    } catch (err) {
      try {
        fs.copyFileSync(tmp, TOOL_THOUGHT_SIGNATURE_CACHE_FILE);
      } finally {
        try {
          fs.unlinkSync(tmp);
        } catch (_) {}
      }
    }
  } catch (_) {
    try {
      fs.unlinkSync(tmp);
    } catch (_) {}
  }
}

function cleanupToolThoughtSignatures(now = Date.now()) {
  loadToolThoughtSignaturesFromDisk();
  if (now - lastToolThoughtSignatureCleanupAt < TOOL_THOUGHT_SIGNATURE_CLEANUP_INTERVAL_MS) return;
  lastToolThoughtSignatureCleanupAt = now;

  let changed = false;
  for (const [id, entry] of toolThoughtSignatures.entries()) {
    if (!entry || typeof entry !== "object") {
      toolThoughtSignatures.delete(id);
      changed = true;
      continue;
    }
    const expiresAt = entry.expiresAt;
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      toolThoughtSignatures.delete(id);
      changed = true;
    }
  }

  if (changed) persistToolThoughtSignaturesToDisk();
}

function rememberToolThoughtSignature(toolUseId, thoughtSignature) {
  if (!toolUseId || !thoughtSignature) return;
  cleanupToolThoughtSignatures();
  const id = String(toolUseId);
  const sig = String(thoughtSignature);
  const now = Date.now();
  const prev = toolThoughtSignatures.get(id);
  const createdAt = prev && typeof prev === "object" && Number.isFinite(prev.createdAt) ? prev.createdAt : now;
  toolThoughtSignatures.set(id, {
    sig,
    createdAt,
    updatedAt: now,
    expiresAt: now + TOOL_THOUGHT_SIGNATURE_TTL_MS,
  });
  persistToolThoughtSignaturesToDisk();
  if (isDebugEnabled()) console.log(`[ThoughtSignature] cached tool_use.id=${id} len=${sig.length}`);
}

function getToolThoughtSignature(toolUseId) {
  if (!toolUseId) return null;
  cleanupToolThoughtSignatures();
  const id = String(toolUseId);
  const entry = toolThoughtSignatures.get(id);
  if (!entry) return null;

  // Backward compatible in case legacy code stored string values.
  if (typeof entry === "string") return entry;

  if (typeof entry !== "object") {
    toolThoughtSignatures.delete(id);
    persistToolThoughtSignaturesToDisk();
    return null;
  }

  const expiresAt = entry.expiresAt;
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    toolThoughtSignatures.delete(id);
    persistToolThoughtSignaturesToDisk();
    return null;
  }

  return typeof entry.sig === "string" ? entry.sig : null;
}

function deleteToolThoughtSignature(toolUseId) {
  if (!toolUseId) return;
  cleanupToolThoughtSignatures();
  const id = String(toolUseId);
  if (!toolThoughtSignatures.has(id)) return;
  toolThoughtSignatures.delete(id);
  persistToolThoughtSignaturesToDisk();
  if (isDebugEnabled()) console.log(`[ThoughtSignature] deleted tool_use.id=${id}`);
}

// Load (and garbage-collect expired entries) on startup so the on-disk cache doesn't grow forever.
loadToolThoughtSignaturesFromDisk();

module.exports = {
  rememberToolThoughtSignature,
  getToolThoughtSignature,
  deleteToolThoughtSignature,
  isDebugEnabled,
};

