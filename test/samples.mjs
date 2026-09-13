/**
 * Checks that the three sample documents still mean what the page says they do.
 *
 * The samples are the page's only claim about the engine that a visitor reads
 * before pressing anything: one document is described as AI-flavoured, one as
 * its revision, and the revision is described as clean. All three run through
 * the real engine here, so a rule change upstream that turns the revision dirty
 * fails the build instead of making the page a liar.
 *
 * Run it with `npm test` in web/, or directly:
 *
 *   node test/samples.mjs
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { boot, repoRoot } from "./harness.mjs";

const samples = join(repoRoot, "web/samples");

/**
 * What each sample has to be, stated as the page states it.
 *
 * `minFindings` is a floor rather than an exact count on purpose: a new rule
 * upstream that catches more of a deliberately bad document is not a
 * regression. Zero on the revision IS exact, for the same reason.
 */
const expectations = [
  {
    file: "ai-flavoured.md",
    format: "markdown",
    minFindings: 12,
    // The page describes this one as failing the gate under both profiles.
    gate: { technical: false, strict: false },
  },
  {
    file: "revised.md",
    format: "markdown",
    exactFindings: 0,
    gate: { technical: true, strict: true },
  },
  {
    file: "retry_client.py",
    format: "python",
    minFindings: 6,
    gate: { technical: false, strict: false },
  },
];

const failures = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

const runtime = await boot();
console.log(
  `samples: unswell ${runtime.info.version} (${runtime.info.commit.slice(0, 12)}), ` +
    `${runtime.info.rules.length} rules, ${runtime.info.goVersion}`,
);

for (const expected of expectations) {
  const text = await readFile(join(samples, expected.file), "utf8");
  for (const profile of ["technical", "strict"]) {
    const report = await runtime.analyze(text, profile, expected.format);
    const label = `${expected.file} [${profile}]`;

    check(!report.incomplete, `${label}: the run came back incomplete: ${report.notes ?? ""}`);

    if (expected.exactFindings !== undefined) {
      check(
        report.findings.length === expected.exactFindings,
        `${label}: ${report.findings.length} finding(s), expected exactly ${expected.exactFindings}` +
          (report.findings.length > 0
            ? `\n  ${report.findings.map((f) => `${f.ruleId} @${f.line}:${f.column} ${JSON.stringify(f.message)}`).join("\n  ")}`
            : ""),
      );
    }
    if (expected.minFindings !== undefined) {
      check(
        report.findings.length >= expected.minFindings,
        `${label}: ${report.findings.length} finding(s), expected at least ${expected.minFindings}`,
      );
    }
    check(
      report.gate.passed === expected.gate[profile],
      `${label}: gate passed=${report.gate.passed}, expected ${expected.gate[profile]}`,
    );

    // Every mark the page draws has to land inside the document it draws it
    // on, and every unit it segments by has to be a real range. A span that
    // escapes the text is a rendering bug that looks like a rule bug.
    const size = Buffer.byteLength(text, "utf8");
    for (const finding of report.findings) {
      check(
        finding.start >= 0 && finding.end > finding.start && finding.end <= size,
        `${label}: ${finding.ruleId} has span ${finding.start}..${finding.end} outside 0..${size}`,
      );
      for (const segment of finding.segments) {
        check(
          segment.start >= finding.start && segment.end <= finding.end,
          `${label}: ${finding.ruleId} has a segment outside its own span`,
        );
      }
    }
    for (const unit of report.units) {
      check(
        unit.start >= 0 && unit.end > unit.start && unit.end <= size,
        `${label}: unit ${unit.id} has span ${unit.start}..${unit.end} outside 0..${size}`,
      );
    }

    const rules = [...new Set(report.findings.map((f) => f.ruleId))].sort();
    console.log(
      `samples: ${label.padEnd(30)} ${String(report.findings.length).padStart(3)} finding(s), ` +
        `max index ${String(report.maxIndex).padStart(6)}, gate ${report.gate.passed ? "pass" : "FAIL"}` +
        (rules.length > 0 ? `\n         ${rules.join(", ")}` : ""),
    );
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`samples: ${failure}`);
  console.error(`samples: ${failures.length} problem(s)`);
  process.exit(1);
}
console.log("samples: all three samples are what the page says they are");
process.exit(0);
