/**
 * Drives the host boundary outside a browser.
 *
 * This is the test that catches the failures the samples test cannot see,
 * because they are not about rules at all: a method missing from the contract,
 * an analysis that resolves before analyze() returns, a bad profile that takes
 * the runtime down instead of coming back as a failure, a second analysis
 * accepted while the first is still running.
 *
 *   node test/contract.mjs
 */

import { boot } from "./harness.mjs";

const failures = [];

function check(condition, message) {
  if (condition) {
    console.log(`contract: ok   ${message}`);
  } else {
    failures.push(message);
    console.error(`contract: FAIL ${message}`);
  }
}

const runtime = await boot();

/* ---------- ready() says what this build is ---------- */

const info = runtime.info;
check(typeof info.version === "string" && info.version !== "", "ready() carries a version");
check(/^[0-9a-f]{40}$/.test(info.commit), "ready() carries a full commit sha");
check(info.goVersion.startsWith("go"), "ready() carries the Go version that linked it");
check(Array.isArray(info.rules) && info.rules.length > 0, "ready() carries the rule catalog");
check(
  info.rules.every((rule) => rule.id && rule.version && rule.group),
  "every rule in the catalog is identified",
);
check(
  info.rules.length === runtime.manifest.rules.length,
  `the binary reports ${info.rules.length} rules and the manifest lists ${runtime.manifest.rules.length}`,
);
check(
  info.rules.every((rule, i) => rule.id === runtime.manifest.rules[i].id),
  "the manifest's rule list is the binary's rule list, in the same order",
);
check(
  JSON.stringify(info.profiles) === JSON.stringify(["technical", "strict"]),
  "ready() offers exactly the two profiles the page shows",
);
// The page says beside the profile control what each profile runs. It can
// only say what the engine told it, so the announcement is checked here.
const catalog = info.rules.map((rule) => rule.id);
const inCatalogOrder = (ids) => ids.every((id, i) => catalog.includes(id) && (i === 0 || catalog.indexOf(ids[i - 1]) < catalog.indexOf(id)));
for (const name of info.profiles) {
  const policy = info.policies?.[name];
  check(
    policy && Array.isArray(policy.enabled) && policy.enabled.length > 0 && inCatalogOrder(policy.enabled),
    `ready() says which rules the ${name} profile runs, in catalog order`,
    policy ? `${policy.enabled.length} rule(s)` : "no policy",
  );
  check(
    policy && Number.isInteger(policy.paragraphFailAt) && Number.isInteger(policy.sentenceFailAt) &&
      policy.paragraphFailAt > 0 && policy.paragraphFailAt <= 100 && policy.sentenceFailAt > 0 && policy.sentenceFailAt <= 100,
    `ready() says at which index the ${name} gate fails a paragraph and a sentence`,
  );
  check(
    policy && policy.forbid.every((id) => policy.enabled.includes(id)),
    `every rule that fails the ${name} gate on a match is a rule that profile runs`,
    policy ? `${policy.forbid.length} rule(s)` : "no policy",
  );
}
{
  const technical = info.policies.technical;
  const strict = info.policies.strict;
  check(
    technical.enabled.every((id) => strict.enabled.includes(id)) && strict.enabled.length > technical.enabled.length,
    "strict runs every rule that technical runs, and more",
    `${technical.enabled.length} and ${strict.enabled.length}`,
  );
  check(
    technical.forbid.every((id) => strict.forbid.includes(id)) && strict.forbid.length > technical.forbid.length,
    "strict fails the gate on every match that technical does, and on more",
    `${technical.forbid.length} and ${strict.forbid.length}`,
  );
  check(
    strict.paragraphFailAt < technical.paragraphFailAt && strict.sentenceFailAt < technical.sentenceFailAt,
    "strict fails a paragraph and a sentence at a lower index than technical",
  );
}
check(
  JSON.stringify(info.formats) === JSON.stringify(["markdown", "mdx", "python"]),
  "ready() offers exactly the three formats the page shows",
);

/* ---------- analyze() returns before the work runs ---------- */

// The Go side dispatches through setTimeout precisely so that this holds. A
// bare goroutine would run the whole analysis inside the analyze() call, and
// the page would paint its "analyzing" state after the answer had arrived.
const pending = runtime.start("It is important to note that the client opens connections.");
const first = await pending.settled;
check(
  runtime.answeredInsideAnalyze() === false,
  "no answer arrived while an analyze() call was still on the stack",
);
check(first.findings.length >= 1, "a phrase the catalog forbids produces a finding");
check(first.durationMs >= 0, "the report carries the time the engine spent");

/* ---------- the payload is complete enough to render ---------- */

const sample = await runtime.analyze(
  "# Title\n\nIt is important to note that the client opens connections.\n",
);
check(sample.units.length > 0, "the report carries the paragraph ranges the page segments by");
check(
  sample.units.every((unit) => unit.end > unit.start),
  "every unit range is non-empty",
);
check(
  sample.findings.every((finding) => finding.segments.length > 0),
  "every finding carries at least one source segment",
);
check(
  sample.findings.every((finding) => finding.context === "Title"),
  "a finding under a heading carries that heading as its context",
);
check(typeof sample.gate.passed === "boolean", "the report carries the gate decision");
check(sample.kind === "report", "an analysis answers with a report");
check(
  sample.aiSounding?.status === "too_short" && sample.aiSounding.words > 0,
  "a short Markdown page carries the engine's reason for no AI-sounding index",
);
check(
  sample.engine.version !== "" && sample.engine.scoringProfile !== "",
  "the report carries the engine identity it was produced by",
);

/* ---------- a second analysis while one is running is refused ---------- */

const long = "The client opens a connection. ".repeat(400);
const busy = runtime.start(long);
const racer = runtime.start("It is important to note that the client opens connections.");
const outcome = await racer.settled.then(
  () => "accepted",
  (err) => err.message,
);
check(
  outcome.includes("analyzes one document at a time"),
  `a concurrent analysis is refused through failed(): ${outcome}`,
);
await busy.settled;

/* ---------- bad input is a failure, not a dead runtime ---------- */

for (const [label, args] of [
  ["an unknown format", ["text", "technical", "cobol"]],
  ["an unknown profile", ["text", "lenient", "markdown"]],
]) {
  const message = await runtime.analyze(...args).then(
    () => "accepted",
    (err) => err.message,
  );
  check(message.startsWith("unswell-wasm:"), `${label} comes back as a failure: ${message}`);
}

/* ---------- fix() answers on the same channel ---------- */

const fixed = await runtime.fix("# Title\n\nThe client opens — and closes — connections.\n");
check(fixed.kind === "fix", "a fix answers through result() with a payload of its own kind");
check(
  fixed.indexed === false && fixed.changed === false && fixed.text.includes("—"),
  "a page too short for the index is returned as it was",
);

// And the runtime is still alive after all of that.
const after = await runtime.analyze("It is important to note that the client opens connections.");
check(after.findings.length >= 1, "the runtime still answers after four rejected requests");
check(runtime.panics.length === 0, "nothing panicked");

if (failures.length > 0) {
  console.error(`contract: ${failures.length} problem(s)`);
  process.exit(1);
}
console.log("contract: the host boundary holds");
process.exit(0);
