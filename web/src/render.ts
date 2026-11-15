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
 * The marks of the AI-sounding index are drawn by the same machinery. A mark of
 * the index is a second kind of range over the same text, so it is flattened
 * and nested with the findings rather than painted in a pass of its own.
 *
 * Everything is built with createElement and textContent. No string of HTML is
 * assembled from the visitor's text anywhere in this file.
 */

import type { Finding, Report, Span, Unit } from "./protocol.ts";

/**
 * One range the document marks: a finding, or a mark of the AI-sounding index.
 *
 * The renderer needs the same five things from both, and nothing else about
 * either, so it works on this shape and never asks which kind it is drawing.
 */
interface Markable {
  /** The value of data-finding on the mark and on its note in the rail. */
  id: string;
  start: number;
  end: number;
  segments: Span[];
  className: string;
  /** What a screen reader says at the mark. */
  label: string;
  /** The superscript that numbers a finding. A mark of the index has none. */
  badge: string | null;
  /**
   * Whether the range is also drawn in the text between two units. A finding
   * is about prose and stays inside the units. A mark of the index can be
   * markup: the asterisks of a bold label open before the paragraph starts.
   */
  betweenUnits: boolean;
}

/** The id a mark of the index carries in the document and in the rail. */
export function indexMarkId(position: number): string {
  return `index-${position}`;
}

/**
 * Whether the marks of the index are shown.
 *
 * The CLI's report lists the marks of a page above the level low and none at
 * that level, and `unswell fix` leaves such a page as it is. The page follows
 * both, so a low page shows its number and no marks.
 */
export function listsIndexMarks(report: Report): boolean {
  const index = report.aiSounding;
  return index !== undefined && index.status === "available" && index.level !== "low";
}

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
  /** Indices into the markable ranges, outermost first. */
  covering: number[];
}

/**
 * Cuts [start, end) into non-overlapping slices at every finding boundary.
 *
 * Only the segments are cut, not the whole span: a slice is marked when it is
 * inside a segment of a finding, and plain when it falls between two of them.
 */
