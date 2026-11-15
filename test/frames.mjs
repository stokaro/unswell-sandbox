// Exercise the same WASM host interface used by the playground. These cases
// check construction recognition and source evidence, not authorship or quality.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { boot, repoRoot } from "./harness.mjs";

const runtime = await boot();
const reframeId = "syntax.repeated-reframing";
const metaId = "filler.document-metadiscourse";
const clauses = [
  "Backups are not a checkbox",
  "They are your last line of defense",
  "Monitoring is not a dashboard",
  "It is the foundation of operational confidence",
  "Testing is not a phase",
  "It is a commitment to quality",
];
const probe = `Café 🙂. ${clauses.join(". ")}.`;
const page = await readFile(join(repoRoot, "test/fixtures/ptah-database-urls.md"), "utf8");
assert.equal(createHash("sha256").update(page).digest("hex"),
  "9fff3f89117111fbd829bf0c6f99befdf84d6f5b320f885cc12c1a0793ed2c64");

for (const profile of ["technical", "strict"]) {
  const report = await runtime.analyze(probe, profile);
  assert.equal(report.incomplete, false);
  assert.equal(report.findings.length, 1);
  const finding = report.findings[0];
  assert.equal(finding.ruleId, reframeId);
  assert.equal(finding.severity, "note");
  assert.equal(finding.points, 0);
  assert.equal(finding.metric.name, "denial-redefinition");
  assert.equal(finding.metric.value, 3);
  assert.equal(report.gate.passed, true);
  const bytes = Buffer.from(probe);
  const spans = [finding, ...finding.related];
  assert.deepEqual(spans.map(({ start, end }) => bytes.subarray(start, end).toString()), clauses);
  assert.equal(finding.related.every((location) => location.segments.length > 0), true);

  const actual = await runtime.analyze(page, profile);
  assert.equal(actual.incomplete, false);
  // The page has four em dashes in 391 prose words. The default rules report
  // that once; the strict profile adds the density rule and long sentences.
  assert.deepEqual(actual.findings.map((f) => f.ruleId).sort(), profile === "strict"
    ? ["format.em-dash-density", "format.em-dash-density", "format.em-dash-frequency",
      "syntax.long-sentence", "syntax.long-sentence"]
    : ["format.em-dash-frequency"]);
  // Contrast frequency and document metadiscourse are opt-in by name.
  assert.equal(actual.findings.some((f) => f.ruleId === "syntax.paired-contrast-density"), false);
  assert.equal(actual.findings.some((f) => f.ruleId === metaId), false);
  assert.equal(actual.gate.passed, true);
  assert.equal(actual.maxIndex, profile === "strict" ? 1.32 : 0);
  assert.equal(actual.findings.filter((f) => f.ruleId === reframeId).length, 0);

  const variants = await runtime.analyze(
    "`Backup()` isn’t a checkbox; it’s a safeguard. Reviews aren’t a ritual; they’re a commitment.", profile);
  assert.equal(variants.findings.length, 1);
  assert.equal(variants.findings[0].ruleId, reframeId);
  assert.equal(variants.findings[0].related.length, 3);

  for (const control of [
    "A dev database is not the target. It is a disposable replay target.",
    "The client must not retry. It is a safety constraint. The server must not cache. It is a privacy constraint.",
    "See the configuration reference for the complete list of environment variables.",
    "Backups retain database contents. Monitoring reports replication lag. Testing checks retry behavior.",
    "Backups are your last line of defense. Monitoring is the foundation of operational confidence. Testing is a commitment to quality.",
  ]) {
    const result = await runtime.analyze(control, profile);
    assert.equal(result.incomplete, false);
    assert.equal(result.findings.length, 0, `${profile}: ${control}`);
    assert.equal(result.gate.passed, true);
  }
  console.log(`frames: ${profile}: three pairs with six clause locations; Ptah ${actual.findings.length} findings, index ${actual.maxIndex}; controls clean`);
}
assert.deepEqual(runtime.panics, []);
console.log(`frames: passed on ${runtime.info.commit}`);
process.exit(0);
