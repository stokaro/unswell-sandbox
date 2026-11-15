// The marks of the AI-sounding index go through the same renderer as the
// findings. A small DOM fixture keeps the slices observable without a browser;
// it does not emulate layout. The numbers and the words themselves are compared
// with the published CLI in test/ai-sounding.mjs.
import assert from "node:assert/strict";
import test from "node:test";
import { ByteText, indexMarkId, listsIndexMarks, renderReport } from "./render.ts";
import { renderRail } from "./rail.ts";

class Element {
  children = [];
  dataset = {};
  style = {};
  attributes = {};
  text = "";
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(name, value) { this.attributes[name] = value; }
  set textContent(value) { this.text = value; this.children = []; }
  get textContent() { return this.text + this.children.map((n) => n.textContent).join(""); }
}

function fixtureDOM(t) {
  const previous = globalThis.document;
  globalThis.document = {
    createElement: () => new Element(),
    createDocumentFragment: () => new Element(),
    createTextNode: (text) => ({ textContent: text }),
  };
  t.after(() => {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  });
}

/** Every element under a node, in document order. */
function all(node) {
  const found = [];
  for (const child of node.children ?? []) found.push(child, ...all(child));
  return found;
}

/** The source text a rendered document spells, without the score in each gutter. */
function spelled(node) {
  if (node.className === "para-gutter") return "";
  if (!node.children) return node.textContent;
  return (node.text ?? "") + node.children.map(spelled).join("");
}

const text = "- **Label:** the client waits — then it retries.\n\nA seamless end.\n";
const bytes = Buffer.from(text);
const range = (value) => ({ start: bytes.indexOf(value), end: bytes.indexOf(value) + Buffer.byteLength(value) });
const label = range("**Label:**");
const dash = range("—");
const word = range("seamless");

function reportAt(level) {
  return {
    kind: "report",
    profile: "technical",
    format: "markdown",
    findings: [],
    gate: { passed: true, reasons: [] },
    maxIndex: 0,
    document: { proseWords: 200, blocks: 2, sentences: 2 },
    // The engine's paragraph starts at the label's text, after the opening
    // asterisks, which is why a mark has to be drawn between units too.
    units: [
      { id: 0, start: label.start + 2, end: range("retries.").end, score: 0, words: 8 },
      { id: 1, start: range("A seamless").start, end: range("end.").end, score: 0, words: 3 },
    ],
    aiSounding: {
      status: "available",
      index: level === "low" ? 12 : 64,
      level,
      words: 200,
      summary: "1 em dash, 1 stock word, 1 list item that starts with a bold label.",
      signals: [],
      counted: 3,
      fixable: 2,
      advice: "`unswell fix --write` makes the replacements named above. A stock word needs your own words.",
      about: "The index counts marks. It is not a probability.",
      marks: [
        { signal: "bold-label-in-list", ...label, line: 1, column: 3,
          note: level === "low" ? undefined : "list item that starts with a bold label; remove the bold",
          fix: { ...label, text: "Label:" } },
        { signal: "em-dash", ...dash, line: 1, column: 31,
          note: level === "low" ? undefined : "em dash; write a comma",
          fix: { start: dash.start - 1, end: dash.end + 1, text: ", " } },
        { signal: "stock-word", ...word, line: 3, column: 3, word: "seamless",
          note: level === "low" ? undefined : 'stock word "seamless"; say what the thing does, or drop the word' },
      ],
    },
  };
}

test("a mark of the index that opens before its paragraph is drawn on both sides of the boundary", (t) => {
  fixtureDOM(t);
  const report = reportAt("elevated");
  const original = JSON.stringify(report);
  assert.equal(listsIndexMarks(report), true);
  const rendered = renderReport(new ByteText(text), report);

  assert.deepEqual(rendered.marks.get(indexMarkId(0)).map((mark) => mark.textContent), ["**", "Label:**"]);
  assert.deepEqual(rendered.marks.get(indexMarkId(1)).map((mark) => mark.textContent), ["—"]);
  assert.deepEqual(rendered.marks.get(indexMarkId(2)).map((mark) => mark.textContent), ["seamless"]);
  for (const marks of rendered.marks.values()) {
    assert.equal(marks.every((mark) => mark.className === "mark mark-ai"), true);
    assert.equal(marks.some((mark) => mark.children.some((child) => child.className === "mark-index")), false,
      "a mark of the index carries no finding number");
  }
  // Nothing is lost or repeated: the rendered pieces spell the source.
  assert.equal(spelled(rendered.root), text);
  assert.equal(JSON.stringify(report), original, "the renderer must not mutate the engine report");
});

