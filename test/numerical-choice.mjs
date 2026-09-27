// The complete exposed regression is checked through the browser's WASM host.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { boot, repoRoot } from "./harness.mjs";

const page = await readFile(join(repoRoot, "test/fixtures/ptah-consistency-mode.md"), "utf8");
assert.equal(createHash("sha256").update(page).digest("hex"),
  "15f248e0dac75972bbfaad188136a5ee28a829824e04492fdedf55ea1df87124");
const id = "filler.unnamed-numerical-choice";
const original = "Four answers, and the right one depends on whether you control the writes.";
const revision = page.replace(original,
  "Choose a consistency mode based on whether you control source writes.");
const runtime = await boot();
assert.equal(runtime.info.commit, runtime.manifest.unswellCommit);

for (const profile of ["technical", "strict"]) {
  const report = await runtime.analyze(page, profile);
  assert.equal(report.incomplete, false);
  assert.equal(report.gate.passed, true);
  const findings = report.findings.filter((finding) => finding.ruleId === id);
  assert.equal(findings.length, 1, profile);
  const finding = findings[0];
  assert.deepEqual([finding.start, finding.end], [477, 550]);
  assert.equal(Buffer.from(page).subarray(finding.start, finding.end).toString(), original.slice(0, -1));
  assert.equal(finding.severity, "warning");
  assert.ok(finding.suggestion.includes("Preserve the stated condition"));
  assert.equal(finding.points, 12);
  for (const text of [
    revision,
    "Two schemes: env and file.",
    "Four migration paths are available: validate, baseline, checkpoint, and replay.",
    "Four answers are required by the protocol.",
    "## Four options for configuring a provider",
    "Four options, and the right one depends on the mode: local, hosted, gateway, or offline.",
    "Four answers, and the right one depends on the mode; local or hosted.",
  ]) {
    const control = await runtime.analyze(text, profile);
    assert.equal(control.incomplete, false);
    assert.deepEqual(control.findings.filter((f) => f.ruleId === id), [], text);
  }
  console.log(`numerical choice: ${profile}: exact source location; revision and six controls clear`);
}
assert.deepEqual(runtime.panics, []);
console.log(`numerical choice: passed on ${runtime.info.commit}`);
process.exit(0);
