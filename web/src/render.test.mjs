/**
 * The byte-offset mapping, tested without a DOM.
 *
 * This is the one piece of the renderer that is arithmetic rather than markup,
 * and the one that fails silently: every offset the engine sends is a UTF-8
 * byte offset, JavaScript strings are UTF-16, and prose about writing is full
 * of em dashes and curly quotes. A mapping bug does not throw -- it draws the
 * mark one character to the left, on every document with a non-ASCII character
 * before the finding.
 */

import { strict as assert } from "node:assert";
import test from "node:test";

import { ByteText, band, formatScore, isStretch, severityOf } from "./render.ts";

const encoder = new TextEncoder();

test("ByteText slices ASCII by byte offset", () => {
  const text = new ByteText("The client opens connections.");
  assert.equal(text.length, 29);
  assert.equal(text.slice(4, 10), "client");
  assert.equal(text.slice(0, 3), "The");
});

test("ByteText slices across multi-byte characters", () => {
  // "—" is three UTF-8 bytes and one UTF-16 unit; "é" is two and one.
  const source = "café — the client opens connections.";
  const text = new ByteText(source);
  assert.equal(text.length, encoder.encode(source).length);

  // The word after both multi-byte characters, found by byte offset.
  const bytes = encoder.encode(source);
  const start = Buffer.from(bytes).indexOf("client");
  assert.equal(text.slice(start, start + 6), "client");
});

test("ByteText slices across astral characters", () => {
  // U+1D518 is four UTF-8 bytes and two UTF-16 units -- a surrogate pair, which
  // is the case a naive charCodeAt walk gets wrong in the other direction.
  const source = "ok \u{1D518} the client opens connections.";
  const text = new ByteText(source);
  const bytes = encoder.encode(source);
  assert.equal(text.length, bytes.length);
  const start = Buffer.from(bytes).indexOf("client");
  assert.equal(text.slice(start, start + 6), "client");
});

test("ByteText clamps offsets outside the document", () => {
  const text = new ByteText("short");
  assert.equal(text.slice(-10, 2), "sh");
  assert.equal(text.slice(3, 900), "rt");
  assert.equal(text.slice(900, 901), "");
});

test("ByteText round-trips every offset of a mixed string", () => {
  const source = "a\u2014b \u00e9 c \u{1D518} d";
  const text = new ByteText(source);
  const bytes = encoder.encode(source);
  // Slicing from 0 to any boundary must equal decoding the same byte prefix.
  for (let offset = 0; offset <= bytes.length; offset++) {
    // Only whole characters have a decodable prefix; a split sequence is not an
    // offset the engine can produce, so those are skipped.
    const prefix = Buffer.from(bytes.subarray(0, offset)).toString("utf8");
    if (prefix.includes("�")) continue;
    assert.equal(text.slice(0, offset), prefix, `offset ${offset}`);
  }
});

test("severity maps the engine's words onto the three the page draws", () => {
  assert.equal(severityOf({ severity: "error" }), "forbid");
  assert.equal(severityOf({ severity: "warning" }), "warning");
  assert.equal(severityOf({ severity: "info" }), "info");
  assert.equal(severityOf({ severity: "something-new" }), "info");
});

test("a paragraph-scope or wide finding is a stretch, a phrase is not", () => {
  assert.equal(isStretch({ scope: "paragraph", start: 0, end: 10 }), true);
  assert.equal(isStretch({ scope: "document", start: 0, end: 10 }), true);
  assert.equal(isStretch({ scope: "sentence", start: 0, end: 28 }), false);
  assert.equal(isStretch({ scope: "sentence", start: 0, end: 400 }), true);
});

test("the score bands are green under 30, amber under 60, red at 60", () => {
  assert.equal(band(0), "low");
  assert.equal(band(29.9), "low");
  assert.equal(band(30), "mid");
  assert.equal(band(59.9), "mid");
  assert.equal(band(60), "high");
  assert.equal(band(100), "high");
});

test("a score shows a decimal only when it has one", () => {
  assert.equal(formatScore(15), "15");
  assert.equal(formatScore(7.992), "8");
  assert.equal(formatScore(58.66), "58.7");
  assert.equal(formatScore(0), "0");
});
