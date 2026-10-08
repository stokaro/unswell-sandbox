// Verify the complete diagnosis and preserved meaning through the real WASM host.
import assert from "node:assert/strict";
import { boot } from "./harness.mjs";

const runtime = await boot();
const ruleId = "filler.instruction-scaffolding";
const positives = [
  "It can also be used for associating messages with the vertex that can be helpful for tracing purposes.",
  "The client can be used to associate messages with vertices, which may be useful for tracing purposes.",
  "The worker has the ability to attach messages to records, which could be helpful for detailed request tracing purposes.",
  "The parser has the capability to correlate records, which might be useful for debugging purposes.",
  "The reader may be used for indexing files that can be useful for search purposes.",
];
const controls = [
  "The client can associate messages with vertices, which may be useful for tracing purposes.",
  "Message correlation may help with tracing.",
  "The parser can be used to correlate records, which may be useful when a trace is missing.",
  "The parser can be used to correlate records, which may be useful for two purposes.",
  "The parser can be used to correlate records, which may be useful for several purposes.",
  "The parser can be used to correlate records, which may be useful for tracing purposes if a request is slow.",
  "The parser can be used to correlate records, which may be `useful` for tracing purposes.",
  "The parser cannot be used to correlate records, which may be useful for tracing purposes.",
  "The parser can be used only by administrators to correlate records, which may be useful for tracing purposes.",
  "The manual says the parser can be used to correlate records, which may be useful for tracing purposes.",
  "The parser can be used to correlate records. This may be useful for tracing purposes.",
];

function checkFinding(finding, source, sentence) {
  assert.equal(finding.ruleVersion, "15");
  assert.equal(Buffer.from(source).subarray(finding.start, finding.end).toString(), sentence.slice(0, -1));
  assert.match(finding.message, /support and helpfulness clauses/);
  assert.match(finding.suggestion, /relative clause's antecedent/);
  assert.match(finding.suggestion, /modality of both clauses/);
  assert.match(finding.suggestion, /possible benefit is not a guarantee/);
  assert.match(finding.suggestion, /capability is not an obligation/);
}

for (const profile of ["technical", "strict"]) {
  for (const sentence of positives) {
    const source = `Café 🙂. ${sentence}`;
    const result = await runtime.analyze(source, profile);
    assert.equal(result.incomplete, false);
    const findings = result.findings.filter((finding) => finding.ruleId === ruleId);
    assert.equal(findings.length, 1, `${profile}: ${sentence}`);
    checkFinding(findings[0], source, sentence);
  }
  for (const source of controls) {
    const result = await runtime.analyze(source, profile);
    assert.equal(result.incomplete, false);
    // A support-only control can retain its older generic diagnosis.
    assert.equal(result.findings.some((finding) => finding.ruleId === ruleId &&
      /support and helpfulness clauses/.test(finding.message)), false, `${profile}: ${source}`);
  }
  const sentence = "It can be used for associating messages with vertices that may be helpful for tracing purposes.";
  const method = "This is done by using the correlation option.";
  for (const gap of [" ", "\n\n"]) {
    const source = `Café 🙂. ${sentence}${gap}${method}`;
    const result = await runtime.analyze(source, profile);
    assert.equal(result.incomplete, false);
    const findings = result.findings.filter((finding) => finding.ruleId === ruleId);
    assert.equal(findings.length, 1);
    checkFinding(findings[0], source, sentence);
    assert.equal(findings[0].related.length, 1);
    const location = findings[0].related[0];
    assert.equal(Buffer.from(source).subarray(location.start, location.end).toString(), method.slice(0, -1));
    assert.ok(location.segments.length > 0);
    assert.match(findings[0].suggestion, /methods/);
  }
  const pythonSentence = "The client can be used to associate café messages with vertices that may be helpful for request tracing purposes.";
  const source = `message = '🙂. ${pythonSentence}'\n`;
  const python = await runtime.analyze(source, profile, "python");
  assert.equal(python.incomplete, false);
  const findings = python.findings.filter((finding) => finding.ruleId === ruleId);
  assert.equal(findings.length, 1);
  checkFinding(findings[0], source, pythonSentence);

  const revision = await runtime.analyze(
    "You can use the client to associate messages with vertices that may help with tracing.", profile);
  assert.equal(revision.incomplete, false);
  assert.equal(revision.findings.length, 0);
  console.log(`usefulness-purpose: ${profile}: five constructions, eleven controls, method ownership, Python spans, and revision passed`);
}
assert.deepEqual(runtime.panics, []);
console.log(`usefulness-purpose: passed on ${runtime.info.commit}`);
process.exit(0);
