const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function listTestFiles(testsDir) {
  let entries = [];
  try {
    entries = fs.readdirSync(testsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && /^test_.*\.js$/i.test(e.name))
    .map((e) => path.join(testsDir, e.name))
    .sort();
}

function runTestFile(filePath) {
  const res = spawnSync(process.execPath, [filePath], {
    stdio: "inherit",
    env: process.env,
  });
  return typeof res.status === "number" ? res.status : 1;
}

function main() {
  const testsDir = path.resolve(__dirname, "..", "tests");
  const testFiles = listTestFiles(testsDir);
  if (testFiles.length === 0) {
    // eslint-disable-next-line no-console
    console.log(`No tests found in ${testsDir}`);
    return;
  }

  for (const file of testFiles) {
    const code = runTestFile(file);
    if (code !== 0) process.exit(code);
  }
}

main();

