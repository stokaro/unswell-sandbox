/**
 * Checks the AI-sounding index and the fix against the published CLI.
 *
 * The page shows three things here that a visitor can compare with the tool
 * they install: the index of a Markdown page, what to do at each mark, and the
 * text after the replacements of `unswell fix`. The fixtures under
 * test/fixtures/cli-v0.1.0-alpha.12 are what the published binary wrote for the
 * Markdown sample, and every one of the three is compared with them.
 *
 * The words beside a mark are lines of the CLI's own text report, cut out of
 * it in Go. A release that rewords that report would leave them empty, and
 * this test fails on an empty note rather than letting the page go quiet.
 *
 *   node test/ai-sounding.mjs
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { boot, repoRoot } from "./harness.mjs";

const fixtures = join(repoRoot, "test/fixtures/cli-v0.1.0-alpha.12");
const read = (path) => readFile(path, "utf8");

const runtime = await boot();
assert.equal(runtime.info.version, "v0.1.0-alpha.12",
  "the fixtures are the output of the alpha.12 binary; make them again for another pin");

const sample = await read(join(repoRoot, "web/samples/ai-flavored.md"));
const bytes = Buffer.from(sample);
const cliIndex = (await read(join(fixtures, "ai-flavored.index.txt"))).trimEnd().split("\n");
const cliFix = (await read(join(fixtures, "ai-flavored.fix.txt"))).trimEnd().split("\n");
const cliFixed = await read(join(fixtures, "ai-flavored.fixed.md"));

/* ---------- the index is the CLI's index ---------- */

const header = /^AI-sounding index: (\d+) of 100 \((low|elevated|high)\) in playground\.md: (.*)$/.exec(cliIndex[0]);
assert.ok(header, `the fixture starts with the index line: ${cliIndex[0]}`);
const about = cliIndex[cliIndex.length - 1];
const advice = cliIndex[cliIndex.length - 2];
const cliMarks = cliIndex.slice(1, -2);

