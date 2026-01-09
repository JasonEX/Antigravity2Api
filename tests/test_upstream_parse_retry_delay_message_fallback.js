const UpstreamClient = require("../src/api/upstream");

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

function main() {
  const upstream = new UpstreamClient(null);

  const fromJsonMessage = upstream.parseRetryDelayMs(
    JSON.stringify({ error: { message: "Your quota will reset after 3s." } })
  );
  assertEqual(fromJsonMessage, 3000, "parse retry delay from error.message");

  const fromText = upstream.parseRetryDelayMs("Your quota will reset after 4s.");
  assertEqual(fromText, 4000, "parse retry delay from plain text");

  // eslint-disable-next-line no-console
  console.log("✅ test_upstream_parse_retry_delay_message_fallback: PASS");
}

try {
  main();
} catch (err) {
  // eslint-disable-next-line no-console
  console.error("❌ test_upstream_parse_retry_delay_message_fallback: FAIL\n", err);
  process.exitCode = 1;
}

