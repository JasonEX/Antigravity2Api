/**
 * Shared helpers for ClaudeRequestIn.
 * Keep these pure / side-effect free so they’re safe to reuse.
 */

/**
 * 将 schema 类型转换为大写
 */
function uppercaseSchemaTypes(schema) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(uppercaseSchemaTypes);

  const normalized = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "type") {
      if (typeof value === "string") {
        normalized[key] = value.toUpperCase();
      } else if (Array.isArray(value)) {
        normalized[key] = value.map((item) => (typeof item === "string" ? item.toUpperCase() : item));
      } else {
        normalized[key] = value;
      }
      continue;
    }
    normalized[key] = typeof value === "object" && value !== null ? uppercaseSchemaTypes(value) : value;
  }
  return normalized;
}

function lowercaseSchemaTypes(schema) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(lowercaseSchemaTypes);

  const normalized = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "type") {
      if (typeof value === "string") {
        normalized[key] = value.toLowerCase();
      } else if (Array.isArray(value)) {
        normalized[key] = value.map((item) => (typeof item === "string" ? item.toLowerCase() : item));
      } else {
        normalized[key] = value;
      }
      continue;
    }
    normalized[key] = typeof value === "object" && value !== null ? lowercaseSchemaTypes(value) : value;
  }
  return normalized;
}

function safeCloneJson(value) {
  try {
    if (typeof structuredClone === "function") {
      return structuredClone(value);
    }
  } catch (_) {}
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    return value;
  }
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function appendDescriptionHint(schema, hint) {
  if (!schema || typeof schema !== "object") return;
  const h = String(hint || "").trim();
  if (!h) return;
  const current = typeof schema.description === "string" ? schema.description : "";
  if (current.includes(h)) return;
  schema.description = current ? `${current} (${h})` : h;
}

function collectAllDefs(value, defs) {
  if (Array.isArray(value)) {
    for (const item of value) collectAllDefs(item, defs);
    return;
  }
  if (!isPlainObject(value)) return;

  const localDefs = value.$defs && isPlainObject(value.$defs) ? value.$defs : null;
  if (localDefs) {
    for (const [k, v] of Object.entries(localDefs)) {
      if (!Object.prototype.hasOwnProperty.call(defs, k)) defs[k] = v;
    }
  }

  const localDefinitions = value.definitions && isPlainObject(value.definitions) ? value.definitions : null;
  if (localDefinitions) {
    for (const [k, v] of Object.entries(localDefinitions)) {
      if (!Object.prototype.hasOwnProperty.call(defs, k)) defs[k] = v;
    }
  }

  for (const [k, v] of Object.entries(value)) {
    if (k === "$defs" || k === "definitions") continue;
    collectAllDefs(v, defs);
  }
}

function resolveRefs(value, defs, refStack = new Set()) {
  if (Array.isArray(value)) return value.map((item) => resolveRefs(item, defs, refStack));
  if (!isPlainObject(value)) return value;

  const ref = typeof value.$ref === "string" ? value.$ref.trim() : "";
  if (ref) {
    const name = ref.split("/").filter(Boolean).pop() || "";
    const isLocalRef = ref.startsWith("#/$defs/") || ref.startsWith("#/definitions/");
    if (isLocalRef && name && Object.prototype.hasOwnProperty.call(defs, name) && !refStack.has(name)) {
      refStack.add(name);
      const resolved = resolveRefs(safeCloneJson(defs[name]), defs, refStack);
      refStack.delete(name);

      // Merge sibling keywords (best-effort).
      const siblings = { ...value };
      delete siblings.$ref;
      delete siblings.$defs;
      delete siblings.definitions;
      return resolveRefs({ ...resolved, ...siblings }, defs, refStack);
    }

    const out = { ...value };
    delete out.$ref;
    delete out.$defs;
    delete out.definitions;
    if (!out.type) out.type = "string";
    appendDescriptionHint(out, `Unresolved $ref: ${ref}`);
    return out;
  }

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === "$defs" || k === "definitions") continue;
    out[k] = resolveRefs(v, defs, refStack);
  }
  return out;
}

/**
 * 清理 JSON Schema 以符合 Gemini 格式
 */
function cleanJsonSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(cleanJsonSchema);

  const validationFields = {
    minLength: "minLength",
    maxLength: "maxLength",
    minimum: "minimum",
    maximum: "maximum",
    exclusiveMinimum: "exclusiveMinimum",
    exclusiveMaximum: "exclusiveMaximum",
    minItems: "minItems",
    maxItems: "maxItems",
  };
  const removeKeys = new Set([
    "$schema",
    "additionalProperties",
    "default",
    "uniqueItems",
    // v1internal Schema doesn't support JSON Schema draft keywords like `propertyNames`.
    "propertyNames",
    "patternProperties",
    "unevaluatedProperties",
  ]);
  let constValue;

  const validations = [];
  for (const [field, label] of Object.entries(validationFields)) {
    if (field in schema) {
      validations.push(`${label}: ${schema[field]}`);
    }
  }

  const cleaned = {};
  for (const [key, value] of Object.entries(schema)) {
    // Gemini Schema doesn't support JSON Schema "const"; map to enum([value]).
    if (key === "const") {
      constValue = value;
      continue;
    }

    if (removeKeys.has(key) || key in validationFields) continue;

    // `properties` is a map of propertyName -> schema. Preserve property names (e.g. a parameter named "format")
    // and only clean each property's schema value.
    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      const cleanedProperties = {};
      for (const [propName, propSchema] of Object.entries(value)) {
        cleanedProperties[propName] =
          typeof propSchema === "object" && propSchema !== null ? cleanJsonSchema(propSchema) : propSchema;
      }
      cleaned.properties = cleanedProperties;
      continue;
    }

    // Normalize union types like ["string","null"] to a single type (prefer non-null)
    if (key === "type" && Array.isArray(value)) {
      const filtered = value.filter((v) => v !== "null");
      cleaned.type = filtered[0] || value[0] || "string";
      continue;
    }

    if (key === "description" && validations.length > 0) {
      cleaned[key] = `${value} (${validations.join(", ")})`;
    } else if (typeof value === "object" && value !== null) {
      cleaned[key] = cleanJsonSchema(value);
    } else {
      cleaned[key] = value;
    }
  }

  if (constValue !== undefined) {
    cleaned.enum = [constValue];
  }

  if (validations.length > 0 && !cleaned.description) {
    cleaned.description = `Validation: ${validations.join(", ")}`;
  }

  return uppercaseSchemaTypes(cleaned);
}

/**
 * Clean JSON Schema for Claude models running via Antigravity/v1internal:
 * - Ensure JSON Schema draft 2020-12 compatibility (best-effort)
 * - Remove unsupported/fragile keywords used by upstream
 * - Avoid schema constructs that commonly trigger upstream validation errors
 */
