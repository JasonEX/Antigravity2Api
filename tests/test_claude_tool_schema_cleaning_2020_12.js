const { transformClaudeRequestIn } = require("../src/transform/claude");

function getFirstToolParameters(body) {
  const tools = body?.request?.tools;
  const decl = tools?.[0]?.functionDeclarations?.[0];
  return decl?.parameters;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function testClaudeModelUsesJsonSchemaLowercaseAndCleansTupleItemsAndRefs() {
  const req = {
    model: "claude-sonnet-4-5",
    messages: [{ role: "user", content: "hi" }],
    tools: [
      {
        name: "t",
        description: "test",
        input_schema: {
          type: "object",
          $defs: {
            X: { type: "string" },
          },
          properties: {
            x: { $ref: "#/$defs/X" },
            arr: {
              type: "array",
              items: [{ type: "string" }, { type: "number" }],
            },
          },
          required: ["x", "arr"],
        },
      },
    ],
  };

  const { body } = transformClaudeRequestIn(req, "proj");
  const params = getFirstToolParameters(body);

  assert(params && typeof params === "object", "Expected parameters to be an object");
  assert(params.type === "object", `Expected lowercase type "object", got: ${params.type}`);
  assert(!("$defs" in params) && !("definitions" in params), "Expected $defs/definitions to be removed from parameters");

  assert(params.properties?.x?.type === "string", `Expected $ref to resolve to type string, got: ${params.properties?.x?.type}`);

  const items = params.properties?.arr?.items;
  assert(items && typeof items === "object" && !Array.isArray(items), "Expected tuple items[] to be simplified to a schema object");
}

async function testGeminiModelKeepsUppercaseTypes() {
  const req = {
    model: "gemini-3-flash",
    messages: [{ role: "user", content: "hi" }],
    tools: [
      {
        name: "t",
        description: "test",
        input_schema: {
          type: "object",
          properties: {
            foo: { type: "string" },
          },
          required: ["foo"],
        },
      },
    ],
  };

  const { body } = transformClaudeRequestIn(req, "proj");
  const params = getFirstToolParameters(body);

  assert(params && typeof params === "object", "Expected parameters to be an object");
  assert(params.type === "OBJECT", `Expected uppercase type "OBJECT" for Gemini models, got: ${params.type}`);
  assert(
    params.properties?.foo?.type === "STRING",
    `Expected uppercase type "STRING" for properties.foo, got: ${params.properties?.foo?.type}`,
  );
}

async function main() {
  await testClaudeModelUsesJsonSchemaLowercaseAndCleansTupleItemsAndRefs();
  await testGeminiModelKeepsUppercaseTypes();
  // eslint-disable-next-line no-console
  console.log("✅ test_claude_tool_schema_cleaning_2020_12: PASS");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("❌ test_claude_tool_schema_cleaning_2020_12: FAIL\n", err);
  process.exitCode = 1;
});

