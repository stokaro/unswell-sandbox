// Verify qualitative degree, ranking advice, and source spans in the actual WASM.
import assert from "node:assert/strict";
import { boot } from "./harness.mjs";

const runtime = await boot();
assert.equal(runtime.info.commit, runtime.manifest.unswellCommit);
const id = "filler.unscoped-assurance";
assert.equal(runtime.manifest.rules.find((rule) => rule.id === id).version, "10");
const positives = [
  ["markdown", "## Blazingly fast", "Blazingly fast"],
  ["markdown", "Café 🙂. The engine is heavily optimized for request batching.", "heavily optimized"],
  ["markdown", "Use the builder for this purpose, this will be the biggest win!", "this will be the biggest win"],
  ["mdx", "export const sample = 'Blazingly fast';\n\n## Blazingly fast\n", "Blazingly fast"],
  ["python", "message = 'Café 🙂. The client is blazingly fast.'\n", "blazingly fast"],
];
const controls = [
  "The service is highly available.",
  "The module is strongly typed.",
  "The client is not blazingly fast.",
  "The README claims the client is blazingly fast.",
  "The client is blazingly fast: the benchmark reports its throughput.",
  "The engine is heavily optimized by coalescing queued requests.",
  "This will be the biggest win in the measured workload.",
];

for (const profile of ["technical", "strict"]) {
  for (const [format, source, matched] of positives) {
    const report = await runtime.analyze(source, profile, format);
    assert.equal(report.incomplete, false, `${profile}: ${format}`);
    const findings = report.findings.filter((finding) => finding.ruleId === id);
    assert.equal(findings.length, 1, source);
    const finding = findings[0];
    assert.equal(finding.ruleVersion, "10");
    assert.equal(Buffer.from(source).subarray(finding.start, finding.end).toString(), matched);
    assert.equal(finding.start, Buffer.from(source).lastIndexOf(Buffer.from(matched)));
    assert.match(finding.suggestion, /Verify/);
    assert.match(finding.suggestion, /uncertainty/);
  }
  for (const source of controls) {
    const report = await runtime.analyze(source, profile);
    assert.equal(report.incomplete, false);
    assert.deepEqual(report.findings.filter((finding) => finding.ruleId === id), [], source);
  }
  const mixed = await runtime.analyze(
    "The client is blazingly fast. Reliability is ensured by rigorous testing.", profile);
  assert.equal(mixed.incomplete, false);
  const findings = mixed.findings.filter((finding) => finding.ruleId === id);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].related.length, 1);
  assert.match(findings[0].suggestion, /Verify their basis before removing or weakening any claim/);
  assert.match(findings[0].suggestion, /established commitments/);
  console.log(`promotional degree: ${profile}: five source probes, seven controls, and mixed verification passed`);
}
assert.deepEqual(runtime.panics, []);
console.log(`promotional degree: passed on ${runtime.info.commit}`);
process.exit(0);
