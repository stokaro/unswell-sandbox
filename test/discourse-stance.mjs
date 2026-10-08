// Verify discourse appraisals, literal controls, and preserved context in WASM.
import assert from "node:assert/strict";
import { boot } from "./harness.mjs";

const runtime = await boot();
assert.equal(runtime.info.commit, runtime.manifest.unswellCommit);
const id = "filler.evaluative-closure";
assert.equal(runtime.manifest.rules.find((rule) => rule.id === id).version, "12");
const positives = [
  ["markdown", "Café 🙂. It creates `row_2`, which is exactly the question, and the row is removed.", "which is exactly the question"],
  ["markdown", "It publishes text as an enum — which is the case worth having, because the dialect supports it.", "which is the case worth having"],
  ["markdown", "Applying that plan is what closes the loop.", "Applying that plan is what closes the loop"],
  ["markdown", "The non-zero status is the useful part.", "The non-zero status is the useful part"],
  ["markdown", "That is the honest conversion of a migration that never had a rollback:", "That is the honest conversion of a migration that never had a rollback"],
  ["mdx", "export const text = 'Applying that plan is what closes the loop';\n\nApplying that plan is what closes the loop.\n", "Applying that plan is what closes the loop"],
  ["python", "message = 'Café 🙂. Applying that plan is what closes the loop.'\n", "Applying that plan is what closes the loop"],
];
const controls = [
  "Applying that plan is what closes the feedback loop.",
  "The controller follows a wiring diagram; applying that plan is what closes the loop.",
  "The non-zero status is the useful part because it stops CI.",
  "The median latency is the important detail.",
  "That is not the honest conversion of the migration.",
  "That is the honest conversion of a migration if no rollback was declared.",
  "The author said: that is the honest conversion of a migration.",
  '"Applying that plan is what closes the loop."',
  "Applying that plan is what `closes` the loop.",
  "That is a faithful conversion of a migration that never had a rollback.",
];
for (const profile of ["technical", "strict"]) {
  for (const [format, source, matched] of positives) {
    const report = await runtime.analyze(source, profile, format);
    assert.equal(report.incomplete, false, `${profile}: ${format}`);
    const findings = report.findings.filter((finding) => finding.ruleId === id);
    assert.equal(findings.length, 1, source);
    const finding = findings[0];
    assert.equal(finding.ruleVersion, "12");
    assert.equal(Buffer.from(source).subarray(finding.start, finding.end).toString(), matched);
    assert.equal(finding.start, Buffer.from(source).lastIndexOf(Buffer.from(matched)));
    assert.match(finding.suggestion, /absent operations/);
    assert.match(finding.suggestion, /Verify the basis before removing or weakening any claim/);
  }
  for (const source of controls) {
    const report = await runtime.analyze(source, profile);
    assert.equal(report.incomplete, false);
    assert.deepEqual(report.findings.filter((finding) => finding.ruleId === id), [], source);
  }
  const mixed = await runtime.analyze(
    "That is the honest conversion of a migration that never had a rollback. That is measured rather than assumed.", profile);
  assert.equal(mixed.incomplete, false);
  const findings = mixed.findings.filter((finding) => finding.ruleId === id);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].related.length, 1);
  assert.match(findings[0].suggestion, /absent operations/);
  assert.match(findings[0].suggestion, /Verify the basis/);
  console.log(`discourse stance: ${profile}: seven source probes, ten controls, and mixed guidance passed`);
}
assert.deepEqual(runtime.panics, []);
console.log(`discourse stance: passed on ${runtime.info.commit}`);
process.exit(0);
