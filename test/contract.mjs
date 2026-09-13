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
check(
  JSON.stringify(info.formats) === JSON.stringify(["markdown", "python"]),
  "ready() offers exactly the two formats the page shows",
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
