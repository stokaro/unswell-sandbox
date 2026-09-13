/**
 * Turns one text and one report into the marked-up document.
 *
 * Three things make this harder than wrapping substrings, and each one is a
 * correctness problem rather than a styling one:
 *
 *  1. The engine speaks in BYTE offsets into UTF-8. JavaScript strings are
 *     UTF-16 code units. An em dash, a curly quote or an accented name shifts
 *     every offset after it, so the whole document is converted once to a byte
 *     array and a byte-to-code-unit table is built alongside it. Slicing by raw
 *     offset would be correct for pure ASCII and silently wrong for the exact
 *     prose this tool is for.
 *  2. Findings overlap. A long-sentence finding contains a phrase finding
 *     inside it, and a paragraph-scope gate finding contains both. Nested
 *     elements cannot be produced from a flat list of ranges, so the marks are
 *     flattened into non-overlapping slices first and each slice carries every
 *     finding covering it. The superscript index is emitted once per finding,
 *     on its last slice.
 *  3. A finding's span is not all source text. A phrase match in Markdown skips
 *     the inline markup between its words, and the engine says so in
 *     `segments`. The segments are what gets filled; the markup between them
 *     stays plain.
 *
 * Everything is built with createElement and textContent. No string of HTML is
 * assembled from the visitor's text anywhere in this file.
 */

import type { Finding, Report, Span, Unit } from "./protocol.ts";

/** The severity classes the page draws. Anything else is drawn as info. */
type Severity = "forbid" | "warning" | "info";

const encoder = new TextEncoder();

/**
 * A text, its UTF-8 bytes, and the map from byte offset to UTF-16 index.
 *
 * The map has one entry per byte plus one for the end, so `index[n]` is where
 * byte offset n starts in the JavaScript string, for every offset the engine
 * can name.
 */
export class ByteText {
  readonly text: string;
  readonly length: number;
  private readonly index: Int32Array;

  constructor(text: string) {
    this.text = text;
    const bytes = encoder.encode(text);
    this.length = bytes.length;
    this.index = new Int32Array(bytes.length + 1);

    let byte = 0;
    for (let unit = 0; unit < text.length; ) {
      const codePoint = text.codePointAt(unit)!;
      const units = codePoint > 0xffff ? 2 : 1;
      const size = utf8Size(codePoint);
      for (let i = 0; i < size; i++) this.index[byte + i] = unit;
      byte += size;
      unit += units;
    }
    this.index[bytes.length] = text.length;
  }

  /** The substring between two byte offsets, clamped to the document. */
  slice(start: number, end: number): string {
    return this.text.slice(this.unit(start), this.unit(end));
  }

  private unit(offset: number): number {
    if (offset <= 0) return 0;
    if (offset >= this.length) return this.text.length;
    return this.index[offset];
  }
}

function utf8Size(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

/** Maps an engine severity onto one of the three the page draws. */
export function severityOf(finding: Finding): Severity {
  switch (finding.severity) {
    case "error":
      return "forbid";
    case "warning":
      return "warning";
    default:
      return "info";
  }
}

/**
 * Whether a finding is a stretch rather than a phrase.
 *
 * A span covering a whole sentence or a whole paragraph is not a wording, and
 * filling it would claim the rule objected to every word in it. Those are drawn
 * as a dotted underline instead. The test is the engine's own scope plus a
 * width guard, so a phrase rule that happens to match a long phrase still
 * fills and a short paragraph-scope finding still underlines.
 */
export function isStretch(finding: Finding): boolean {
  if (finding.scope === "paragraph" || finding.scope === "document") return true;
  return finding.end - finding.start > 160;
}

/** The band a score falls in: green under 30, amber under 60, red at 60. */
export function band(score: number): "low" | "mid" | "high" {
  if (score >= 60) return "high";
  if (score >= 30) return "mid";
  return "low";
}

interface Slice {
  start: number;
  end: number;
  /** Indices into the report's findings, outermost first. */
  findings: number[];
}

/**
 * Cuts [start, end) into non-overlapping slices at every finding boundary.
 *
 * Only the segments are cut, not the whole span: a slice is marked when it is
 * inside a segment of a finding, and plain when it falls between two of them.
 */
function sliceRange(start: number, end: number, findings: Finding[], indices: number[]): Slice[] {
  const cuts = new Set<number>([start, end]);
  for (const index of indices) {
    for (const segment of findings[index].segments) {
      if (segment.start > start && segment.start < end) cuts.add(segment.start);
      if (segment.end > start && segment.end < end) cuts.add(segment.end);
    }
  }
  const boundaries = [...cuts].sort((a, b) => a - b);
  const slices: Slice[] = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const from = boundaries[i];
    const to = boundaries[i + 1];
    if (to <= from) continue;
    const covering = indices.filter((index) =>
      findings[index].segments.some((segment) => segment.start <= from && segment.end >= to),
    );
    // Outermost first, so the DOM nests the way the spans nest.
    covering.sort(
      (a, b) => findings[b].end - findings[b].start - (findings[a].end - findings[a].start),
    );
    slices.push({ start: from, end: to, findings: covering });
  }
  return slices;
}

/**
 * Merges segments that are separated by whitespace alone.
 *
 * The engine reports one segment per matched TOKEN, so "As an AI language
 * model" arrives as five ranges with the spaces left out. Drawing them as five
 * fills would read as five separate objections to five separate words. The
 * gaps that matter are the ones with something in them -- the inline markup a
 * Markdown phrase match steps over -- and those survive this untouched.
 */