function cleanJsonSchemaForAntigravity(schema) {
  const raw = safeCloneJson(schema);

  // Collect nested $defs/definitions for local $ref resolution.
  const defs = {};
  collectAllDefs(raw, defs);

  // Resolve $ref and drop $defs/definitions.
  const resolved = resolveRefs(raw, defs);

  const validationFields = {
    minLength: "minLength",
    maxLength: "maxLength",
    pattern: "pattern",
    minimum: "minimum",
    maximum: "maximum",
    multipleOf: "multipleOf",
    exclusiveMinimum: "exclusiveMinimum",
    exclusiveMaximum: "exclusiveMaximum",
    minItems: "minItems",
    maxItems: "maxItems",
    format: "format",
  };

  const removeKeys = new Set([
    "$schema",
    "$id",
    "$comment",
    "$anchor",
    "$dynamicAnchor",
    "$dynamicRef",
    "$vocabulary",
    "$ref", // resolved above; keep as a final safety net
    "$defs",
    "definitions",
    "default",
    "uniqueItems",
    "additionalProperties",
    "propertyNames",
    "patternProperties",
    "unevaluatedProperties",
    "nullable", // OpenAPI
    "examples", // OpenAPI/others
    "example",
    "deprecated",
    "readOnly",
    "writeOnly",
    "discriminator",
  ]);

  function isTopLevelSchemaCandidate(obj) {
    if (!isPlainObject(obj)) return false;
    if (obj.properties && isPlainObject(obj.properties)) return true;
    if (typeof obj.type === "string" && obj.type.toLowerCase() === "object") return true;
    return false;
  }

  function pickBestSchemaBranch(branches) {
    const cleanedBranches = branches.map((b) => cleanNode(b, { topLevel: false }));
    const scored = cleanedBranches
      .map((b, idx) => ({ b, idx, score: scoreSchema(b) }))
      .sort((a, c) => c.score - a.score);
    return scored[0]?.b || cleanedBranches[0] || {};
  }

  function scoreSchema(s) {
    if (!isPlainObject(s)) return 0;
    const type = typeof s.type === "string" ? s.type.toLowerCase() : "";
    if (type === "object" || (s.properties && isPlainObject(s.properties))) return 30;
    if (type === "array") return 20;
    if (type === "string") return 10;
    if (type === "number" || type === "integer") return 9;
    if (type === "boolean") return 8;
    if (type === "null") return 0;
    return 5;
  }

  function cleanNode(node, ctx) {
    const topLevel = !!ctx?.topLevel;

    if (Array.isArray(node)) return node.map((x) => cleanNode(x, { topLevel: false }));
    if (!isPlainObject(node)) return node;

    const validations = [];
    for (const [field, label] of Object.entries(validationFields)) {
      if (Object.prototype.hasOwnProperty.call(node, field)) {
        validations.push(`${label}: ${node[field]}`);
      }
    }

    // Handle anyOf/oneOf/allOf early, especially at top level (Claude tool schema restrictions).
    const anyOf = Array.isArray(node.anyOf) ? node.anyOf : null;
    const oneOf = Array.isArray(node.oneOf) ? node.oneOf : null;
    const allOf = Array.isArray(node.allOf) ? node.allOf : null;

    if (topLevel && (anyOf || oneOf || allOf)) {
      const branches = anyOf || oneOf || allOf || [];
      const chosen = pickBestSchemaBranch(branches);
      const merged = isPlainObject(chosen) ? { ...chosen } : {};
      // Preserve existing description/required hints.
      if (typeof node.description === "string" && !merged.description) merged.description = node.description;
      if (Array.isArray(node.required) && !Array.isArray(merged.required)) merged.required = node.required;
      return cleanNode(merged, { topLevel: true });
    }

    let constValue;
    const cleaned = {};

    for (const [key, value] of Object.entries(node)) {
      if (key === "const") {
        constValue = value;
        continue;
      }

      if (removeKeys.has(key) || key in validationFields) continue;

      if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
        const cleanedProperties = {};
        for (const [propName, propSchema] of Object.entries(value)) {
          cleanedProperties[propName] = cleanNode(propSchema, { topLevel: false });
        }
        cleaned.properties = cleanedProperties;
        continue;
      }

      if (key === "type" && Array.isArray(value)) {
        const filtered = value.filter((v) => v !== "null");
        cleaned.type = filtered[0] || value[0] || "string";
        if (value.includes("null")) appendDescriptionHint(cleaned, "nullable");
        if (filtered.length > 1) appendDescriptionHint(cleaned, `Accepts: ${filtered.join(" | ")}`);
        continue;
      }

      if (key === "items" && Array.isArray(value)) {
        // JSON Schema draft 2020-12: "items" must be a schema (tuple validation uses prefixItems).
        cleaned.items = value.length > 0 ? cleanNode(value[0], { topLevel: false }) : {};
        appendDescriptionHint(cleaned, "Tuple items simplified");
        continue;
      }

      if (key === "anyOf" && Array.isArray(value)) {
        const chosen = pickBestSchemaBranch(value);
        Object.assign(cleaned, isPlainObject(chosen) ? chosen : {});
        continue;
      }

      if (key === "oneOf" && Array.isArray(value)) {
        const chosen = pickBestSchemaBranch(value);
        Object.assign(cleaned, isPlainObject(chosen) ? chosen : {});
        continue;
      }

      if (key === "allOf" && Array.isArray(value)) {
        const chosen = pickBestSchemaBranch(value);
        Object.assign(cleaned, isPlainObject(chosen) ? chosen : {});
        continue;
      }

      cleaned[key] = cleanNode(value, { topLevel: false });
    }

    if (constValue !== undefined) {
      cleaned.enum = [constValue];
    }

    if (validations.length > 0) {
      appendDescriptionHint(cleaned, `Validation: ${validations.join(", ")}`);
    }

    // Implicit type injection.
    if (!cleaned.type) {
      if (cleaned.properties && typeof cleaned.properties === "object") cleaned.type = "object";
      else if (cleaned.items) cleaned.type = "array";
    }

    // Ensure object schema always has a properties map.
    if (String(cleaned.type || "").toLowerCase() === "object") {
      if (!cleaned.properties || typeof cleaned.properties !== "object" || Array.isArray(cleaned.properties)) {
        cleaned.properties = {};
      }

      // Claude VALIDATED mode: empty object schemas can be rejected; add a minimal placeholder.
      if (Object.keys(cleaned.properties).length === 0) {
        cleaned.properties.reason = {
          type: "string",
          description: "Brief explanation of why you are calling this tool",
        };
        cleaned.required = Array.isArray(cleaned.required) ? cleaned.required : [];
        if (!cleaned.required.includes("reason")) cleaned.required.push("reason");
      }

      if (Array.isArray(cleaned.required)) {
        const props = cleaned.properties && typeof cleaned.properties === "object" ? cleaned.properties : {};
        cleaned.required = cleaned.required.filter((k) => typeof k === "string" && Object.prototype.hasOwnProperty.call(props, k));
        if (cleaned.required.length === 0) delete cleaned.required;
      }
    }

    return lowercaseSchemaTypes(cleaned);
  }

  const cleaned = cleanNode(resolved, { topLevel: true });

  // Tool input_schema should be an object schema.
  if (!isTopLevelSchemaCandidate(cleaned)) {
    return {
      type: "object",
      properties: {},
    };
  }
  return cleaned;
}