function sliceRange(start: number, end: number, markables: Markable[], indices: number[]): Slice[] {
  const cuts = new Set<number>([start, end]);
  for (const index of indices) {
    for (const segment of markables[index].segments) {
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
      markables[index].segments.some((segment) => segment.start <= from && segment.end >= to),
    );
    // Outermost first, so the DOM nests the way the spans nest.
    covering.sort(
      (a, b) => markables[b].end - markables[b].start - (markables[a].end - markables[a].start),
    );
    slices.push({ start: from, end: to, covering });
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
  const markables: Markable[] = report.findings.map((finding, index) => ({
    id: finding.id,
    start: finding.start,
    end: finding.end,
    segments: coalesce(source, [
      ...finding.segments,
      ...(finding.related ?? []).flatMap((location) => location.segments ?? []),
    ].sort((a, b) => a.start - b.start || a.end - b.end)),
    className: `mark mark-${severityOf(finding)}${isStretch(finding) ? " is-stretch" : ""}`,
    label: `Finding ${index + 1}: ${finding.message} (${finding.ruleId}, ${finding.severity})`,
    badge: String(index + 1),
    betweenUnits: false,
  }));
  if (listsIndexMarks(report)) {
    report.aiSounding!.marks.forEach((mark, position) => {
      markables.push({
        id: indexMarkId(position),
        start: mark.start,
        end: mark.end,
        segments: [{ start: mark.start, end: mark.end }],
        className: "mark mark-ai",
        label: `Mark of the AI-sounding index: ${mark.note ?? mark.signal}`,
        badge: null,
        betweenUnits: true,
      });
    });
  }

  // A grouped finding can have evidence in several units. Draw every mapped
  // segment; the final segment alone receives its finding number.
  const units = [...report.units].sort((a, b) => a.start - b.start);
  const placed = new Set<number>();

  /** The ranges with a segment in [from, to), noted as placed. */
  const within = (from: number, to: number, betweenUnits: boolean): number[] => {
    const inside: number[] = [];
    markables.forEach((markable, index) => {
      if (betweenUnits && !markable.betweenUnits) return;
      if (markable.segments.some((segment) => segment.start < to && segment.end > from)) {
        placed.add(index);
        inside.push(index);
      }
    });
    return inside;
  };
  const gap = (from: number, to: number): void =>
    appendGap(root, source, from, to, markables, within(from, to, true), marks);

  let cursor = 0;
  let order = 0;
  for (const unit of units) {
    if (unit.start > cursor) gap(cursor, unit.start);
    root.append(renderUnit(source, unit, markables, within(unit.start, unit.end, false), marks, order++));
    cursor = Math.max(cursor, unit.end);
  }
  if (cursor < source.length) gap(cursor, source.length);

  // Anything the placement above could not put in a unit still has to be
  // reachable from the rail, so its absence from the document is explicit
  // rather than a mark that silently never appears.
  markables.forEach((markable, index) => {
    if (!placed.has(index)) marks.set(markable.id, []);
  });

  return { root, marks };
}

/**
 * Text the engine did not look at: blank lines, markup, and in Python, code.
 *
 * A mark of the index can reach into it, so it is cut into slices like a unit.
 * With nothing to mark it is one text node, as plain as before.
 */
function appendGap(
  root: DocumentFragment,
  source: ByteText,
  start: number,
  end: number,
  markables: Markable[],
  indices: number[],
  marks: Map<string, HTMLElement[]>,
): void {
  if (source.slice(start, end) === "") return;
  const span = document.createElement("span");
  span.className = "code-dim";
  for (const slice of sliceRange(start, end, markables, indices)) {
    span.append(renderSlice(source, slice, markables, marks));
  }
  root.append(span);
}

function renderUnit(
  source: ByteText,
  unit: Unit,
  markables: Markable[],
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

  // The origin estimate is a separate channel from the score and must not be
  // read as part of it. It appears only where the pack accepted the paragraph,
  // which is the 25 to 89 word band it was fitted on, and it decides nothing.
  if (typeof unit.origin === "number") {
    const origin = document.createElement("span");
    origin.className = "para-origin";
    origin.dataset.level = unit.origin >= 0.5 ? "high" : "low";
    origin.textContent = `${Math.round(unit.origin * 100)}%`;
    origin.title =
      "Experimental origin estimate: similarity to a training class of generated " +
      "documentation. It is not a quality judgment, not a verdict about who wrote " +
      "this, and it decides no gate.";
    para.append(origin);
  }

  // The accessible version of the gutter: a decorative bar and a bare number
  // read as noise, so the paragraph carries the same fact as a sentence.
  para.setAttribute(
    "aria-label",
    `Paragraph index ${formatScore(unit.score)} out of 100, ${unit.words} words` +
      (typeof unit.origin === "number"
        ? `, origin estimate ${Math.round(unit.origin * 100)} percent`
        : ""),
  );

  for (const slice of sliceRange(unit.start, unit.end, markables, indices)) {
    para.append(renderSlice(source, slice, markables, marks));
  }
  return para;
}

function renderSlice(
  source: ByteText,
  slice: Slice,
  markables: Markable[],
  marks: Map<string, HTMLElement[]>,
): Node {
  const text = source.slice(slice.start, slice.end);
  if (slice.covering.length === 0) {
    return document.createTextNode(text);
  }

  // Build from the inside out: the innermost range wraps the text, and each
  // outer one wraps that.
  let node: Node = document.createTextNode(text);
  for (let i = slice.covering.length - 1; i >= 0; i--) {
    const markable = markables[slice.covering[i]];
    const mark = document.createElement("span");
    mark.className = markable.className;
    mark.dataset.finding = markable.id;
    mark.tabIndex = 0;
    mark.setAttribute("role", "button");
    mark.setAttribute("aria-label", markable.label);
    mark.append(node);

    // The superscript goes on the LAST slice of the finding, so a phrase split
    // across markup is numbered once, at its end.
    const last = markable.segments[markable.segments.length - 1];
    if (markable.badge !== null && last && slice.end >= last.end) {
      const badge = document.createElement("sup");
      badge.className = "mark-index";
      badge.textContent = markable.badge;
      badge.setAttribute("aria-hidden", "true");
      mark.append(badge);
    }

    const list = marks.get(markable.id) ?? [];
    list.push(mark);
    marks.set(markable.id, list);
    node = mark;
  }
  return node;
}

/** One decimal only when there is one, so 15 does not read as 15.0. */
export function formatScore(score: number): string {
  const rounded = Math.round(score * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}
