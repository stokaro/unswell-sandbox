// The native CLI and this WASM host use the same source-bound development cases.
// These judgments are exposed rule-development inputs, not precision estimates.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { boot, repoRoot } from "./harness.mjs";

const book = JSON.parse(await readFile(join(repoRoot, "test/fixtures/ptah-rhetoric.json"), "utf8"));
const runtime = await boot();
const ids = new Set([
  "filler.document-justification", "filler.evaluative-closure", "repetition.definition-echo", "syntax.slogan-contrast",
]);
assert.equal(book.cases.length, 21);
assert.equal(book.commit, "654eae5591392278e6c8bce8e54737f780766f19");
for (const profile of ["technical", "strict"]) {
  let count = 0;
  for (const row of book.cases) {
    const bytes = Buffer.from(row.text);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), row.sha256);
    const result = await runtime.analyze(row.text, profile);
    assert.equal(result.incomplete, false, row.id);
    const findings = result.findings.filter((finding) => ids.has(finding.ruleId));
    assert.deepEqual(findings.map((finding) => ({
      rule: finding.ruleId, start: finding.start, end: finding.end,
      text: bytes.subarray(finding.start, finding.end).toString(),
    })), row.expected, `${profile}: ${row.id}`);
    for (const finding of findings) {
      assert.equal(finding.severity, "warning");
      assert.equal(finding.points > 0, true, row.id);
      assert.equal(finding.suggestion.length > 0, true, row.id);
    }
    count += findings.length;
    if (row.revision) {
      const revised = await runtime.analyze(row.revision, profile);
      assert.equal(revised.incomplete, false, row.id);
      assert.deepEqual(revised.findings.filter((finding) => ids.has(finding.ruleId)), [], row.id);
    }
  }
  assert.equal(count, 9);
  console.log(`Ptah rhetoric: ${profile}: 9 expected warnings; 12 controls and 9 revisions clear of these rules`);
}
assert.deepEqual(runtime.panics, []);
console.log(`Ptah rhetoric: passed on ${runtime.info.commit}`);
process.exit(0);