for (const profile of ["technical", "strict"]) {
  const report = await runtime.analyze(sample, profile);
  assert.equal(report.kind, "report");
  const index = report.aiSounding;
  assert.ok(index, `${profile}: a Markdown page carries its index`);
  assert.equal(index.status, "available");
  assert.equal(index.index, Number(header[1]), `${profile}: the index is the CLI's`);
  assert.equal(index.level, header[2], `${profile}: the level is the CLI's`);
  assert.equal(index.summary, header[3], `${profile}: the counts are the CLI's line`);
  assert.equal(index.advice, advice);
  assert.equal(index.about, about);
  assert.equal(index.unlisted, undefined);

  // One line of the CLI's report for each mark, in the same order.
  assert.deepEqual(
    index.marks.map((mark) => `  playground.md:${mark.line}:${mark.column}: ${mark.note}`),
    cliMarks,
    `${profile}: every mark says what the CLI says at the same place`,
  );
  assert.equal(index.counted, index.signals.reduce((sum, signal) => sum + signal.count, 0));
  assert.equal(index.counted, cliMarks.length);
  assert.equal(index.fixable, index.marks.filter((mark) => mark.fix).length);

  for (const mark of index.marks) {
    assert.ok(mark.start >= 0 && mark.end > mark.start && mark.end <= bytes.length,
      `${profile}: the ${mark.signal} mark at ${mark.line}:${mark.column} lies inside the page`);
    if (mark.word) {
      assert.equal(bytes.subarray(mark.start, mark.end).toString().toLowerCase(), mark.word);
    }
    if (mark.fix) {
      assert.ok(mark.fix.start <= mark.start && mark.fix.end >= mark.end,
        `${profile}: the replacement at ${mark.line}:${mark.column} covers its mark`);
      assert.ok(mark.fix.start >= 0 && mark.fix.end <= bytes.length);
    } else {
      assert.equal(mark.signal, "stock-word", "in this sample only a stock word has no replacement");
    }
  }
  const marked = (signal) => index.marks.filter((mark) => mark.signal === signal)
    .map((mark) => bytes.subarray(mark.start, mark.end).toString());
  assert.deepEqual(marked("em-dash"), ["—", "—", "—", "—", "—"]);
  assert.deepEqual(marked("arrow"), ["→", "→"]);
  assert.deepEqual(marked("emoji-in-heading"), ["✨"]);
  assert.deepEqual(marked("emoji-at-list-item"), ["🚀"]);
  assert.deepEqual(marked("bold-label-in-list"), ["**Retries:**", "**Backoff:**"]);
  console.log(`ai-sounding: ${profile}: index ${index.index} (${index.level}), ` +
    `${index.marks.length} marks in the CLI's words`);

  /* ---------- the fix writes the CLI's text ---------- */

  const fixed = await runtime.fix(sample, profile, "markdown", false);
  assert.equal(fixed.kind, "fix");
  assert.equal(fixed.text, cliFixed, `${profile}: the fixed page is byte for byte what unswell fix wrote`);
  assert.equal(`playground.md: ${fixed.summary}`, cliFix[0], `${profile}: the summary is the CLI's line`);
  assert.equal(fixed.caution, cliFix[cliFix.length - 1]);
  assert.equal(fixed.changed, true);
  assert.equal(fixed.indexed, true);
  assert.equal(fixed.leftLow, false);
  assert.equal(fixed.before, index.index);
  const after = await runtime.analyze(fixed.text, profile);
  assert.equal(fixed.after, after.aiSounding.index, `${profile}: the index after is the index of the fixed text`);
  assert.equal(after.aiSounding.fixable, 0, `${profile}: no mechanical replacement is left`);
  assert.deepEqual(fixed.left, { "stock-word": after.aiSounding.marks.length });

  // A second fix has nothing to replace and returns the same text.
  const again = await runtime.fix(fixed.text, profile, "markdown", false);
  assert.equal(again.changed, false);
  assert.equal(again.text, fixed.text);
  assert.match(again.summary, /nothing to replace\. Left for you: 7 stock words\.$/);
  console.log(`ai-sounding: ${profile}: fix ${fixed.before} -> ${fixed.after}, the CLI's text and line`);
}

/* ---------- a page at the level low is left as it is ---------- */

const revision = await read(join(repoRoot, "web/samples/revised.md"));
const quiet = await runtime.analyze(revision);
assert.equal(quiet.aiSounding.status, "available");
assert.equal(quiet.aiSounding.level, "low");
assert.equal(quiet.aiSounding.marks.every((mark) => !mark.note), true,
  "the CLI lists no marks at the level low, so no mark carries its words");

// One em dash in about 900 prose words: the index counts it and stays low.
const dash = "The client waits for the server — then it sends the request again.";
const lowPage = `${Array.from({ length: 5 }, () => revision).join("\n")}\n${dash}\n`;
const low = await runtime.analyze(lowPage);
assert.equal(low.aiSounding.level, "low", `one dash in ${low.aiSounding.words} words stays at the level low`);
assert.equal(low.aiSounding.fixable, 1);
const left = await runtime.fix(lowPage, "technical", "markdown", false);
assert.equal(left.leftLow, true);
assert.equal(left.changed, false);
assert.equal(left.text, lowPage);
const included = await runtime.fix(lowPage, "technical", "markdown", true);
assert.equal(included.leftLow, false);
assert.equal(included.changed, true);
assert.equal(included.text.includes("—"), false);
assert.deepEqual(included.removed, { "em-dash": 1 });
console.log("ai-sounding: a low page is left as it is, and --include-low replaces its marks");

/* ---------- the index needs a Markdown page of 150 prose words ---------- */