function coalesce(source: ByteText, segments: Span[]): Span[] {
  if (segments.length === 0) return segments;
  const merged: Span[] = [{ ...segments[0] }];
  for (let i = 1; i < segments.length; i++) {
    const last = merged[merged.length - 1];
    const next = segments[i];
    if (next.start <= last.end || source.slice(last.end, next.start).trim() === "") {
      last.end = Math.max(last.end, next.end);
    } else {
      merged.push({ ...next });
    }
  }
  return merged;
}

export interface RenderResult {
  root: DocumentFragment;
  /** Every mark element, by finding id, in document order. */
  marks: Map<string, HTMLElement[]>;
}

/**
 * Renders the whole document: one element per unit, with the text between units
 * carried along as unchecked context.
 *
 * In Markdown the gaps between units are blank lines and list markers. In
 * Python they are the code, which is most of the file, and that is why they are
 * rendered at all rather than dropped: a report that showed only the docstrings
 * would not be the file the visitor pasted.
 */
export function renderReport(source: ByteText, report: Report): RenderResult {
  const root = document.createDocumentFragment();
  const marks = new Map<string, HTMLElement[]>();
  const findings = report.findings.map((finding) => ({
    ...finding,
    segments: coalesce(source, finding.segments),
  }));

  // Findings are placed in the unit that contains them. One that spans a unit
  // boundary -- a document-scope repetition finding, say -- is placed in the
  // first unit it starts in, so every finding is drawn exactly once.
  const units = [...report.units].sort((a, b) => a.start - b.start);
  const placed = new Set<number>();

  let cursor = 0;
  let order = 0;
  for (const unit of units) {
    if (unit.start > cursor) {
      appendGap(root, source, cursor, unit.start);
    }
    const inside: number[] = [];
    findings.forEach((finding, index) => {
      if (placed.has(index)) return;
      if (finding.start >= unit.start && finding.start < unit.end) {
        placed.add(index);
        inside.push(index);
      }
    });
    root.append(renderUnit(source, unit, findings, inside, marks, order++));
    cursor = Math.max(cursor, unit.end);
  }
  if (cursor < source.length) {
    appendGap(root, source, cursor, source.length);
  }

  // Anything the placement above could not put in a unit still has to be
  // reachable from the rail, so its absence from the document is explicit
  // rather than a mark that silently never appears.
  findings.forEach((_, index) => {
    if (!placed.has(index)) marks.set(findings[index].id, []);
  });

  return { root, marks };
}

/** Text the engine did not look at: blank lines, markup, and in Python, code. */
function appendGap(root: DocumentFragment, source: ByteText, start: number, end: number): void {
  const text = source.slice(start, end);
  if (text === "") return;
  const span = document.createElement("span");
  span.className = "code-dim";
  span.textContent = text;
  root.append(span);
}

function renderUnit(
  source: ByteText,
  unit: Unit,
  findings: Finding[],
  indices: number[],
  marks: Map<string, HTMLElement[]>,
  order: number,
): HTMLElement {
  const para = document.createElement("p");
  para.className = "para";
  para.dataset.unit = String(unit.id);
  para.dataset.band = band(unit.score);
  // Staggered, but bounded: a hundred paragraphs must not mean a four second
  // wait for the last one to appear.
  para.style.animationDelay = `${Math.min(order, 12) * 26}ms`;

  const gutter = document.createElement("span");
  gutter.className = "para-gutter";
  gutter.setAttribute("aria-hidden", "true");
  const bar = document.createElement("span");
  bar.className = "para-bar";
  const score = document.createElement("span");
  score.className = "para-score";
  score.textContent = formatScore(unit.score);
  gutter.append(score, bar);
  para.append(gutter);

  // The accessible version of the gutter: a decorative bar and a bare number
  // read as noise, so the paragraph carries the same fact as a sentence.
  para.setAttribute(
    "aria-label",
    `Paragraph index ${formatScore(unit.score)} out of 100, ${unit.words} words`,
  );

  for (const slice of sliceRange(unit.start, unit.end, findings, indices)) {
    para.append(renderSlice(source, slice, findings, marks));
  }
  return para;
}

function renderSlice(
  source: ByteText,
  slice: Slice,
  findings: Finding[],
  marks: Map<string, HTMLElement[]>,
): Node {
  const text = source.slice(slice.start, slice.end);
  if (slice.findings.length === 0) {
    return document.createTextNode(text);
  }

  // Build from the inside out: the innermost finding wraps the text, and each
  // outer one wraps that.
  let node: Node = document.createTextNode(text);
  for (let i = slice.findings.length - 1; i >= 0; i--) {
    const index = slice.findings[i];
    const finding = findings[index];
    const mark = document.createElement("span");
    const severity = severityOf(finding);
    mark.className = `mark mark-${severity}${isStretch(finding) ? " is-stretch" : ""}`;
    mark.dataset.finding = finding.id;
    mark.tabIndex = 0;
    mark.setAttribute("role", "button");
    mark.setAttribute(
      "aria-label",
      `Finding ${index + 1}: ${finding.message} (${finding.ruleId}, ${finding.severity})`,
    );
    mark.append(node);

    // The superscript goes on the LAST slice of the finding, so a phrase split
    // across markup is numbered once, at its end.
    const last = finding.segments[finding.segments.length - 1];
    if (last && slice.end >= last.end) {
      const badge = document.createElement("sup");
      badge.className = "mark-index";
      badge.textContent = String(index + 1);
      badge.setAttribute("aria-hidden", "true");
      mark.append(badge);
    }

    const list = marks.get(finding.id) ?? [];
    list.push(mark);
    marks.set(finding.id, list);
    node = mark;
  }
  return node;
}

/** One decimal only when there is one, so 15 does not read as 15.0. */
export function formatScore(score: number): string {
  const rounded = Math.round(score * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}
