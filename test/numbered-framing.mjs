// Keep the reported full-page regression at the browser's actual WASM boundary.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { boot, repoRoot } from "./harness.mjs";

const page = await readFile(join(repoRoot, "test/fixtures/ptah-configure-provider.md"), "utf8");
assert.equal(createHash("sha256").update(page).digest("hex"),
  "efd32270f4edd576f617d76a812b76215eb80f1c7fa68ef6d2400bb35d973e10");
const id = "filler.numbered-section-framing";
const opening = "Four lines of a specification decide where your corpus goes";
const heading = "The four lines";
const revision = page.replace(opening,
  "The model configuration selects the endpoint that receives your corpus")
  .replace(`## ${heading}`, "## Model configuration");
const runtime = await boot();

for (const profile of ["technical", "strict"]) {
  const report = await runtime.analyze(page, profile);
  assert.equal(report.incomplete, false);
  const findings = report.findings.filter((finding) => finding.ruleId === id);
  assert.equal(findings.length, 1, profile);
  const finding = findings[0];
  const bytes = Buffer.from(page);
  assert.deepEqual([finding, ...finding.related].map(({ start, end }) => ({
    start, end, text: bytes.subarray(start, end).toString(),
  })), [
    { start: 595, end: 654, text: opening },
    { start: 766, end: 780, text: heading },
  ]);
  assert.equal(finding.severity, "warning");
  // The host sums contributions across affected units: 12 for each location.
  assert.equal(finding.points, 24);
  assert.ok(finding.suggestion.length > 0);
  assert.ok(finding.related[0].segments.length > 0);
  assert.equal(report.gate.passed, true);

  const revised = await runtime.analyze(revision, profile);
  assert.equal(revised.incomplete, false);
  assert.deepEqual(revised.findings.filter((finding) => finding.ruleId === id), []);

  for (const control of [
    "Two schemes are supported: env and file.\n\n## The two schemes",
    "Two fixed strings are sent to the endpoint.\n\n## The two strings",
    "Four steps initialize the database.\n\n## Four steps to initialize a database",
    "Four lines control the endpoint.\n\n## Four lines: configuration",
    "Four steps control deployment.\n\n## Four steps — setup",
    "Exactly four lines are required by the protocol.\n\n## The four lines",
  ]) {
    const result = await runtime.analyze(control, profile);
    assert.equal(result.incomplete, false);
    assert.deepEqual(result.findings.filter((finding) => finding.ruleId === id), [], control);
  }
  console.log(`numbered framing: ${profile}: one paired warning; revision and technical counts clear`);
}
assert.deepEqual(runtime.panics, []);
console.log(`numbered framing: passed on ${runtime.info.commit}`);
process.exit(0);
