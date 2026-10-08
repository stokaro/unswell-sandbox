// Exercise the native MDX boundary without evaluating source JavaScript or JSX.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { boot, repoRoot } from "./harness.mjs";

const runtime = await boot();
const sample = await readFile(join(repoRoot, "web/samples/correlate-messages.mdx"), "utf8");
const sentence = "The client can be used to associate café messages with vertices that may be\nhelpful for request tracing purposes";
for (const profile of ["technical", "strict"]) {
  const report = await runtime.analyze(sample, profile, "mdx");
  assert.equal(report.incomplete, false);
  assert.equal(report.format, "mdx");
  assert.equal(report.findings.length, 1);
  const finding = report.findings[0];
  assert.equal(finding.ruleId, "filler.instruction-scaffolding");
  assert.equal(finding.ruleVersion, "15");
  assert.equal(Buffer.from(sample).subarray(finding.start, finding.end).toString(), sentence);
  assert.match(finding.message, /support and helpfulness clauses/);
  assert.match(finding.suggestion, /modality of both clauses/);
  const source = 'export const marker = (globalThis.__unswellMdxRan = true, "Certainly! Here is the guide.");\n\nThe client fetches records.\n';
  const control = await runtime.analyze(source, profile, "mdx");
  assert.equal(control.incomplete, false);
  assert.equal(control.findings.length, 0);
  assert.equal(globalThis.__unswellMdxRan, undefined);
  await assert.rejects(runtime.analyze("<TracePreview>\nThe client fetches records.", profile, "mdx"), /parse mdx.*unclosed JSX/);
  const recovered = await runtime.analyze("The client fetches records.", profile, "mdx");
  assert.equal(recovered.incomplete, false);
  assert.equal(recovered.findings.length, 0);
  console.log(`mdx-source: ${profile}: prose spans, excluded imports and JSX, no evaluation, and malformed-source recovery passed`);
}
assert.deepEqual(runtime.panics, []);
console.log(`mdx-source: passed on ${runtime.info.commit}`);
process.exit(0);
