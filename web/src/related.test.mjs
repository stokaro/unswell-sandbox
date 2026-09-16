// A small DOM fixture exercises the public renderer without a browser. It keeps
// the source segments and unit boundaries observable; it does not emulate layout.
import assert from "node:assert/strict";
import test from "node:test";
import { ByteText, renderReport } from "./render.ts";

class Element {
  children = [];
  dataset = {};
  style = {};
  attributes = {};
  text = "";
  append(...nodes) { this.children.push(...nodes); }
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

test("related evidence is marked across paragraphs with mapped markup gaps and one badge", (t) => {
  fixtureDOM(t);
  const text = "Café 🙂. First clause. Second **clause**.\n\nThird clause.";
  const bytes = Buffer.from(text);
  const range = (value) => ({ start: bytes.indexOf(value), end: bytes.indexOf(value) + Buffer.byteLength(value) });
  const first = range("First clause");
  const second = range("Second **clause**");
  const secondWord = { start: second.start + Buffer.byteLength("Second **"), end: second.end - 2 };
  const third = range("Third clause");
  const report = {
    findings: [{
      id: "group", ruleId: "syntax.repeated-reframing", severity: "note", scope: "document", message: "A grouped construction",
      ...first, segments: [first],
      related: [
        { ...second, segments: [range("Second"), secondWord] },
        { ...third, segments: [third] },
      ],
    }],
    units: [
      { id: 0, start: 0, end: second.end + 1, score: 0, words: 7 },
      { id: 1, start: third.start, end: bytes.length, score: 0, words: 2 },
    ],
  };
  const original = JSON.stringify(report);
  const rendered = renderReport(new ByteText(text), report);
  const marks = rendered.marks.get("group");
  assert.deepEqual(marks.map((mark) => mark.textContent), ["First clause", "Second", "clause", "Third clause1"]);
  assert.equal(marks.filter((mark) => mark.children.some((child) => child.className === "mark-index")).length, 1);
  assert.equal(marks.every((mark) => mark.dataset.finding === "group"), true);
  assert.equal(rendered.root.children.filter((node) => node.className === "para").length, 2);
  assert.equal(JSON.stringify(report), original, "the renderer must not mutate the engine report");
});
