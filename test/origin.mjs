/**
 * Checks what the experimental origin channel does at the host boundary.
 *
 * The channel is optional and it abstains often, so its absence is easy to
 * mistake for its silence. This test pins the difference. An estimate is
 * expected where the shipped pack accepted a paragraph; a stated reason is
 * expected everywhere else; and `incompatible_model`, which means the engine
 * refused the pack outright, is expected nowhere.
 *
 * That last one is the regression of issue 5. The pack is fitted on text
 * prepared without document structure, any enabled rule that requires
 * structure changes how the run prepares text, and the engine then refuses the
 * pack for the whole run. The build answers that by estimating in an engine of
 * its own; see originOverrides in runtime/unswell/cmd/unswell-wasm/engines.go.
 *
 * Run it with `make test`, or directly:
 *
 *   node test/origin.mjs
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { boot, repoRoot } from "./harness.mjs";

const samples = join(repoRoot, "web/samples");

// The statuses this build knows how to explain. A status outside this set
// reaches the page as raw text, which is a worse answer than a sentence, so
// the test names the set rather than accepting anything.
const known = new Set(["available", "unsupported_unit", "insufficient_evidence", "no_prose",
  "engine_unavailable", "run_failed"]);

const failures = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

const runtime = await boot();

/** A document the pack accepts: some paragraphs estimated, the channel available. */
async function available(file, profile) {
  const text = await readFile(join(samples, file), "utf8");
  const report = await runtime.analyze(text, profile, "markdown");
  const label = `${file} [${profile}]`;
  const estimates = report.units.filter((unit) => typeof unit.origin === "number");

  check(report.origin !== undefined, `${label}: the report carries no origin channel state`);
  check(report.origin?.available === true,
    `${label}: channel available=${report.origin?.available}, expected true ` +
      `(status ${report.origin?.status}, reason ${JSON.stringify(report.origin?.reason)})`);
  check(report.origin?.status === "available",
    `${label}: channel status ${JSON.stringify(report.origin?.status)}, expected "available"`);
  check(estimates.length > 0, `${label}: no paragraph carries an estimate`);
  check(estimates.every((unit) => unit.origin >= 0 && unit.origin <= 1),
    `${label}: an estimate falls outside 0..1: ${estimates.map((u) => u.origin).join(", ")}`);

  for (const unit of report.units) {
    const stated = typeof unit.origin === "number" || (unit.originStatus ?? "") !== "";
    check(stated, `${label}: unit ${unit.id} carries neither an estimate nor a reason`);
    check(unit.originStatus === undefined || known.has(unit.originStatus),
      `${label}: unit ${unit.id} reports unknown status ${JSON.stringify(unit.originStatus)}`);
    check(unit.originStatus !== "incompatible_model",
      `${label}: unit ${unit.id} reports incompatible_model; the shipped pack was refused`);
  }
  return estimates.length;
}

/** A document the pack cannot estimate: no numbers, one stated reason. */
async function unavailable(name, text, expected) {
  const report = await runtime.analyze(text, "technical", "markdown");
  const label = `${name} [technical]`;

  check(report.origin?.available === false,
    `${label}: channel available=${report.origin?.available}, expected false`);
  check(report.origin?.status === expected,
    `${label}: channel status ${JSON.stringify(report.origin?.status)}, expected ${JSON.stringify(expected)}`);
  check((report.origin?.reason ?? "").trim().length > 0,
    `${label}: the channel states no reason a reader could act on`);
  check((report.origin?.reason ?? "").trim().endsWith("."),
    `${label}: the reason is not a sentence: ${JSON.stringify(report.origin?.reason)}`);
  check(report.units.every((unit) => typeof unit.origin !== "number"),
    `${label}: a paragraph carries an estimate while the channel says it is unavailable`);
}

const flavored = await available("ai-flavored.md", "technical");
await available("ai-flavored.md", "strict");
await available("revised.md", "technical");

// Short prose: every paragraph is inside the engine but outside what the pack
// can answer, so the channel is unavailable for a reason that is not a defect.
await unavailable("short prose", "# Title\n\nShort line here.\n", "insufficient_evidence");
// No prose at all: the channel has nothing to measure and says so.
await unavailable("empty input", "\n", "no_prose");

// The findings the page prints must not move because the channel exists. The
// origin engine disables rules, and if its rule set ever reached the report,
// this is where it would show.
const text = await readFile(join(samples, "ai-flavored.md"), "utf8");
const report = await runtime.analyze(text, "technical", "markdown");
check(report.findings.some((finding) => finding.ruleId.startsWith("repetition.")),
  "ai-flavored.md: no repetition finding survived; the origin engine's rule set reached the report");

console.log(
  `origin: unswell ${runtime.info.version} (${runtime.info.commit.slice(0, 12)}); ` +
    `${flavored} estimate(s) on the AI-flavored sample, both unavailable paths stated`,
);

if (failures.length > 0) {
  console.error(`origin: ${failures.length} failure(s)`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log("origin: estimates where the pack accepts, a stated reason everywhere else");