function estimateBase64BytesLength(b64) {
  const s = String(b64 || "").trim();
  if (!s) return 0;
  let padding = 0;
  if (s.endsWith("==")) padding = 2;
  else if (s.endsWith("=")) padding = 1;
  return Math.max(0, Math.floor((s.length * 3) / 4) - padding);
}

function extractInlineDataPartsFromClaudeToolResultContent(rawContent) {
  if (!Array.isArray(rawContent)) {
    const text =
      typeof rawContent === "string"
        ? rawContent
        : rawContent && typeof rawContent === "object"
          ? JSON.stringify(rawContent)
          : String(rawContent || "");
    return { contentText: text, sanitizedContent: rawContent, inlineParts: [] };
  }

  const inlineParts = [];
  const sanitized = [];
  const textSegments = [];

  for (const block of rawContent) {
    if (block && typeof block === "object") {
      if (block.type === "text") {
        const t = typeof block.text === "string" ? block.text : "";
        if (t) textSegments.push(t);
        sanitized.push(block);
        continue;
      }

      if (block.type === "image") {
        const source = block.source && typeof block.source === "object" ? block.source : null;
        const data = source && typeof source.data === "string" ? source.data : null;
        const mimeType = source && (source.media_type || source.mediaType) ? (source.media_type || source.mediaType) : "image/png";
        if (data) {
          inlineParts.push({ inlineData: { mimeType, data } });
          const bytesLen = estimateBase64BytesLength(data);
          const placeholder = `[inline image omitted from JSON (${mimeType}, ~${bytesLen} bytes)]`;
          textSegments.push(placeholder);
          sanitized.push({
            ...block,
            source: {
              ...source,
              data: placeholder,
            },
          });
          continue;
        }
      }
    }

    // Fallback: preserve structure and provide a small textual hint.
    try {
      textSegments.push(typeof block === "string" ? block : JSON.stringify(block));
    } catch (_) {
      textSegments.push(String(block));
    }
    sanitized.push(block);
  }

  return {
    contentText: textSegments.join("\n"),
    sanitizedContent: inlineParts.length > 0 ? sanitized : rawContent,
    inlineParts,
  };
}

module.exports = {
  cleanJsonSchema,
  cleanJsonSchemaForAntigravity,
  extractInlineDataPartsFromClaudeToolResultContent,
};
