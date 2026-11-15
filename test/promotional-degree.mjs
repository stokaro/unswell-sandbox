// The page follows the CLI: a rule that is enabled only by name reports nothing here.
// `filler.unscoped-assurance` is such a rule, in the default and in the strict profile.
import assert from "node:assert/strict";
import { boot } from "./harness.mjs";

const runtime = await boot();
assert.equal(runtime.info.commit, runtime.manifest.unswellCommit);
const id = "filler.unscoped-assurance";
// The rule is still in the catalog that the page announces.
assert.equal(runtime.manifest.rules.find((rule) => rule.id === id).version, "12");
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
  for (const [format, source] of positives) {
    const report = await runtime.analyze(source, profile, format);
    assert.equal(report.incomplete, false, `${profile}: ${format}`);
    assert.deepEqual(report.findings.filter((finding) => finding.ruleId === id), [], `${profile}: ${source}`);
  }
  for (const source of controls) {
    const report = await runtime.analyze(source, profile);
    assert.equal(report.incomplete, false);
    assert.deepEqual(report.findings.filter((finding) => finding.ruleId === id), [], source);
  }
  console.log(`promotional degree: ${profile}: the rule enabled by name stays silent on five probes and seven controls`);
}
assert.deepEqual(runtime.panics, []);
console.log(`promotional degree: passed on ${runtime.info.commit}`);
process.exit(0);