const words = (count) => `# Page\n\n${Array.from({ length: count }, (_, i) => (i % 9 === 8 ? "word." : "word")).join(" ")}\n`;
const short = await runtime.analyze(words(148));
assert.equal(short.aiSounding.status, "too_short");
assert.equal(short.aiSounding.words, 149, "the heading counts as one prose word");
assert.equal(short.aiSounding.marks.length, 0);
const enough = await runtime.analyze(words(149));
assert.equal(enough.aiSounding.status, "available");
assert.equal(enough.aiSounding.words, 150);
const shortFix = await runtime.fix(words(148), "technical", "markdown", true);
assert.equal(shortFix.indexed, false);
assert.equal(shortFix.changed, false);

for (const [format, text] of [
  ["mdx", await read(join(repoRoot, "web/samples/correlate-messages.mdx"))],
  ["python", await read(join(repoRoot, "web/samples/retry_client.py"))],
]) {
  const other = await runtime.analyze(text, "technical", format);
  assert.equal(other.aiSounding, undefined, `${format}: the engine measures no index outside Markdown`);
  const untouched = await runtime.fix(text, "technical", format, true);
  assert.equal(untouched.indexed, false);
  assert.equal(untouched.text, text);
}
console.log("ai-sounding: no index under 150 prose words, and none outside Markdown");

/* ---------- more marks than the CLI lists ---------- */

// The CLI's report lists 60 marks in one run and says how many it left out.
// The engine locates up to 200 on one page and keeps counting past that.
const dashes = (count) => `# Page\n\n${Array.from({ length: count }, (_, i) =>
  `The client number ${i} waits — and then it sends the request again.`).join("\n\n")}\n`;
const many = (await runtime.analyze(dashes(70))).aiSounding;
assert.equal(many.counted, 70);
assert.equal(many.marks.length, 70);
assert.equal(many.marks.filter((mark) => mark.note).length, 60);
assert.equal(many.marks.slice(0, 60).every((mark) => mark.note === "em dash; write a comma"), true);
assert.equal(many.unlisted, "10 more marks in playground.md are not listed here.");
const most = (await runtime.analyze(dashes(230))).aiSounding;
assert.equal(most.counted, 230);
assert.equal(most.marks.length, 200);
assert.equal(most.unlisted, "170 more marks in playground.md are not listed here.");
// One pass replaces what one analysis lists; the loop takes the rest.
const cleared = await runtime.fix(dashes(230), "technical", "markdown", false);
assert.equal(cleared.text.includes("—"), false);
assert.deepEqual(cleared.removed, { "em-dash": 230 });
console.log("ai-sounding: 60 marks carry the CLI's words, 200 are located, and the fix takes them all");

/* ---------- a fix is a run like an analysis ---------- */

const busy = runtime.start("The client opens a connection. ".repeat(400));
const refused = await runtime.fix(sample).then(() => "accepted", (err) => err.message);
assert.match(refused, /analyzes one document at a time/);
await busy.settled;
const unknown = await runtime.fix(sample, "technical", "cobol").then(() => "accepted", (err) => err.message);
assert.match(unknown, /^unswell-wasm: unsupported format/);
const noFlag = await new Promise((resolve) => {
  // The fifth argument is required, so that a page cannot fix a low page by
  // leaving it out.
  const runId = 9001;
  const previous = globalThis.__unswellHost.failed;
  globalThis.__unswellHost.failed = (id, message) => {
    if (id !== runId) return previous(id, message);
    globalThis.__unswellHost.failed = previous;
    resolve(message);
  };
  globalThis.__unswell.fix(runId, sample, "technical", "markdown");
});
assert.match(noFlag, /the fifth argument must say whether a page at the level low is fixed too/);
assert.equal(runtime.answeredInsideAnalyze(), false, "no answer arrived while a call was still on the stack");
assert.deepEqual(runtime.panics, []);

console.log(`ai-sounding: passed on ${runtime.info.commit}`);
process.exit(0);
