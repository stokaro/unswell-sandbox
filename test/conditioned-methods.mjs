// Verify the actual WASM result, including both complete UTF-8 source locations.
import assert from "node:assert/strict";
import { boot } from "./harness.mjs";

const runtime = await boot();
const ruleId = "filler.instruction-scaffolding";
const pairs = [
  ["After the records have been loaded, it is safe to query the index.",
    "To do this, the `Query` method is called on the client."],
  ["Once the client is ready, it is possible to fetch the records.",
    "To do this, the `Fetch` method is called."],
  ["When the queue is initialized, it is safe to read the messages.",
    "To do that, the `Read` function is invoked with the queue handle."],
  ["After the records have been loaded, it is possible to query the index.",
    "To do this, the Query method can be called on the client."],
  ["Once the request has been prepared, it is safe to send the packet.",
    "To do that, the Send function may be invoked from the client."],
];
const first = "After the client is ready, it is safe to fetch the records.";
const second = "To do this, the `Fetch` method is called.";
const controls = [
  first, second,
  "After the client is ready, call `Fetch` to fetch records.",
  "It is safe to fetch the records. " + second,
  "After startup, it is safe to fetch the records. " + second,
  "After the client is ready, it is not safe to fetch the records. " + second,
  "After the client is ready, it is safe to fetch only cached records. " + second,
  "After the client is ready, `it is safe to` fetch the records. " + second,
  first + " To do this, a method is called.",
  first + " To do this, the `Fetch` method is called automatically.",
  first + " To do this, the `Fetch` method is called by the worker.",
  first + " To do this, the `Fetch` method is not called.",
  first + " The `Fetch` method is called.",
  first + "\n\n## Another operation\n\n" + second,
  first + "\n\n```text\nAnother operation\n```\n\n" + second,
  first + " The worker starts. " + second,
];

function checkLocations(finding, source, a, b) {
  assert.equal(finding.ruleVersion, "15");
  assert.equal(Buffer.from(source).subarray(finding.start, finding.end).toString(), a.slice(0, -1));
  assert.equal(finding.related.length, 1);
  const location = finding.related[0];
  assert.equal(Buffer.from(source).subarray(location.start, location.end).toString(), b.slice(0, -1));
  assert.ok(location.segments.length > 0);
  assert.match(finding.message, /separate method-invocation announcement/);
  assert.match(finding.suggestion, /safety or possibility qualifier/);
  assert.match(finding.suggestion, /do not turn permission or capability into an obligation/);
}

for (const profile of ["technical", "strict"]) {
  for (const [a, b] of pairs) {
    for (const gap of [" ", "\n\n"]) {
      const source = `Café 🙂. ${a}${gap}${b}`;
      const result = await runtime.analyze(source, profile);
      assert.equal(result.incomplete, false);
      const findings = result.findings.filter((finding) => finding.ruleId === ruleId);
      assert.equal(findings.length, 1, `${profile}: ${source}`);
      checkLocations(findings[0], source, a, b);
    }
  }
  for (const source of controls) {
    const result = await runtime.analyze(source, profile);
    assert.equal(result.incomplete, false);
    assert.equal(result.findings.some((finding) => finding.ruleId === ruleId), false, `${profile}: ${source}`);
  }
  const a = "After the café records have been loaded, it is safe to query the index.";
  const b = "To do this, the `Query` method is called on the client.";
  const source = `message = '🙂. ${a} ${b}'\n`;
  const result = await runtime.analyze(source, profile, "python");
  assert.equal(result.incomplete, false);
  const findings = result.findings.filter((finding) => finding.ruleId === ruleId);
  assert.equal(findings.length, 1);
  checkLocations(findings[0], source, a, b);
  console.log(`conditioned-methods: ${profile}: five paired constructions, sixteen controls, and Python UTF-8 mapping passed`);
}
assert.deepEqual(runtime.panics, []);
console.log(`conditioned-methods: passed on ${runtime.info.commit}`);
process.exit(0);
