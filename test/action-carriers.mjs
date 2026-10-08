// Drive the shipped WASM boundary, including original UTF-8 source locations.
import assert from "node:assert/strict";
import { boot } from "./harness.mjs";

const runtime = await boot();
const ruleId = "filler.instruction-scaffolding";
const positives = [
  "One final piece of solver logic allows merging two edges into one when they have both returned the same cache key.",
  "A final piece of renderer code enables formatting dates in the selected timezone.",
  "Another piece of parser logic allows combining two trees when their roots match.",
  "An additional part of retry logic supports reusing recorded responses after the connection returns.",
];
const controls = [
  "The final merge handler allows merging two edges when their keys match.",
  "The solver can merge two edges when their keys match.",
  "One piece of solver logic allows merging two edges when their keys match.",
  "The third part of solver logic allows merging two edges when their keys match.",
  "One final piece of `solver` logic allows merging two edges when their keys match.",
  "One final piece of solver logic allows `merging` two edges when their keys match.",
  "One final piece of solver logic allows merging only when both keys match.",
  "One final piece of solver logic does not allow merging two edges.",
  "The manual says: \"One final piece of solver logic allows merging two edges.\"",
];

for (const profile of ["technical", "strict"]) {
  for (const text of positives) {
    const source = `Café 🙂. ${text}`;
    const result = await runtime.analyze(source, profile);
    assert.equal(result.incomplete, false);
    const findings = result.findings.filter((finding) => finding.ruleId === ruleId);
    assert.equal(findings.length, 1, `${profile}: ${text}`);
    const finding = findings[0];
    assert.equal(finding.ruleVersion, "14");
    assert.equal(Buffer.from(source).subarray(finding.start, finding.end).toString(), text.slice(0, -1));
    assert.match(finding.message, /unnamed part of logic/);
    assert.match(finding.suggestion, /conditions and limits/);
    assert.match(finding.suggestion, /capability is not an obligation/);
  }

  for (const source of controls) {
    const result = await runtime.analyze(source, profile);
    assert.equal(result.incomplete, false);
    assert.equal(result.findings.some((finding) => finding.ruleId === ruleId), false, `${profile}: ${source}`);
  }

  const text = "One final piece of solver logic allows merging two café records when their key values match.";
  const source = `message = '🙂. ${text}'\n`;
  const result = await runtime.analyze(source, profile, "python");
  assert.equal(result.incomplete, false);
  const findings = result.findings.filter((finding) => finding.ruleId === ruleId);
  assert.equal(findings.length, 1);
  assert.equal(Buffer.from(source).subarray(findings[0].start, findings[0].end).toString(), text.slice(0, -1));
  console.log(`action-carriers: ${profile}: four constructions, nine controls, and Python UTF-8 mapping passed`);
}
assert.deepEqual(runtime.panics, []);
console.log(`action-carriers: passed on ${runtime.info.commit}`);
process.exit(0);
