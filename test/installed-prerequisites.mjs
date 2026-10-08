// Exercise prerequisite diagnosis and advice through the actual WASM host.
import assert from "node:assert/strict";
import { boot } from "./harness.mjs";

const runtime = await boot();
const ruleId = "filler.instruction-scaffolding";
const positives = [
  "To work with the React UI code, you will need to have the following tools installed:",
  "You will need to have the following tools installed.",
  "To build the client, you will need to have the following development packages installed:",
  "In order to run the tests, you will need to have the following dependencies installed:",
  "To build the client, you will need to have the following `Node.js` tools installed:",
];
const controls = [
  "Install Node.js before building the client.",
  "Node.js must be installed to build the client.",
  "To work with the UI, you need the following tools installed:",
  "You need to have the following tools installed.",
  "The worker will need to have the following tools installed.",
  "You might need to have the following tools installed.",
  "You will not need to have the following tools installed.",
  "You will need to have the following tools installed unless the image includes them.",
  "You will need to have the following tools installed by Friday.",
  "To meet tomorrow's deadline, you will need to have the following tools installed.",
  "You will need to have the following tools installed and configured.",
  "You will need to have the following optional tools installed.",
  "The manual says: \"You will need to have the following tools installed.\"",
  "You `will need to have` the following tools installed.",
  "You will need to have the following tools `installed`.",
];

for (const profile of ["technical", "strict"]) {
  for (const text of positives) {
    const source = `Café 🙂. ${text}`;
    const result = await runtime.analyze(source, profile);
    assert.equal(result.incomplete, false);
    const findings = result.findings.filter((finding) => finding.ruleId === ruleId);
    assert.equal(findings.length, 1, `${profile}: ${text}`);
    const finding = findings[0];
    assert.equal(finding.ruleVersion, "15");
    assert.equal(Buffer.from(source).subarray(finding.start, finding.end).toString(), text.replace(/[.:]$/, ""));
    assert.match(finding.message, /Future and possession auxiliaries/);
    assert.match(finding.suggestion, /required installed state/);
    assert.match(finding.suggestion, /recommended items optional/);
    assert.match(finding.suggestion, /separate deadline or state change/);
  }
  for (const source of controls) {
    const result = await runtime.analyze(source, profile);
    assert.equal(result.incomplete, false);
    assert.equal(result.findings.some((finding) => finding.ruleId === ruleId), false, `${profile}: ${source}`);
  }
  const text = "To build the café client, you will need to have the following tools installed:";
  const source = `message = '🙂. ${text}'\n`;
  const result = await runtime.analyze(source, profile, "python");
  assert.equal(result.incomplete, false);
  const findings = result.findings.filter((finding) => finding.ruleId === ruleId);
  assert.equal(findings.length, 1);
  assert.equal(Buffer.from(source).subarray(findings[0].start, findings[0].end).toString(), text.slice(0, -1));
  console.log(`installed-prerequisites: ${profile}: five constructions, fifteen controls, and Python UTF-8 mapping passed`);
}
assert.deepEqual(runtime.panics, []);
console.log(`installed-prerequisites: passed on ${runtime.info.commit}`);
process.exit(0);