test("the rail lists each mark of the index in the CLI's words and offers the fix", (t) => {
  fixtureDOM(t);
  const report = reportAt("elevated");
  const body = new Element();
  const { notes } = renderRail(body, report);

  assert.deepEqual([...notes.keys()], [indexMarkId(0), indexMarkId(1), indexMarkId(2)]);
  const note = notes.get(indexMarkId(1));
  assert.equal(note.dataset.finding, indexMarkId(1));
  assert.equal(note.textContent, "1:31em dash; write a comma");

  const elements = all(body);
  const card = elements.find((node) => node.className === "index-card");
  assert.equal(card.dataset.level, "elevated");
  assert.equal(elements.find((node) => node.className === "index-value").textContent, "64 / 100");
  const fix = elements.find((node) => node.dataset?.action === "fix");
  assert.equal(fix.textContent, "Fix 2 marks");
  assert.equal(elements.some((node) => node.dataset?.action === "undo-fix"), false);
  assert.equal(elements.find((node) => node.className === "rail-section").textContent, "Marks of the index · 3");
});

test("a page at the level low shows its number and none of its marks", (t) => {
  fixtureDOM(t);
  const report = reportAt("low");
  assert.equal(listsIndexMarks(report), false);
  const rendered = renderReport(new ByteText(text), report);
  assert.equal(rendered.marks.size, 0);
  assert.equal(spelled(rendered.root), text);

  const body = new Element();
  const { notes } = renderRail(body, report);
  assert.equal(notes.size, 0);
  const elements = all(body);
  assert.equal(elements.find((node) => node.className === "index-card").dataset.level, "low");
  assert.equal(elements.some((node) => node.dataset?.action === "fix"), false);
  // `unswell fix` leaves a low page as it is; the page offers --include-low by name.
  assert.equal(elements.find((node) => node.dataset?.action === "fix-low").textContent,
    "Replace them anyway (--include-low)");
});

test("the rail reports a fix beside the text it produced, and offers the undo only there", (t) => {
  fixtureDOM(t);
  const report = reportAt("elevated");
  const fix = {
    kind: "fix", changed: true,
    summary: "AI-sounding index 64 -> 41; removed 1 em dash, 1 bold label. Left for you: 1 stock word.",
    caution: "A replacement is mechanical.",
  };
  const shown = all(renderInto(report, { fix, undoable: true }));
  const card = shown.find((node) => node.className === "note-fix");
  assert.equal(card.textContent.startsWith(`unswell fix ${fix.summary}`), true);
  assert.equal(card.textContent.includes(fix.caution), true);
  assert.equal(shown.some((node) => node.dataset?.action === "undo-fix"), true);

  const unchanged = all(renderInto(report, {
    fix: { ...fix, changed: false, summary: "AI-sounding index 64; nothing to replace. Left for you: 1 stock word." },
    undoable: false,
  }));
  assert.equal(unchanged.some((node) => node.dataset?.action === "undo-fix"), false);
  assert.equal(unchanged.find((node) => node.className === "note-fix").textContent.includes(fix.caution), false);
});

function renderInto(report, fixNote) {
  const body = new Element();
  renderRail(body, report, fixNote);
  return body;
}

test("a text without an index says why", (t) => {
  fixtureDOM(t);
  const short = reportAt("elevated");
  short.aiSounding = { status: "too_short", index: 0, words: 42, signals: [], marks: [], counted: 0, fixable: 0 };
  const card = (report) => all(renderInto(report, null)).find((node) => node.className === "index-card");
  assert.equal(card(short).dataset.level, "none");
  assert.match(card(short).textContent, /42 prose words\. The index covers a Markdown page of 150 prose words or more\./);

  const python = reportAt("elevated");
  delete python.aiSounding;
  python.format = "python";
  assert.match(card(python).textContent, /The index is measured on Markdown pages\. This text was read as python\./);
});
