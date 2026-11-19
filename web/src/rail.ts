/**
 * The notes rail: what the engine said, in the order the document says it.
 *
 * The rail never reads the document. It renders the same `Report` the marks
 * were drawn from, so a note and its mark cannot disagree about what a rule
 * found; they are two views of one array.
 */

import type { AISounding, Finding, FixResult, IndexMark, Report } from "./protocol.ts";
import { type ProfileDifference, profileTag } from "./profiles.ts";
import { band, formatScore, indexMarkId, listsIndexMarks, severityOf } from "./render.ts";

export interface RailHandles {
  /** Every note element, by finding id or by the id of a mark of the index. */
  notes: Map<string, HTMLElement>;
}

/**
 * What the rail says about a fix: the answer of the engine, and whether the
 * text on screen is the fixed one, which is when it can be undone.
 */
export interface FixNote {
  fix: FixResult;
  undoable: boolean;
}

/**
 * Draws the two stat cards, the AI-sounding index, one card per finding, and
 * the marks of the index. With a profile difference, a finding that the base
 * profile would not have reported the same way says so on its card.
 */
export function renderRail(
  body: HTMLElement,
  report: Report,
  fixNote: FixNote | null = null,
  more: ProfileDifference | null = null,
): RailHandles {
  body.replaceChildren();
  const notes = new Map<string, HTMLElement>();

  body.append(renderStats(report));

  const unavailable = renderOriginNotice(report);
  if (unavailable) body.append(unavailable);

  if (fixNote) body.append(renderFixNote(fixNote));
  body.append(renderIndex(report));

  renderFindings(body, report, notes, more);
  renderIndexMarks(body, report, notes);
  return { notes };
}

function renderFindings(
  body: HTMLElement,
  report: Report,
  notes: Map<string, HTMLElement>,
  more: ProfileDifference | null,
): void {
  if (report.findings.length === 0) {
    const clean = document.createElement("div");
    clean.className = "note-clean";
    const headline = document.createElement("div");
    headline.append(document.createTextNode("No findings. "));
    const strong = document.createElement("strong");
    strong.textContent = report.gate.passed ? "The gate passes." : "The gate still fails.";
    headline.append(strong);
    const detail = document.createElement("div");
    detail.textContent =
      report.document.proseWords === 0
        ? "The engine found no English prose to check in this input."
        : `${report.document.proseWords} prose words in ${report.document.blocks} block(s), ` +
          `${report.document.sentences} sentence(s). No enabled rule reported a finding.`;
    clean.append(headline, detail);
    body.append(clean);
    return;
  }

  report.findings.forEach((finding, index) => {
    const note = renderNote(finding, index, more);
    notes.set(finding.id, note);
    body.append(note);
  });
}

/* ---------------------------------------------------------------------------
 * The AI-sounding index
 * ------------------------------------------------------------------------ */

/**
 * The card of the AI-sounding index.
 *
 * The number, the level and the counts are the engine's, and the sentences are
 * the CLI's: `summary`, `advice` and `about` are lines of the text report for
 * this result. The card adds one thing of its own, the button, which runs the
 * same replacements `unswell fix` makes.
 */
function renderIndex(report: Report): HTMLElement {
  const card = document.createElement("div");
  card.className = "index-card";
  card.append(label("AI-sounding index"));

  const index = report.aiSounding;
  if (!index || index.status !== "available") {
    card.dataset.level = "none";
    card.append(line("index-value", "no index"), line("index-detail", missingIndex(report, index)));
    return card;
  }

  card.dataset.level = index.level ?? "low";
  const head = document.createElement("div");
  head.className = "index-head";
  head.append(line("index-value", `${index.index} / 100`), line("index-level", index.level ?? ""));
  const track = document.createElement("div");
  track.className = "stat-track";
  const fill = document.createElement("div");
  fill.className = "index-fill";
  fill.style.width = `${Math.max(0, Math.min(100, index.index))}%`;
  track.append(fill);
  card.append(head, track);

  card.append(line("index-readings", `marks ${index.marksReading} · rhythm ${index.rhythmReading}`));
  card.append(line("index-detail", `${index.words} prose words: ${index.summary ?? countSignals(index)}`));

  // The marks with a replacement belong to the first reading. When that
  // reading is low the engine lists none of them and `unswell fix` leaves the
  // page as it is, also on a page that is high by its rhythm.
  const unlisted = index.fixable === 0 && index.fixableUnlisted > 0;
  if (unlisted) {
    card.append(line(
      "index-detail",
      "The marks with a replacement are at the level low: the check lists none of them, and `unswell fix` leaves the page as it is.",
    ));
  }
  if (index.fixable > 0 || unlisted) {
    const fix = document.createElement("button");
    fix.type = "button";
    fix.className = unlisted ? "btn index-fix" : "btn btn-primary index-fix";
    fix.dataset.action = unlisted ? "fix-low" : "fix";
    fix.textContent = unlisted
      ? "Replace them anyway (--include-low)"
      : `Fix ${index.fixable} mark${index.fixable === 1 ? "" : "s"}`;
    fix.title = "Makes the replacements `unswell fix` makes. No model is called.";
    card.append(fix);
  }
  for (const advice of index.advice ?? []) card.append(line("index-detail", advice));
  if (index.about) card.append(line("index-about", index.about));
  return card;
}

/** Why a text has no index, in the terms the engine and the CLI use. */
function missingIndex(report: Report, index: AISounding | undefined): string {
  if (!index) {
    return `The index is measured on Markdown and MDX pages. This text was read as ${report.format}.`;
  }
  if (index.status === "too_short") {
    return `${index.words} prose words. The index covers a Markdown or MDX page of 150 prose words or more.`;
  }
  return `The engine reported ${index.status}.`;
}

/** The counts by signal, for a report that came without the CLI's own line. */
function countSignals(index: AISounding): string {
  const counted = index.signals.filter((signal) => signal.count > 0);
  if (counted.length === 0) return "none of its marks.";
  return counted.map((signal) => `${signal.count} ${signal.name}`).join(", ") + ".";
}

/**
 * What the last fix did, in the line `unswell fix` prints for a page.
 *
 * It stays above the index for as long as the text on screen is the one the
 * fix produced, because that is the text the two numbers describe.
 */
function renderFixNote(note: FixNote): HTMLElement {
  const card = document.createElement("div");
  card.className = "note-fix";
  const headline = document.createElement("div");
  const command = document.createElement("strong");
  command.textContent = "unswell fix";
  headline.append(command, document.createTextNode(` ${note.fix.summary}`));
  card.append(headline);
  if (note.fix.changed) card.append(line("note-fix-caution", note.fix.caution));
  if (note.undoable) {
    const undo = document.createElement("button");
    undo.type = "button";
    undo.className = "btn index-fix";
    undo.dataset.action = "undo-fix";
    undo.textContent = "Undo the fix";
    card.append(undo);
  }
  return card;
}

/**
 * The marks of the index, one compact note each, in the words of the CLI.
 *
 * Only the marks the CLI's report lists get a note. The report bounds its
 * list, says how many it left out, and the rail repeats that sentence instead
 * of inventing words for the rest. Every located mark is still drawn in the
 * document.
 */
function renderIndexMarks(body: HTMLElement, report: Report, notes: Map<string, HTMLElement>): void {
  if (!listsIndexMarks(report)) return;
  const index = report.aiSounding!;
  const listed = index.marks
    .map((mark, position) => ({ mark, position }))
    .filter(({ mark }) => mark.note !== undefined && mark.note !== "");
  if (listed.length === 0) return;

  const heading = document.createElement("div");
  heading.className = "rail-section";
  heading.textContent = `Marks of the index · ${index.counted}`;
  heading.title = "The marks of each reading that is above the level low.";
  body.append(heading);

  for (const { mark, position } of listed) {
    const note = renderIndexMark(mark, position);
    notes.set(indexMarkId(position), note);
    body.append(note);
  }
  if (index.unlisted) body.append(line("rail-unlisted", index.unlisted));
}

function renderIndexMark(mark: IndexMark, position: number): HTMLElement {
  const note = document.createElement("button");
  note.type = "button";
  note.className = "note note-ai";
  note.dataset.finding = indexMarkId(position);

  const place = document.createElement("span");
  place.className = "note-rule";
  place.textContent = `${mark.line}:${mark.column}`;

  const message = document.createElement("span");
  message.className = "note-ai-text";
  message.textContent = mark.note ?? mark.signal;

  note.append(place, message);
  note.setAttribute(
    "aria-label",
    `Mark of the AI-sounding index at line ${mark.line}, column ${mark.column}: ${mark.note ?? mark.signal}. ` +
      "Show it in the text.",
  );
  return note;
}

function line(className: string, text: string): HTMLElement {
  const element = document.createElement("div");
  element.className = className;
  element.textContent = text;
  return element;
}

/**
 * Says why the origin channel produced nothing, when it produced nothing.
 *
 * The estimate is an optional badge beside a paragraph, so its absence looks
 * exactly like a paragraph the model abstained on, which is the common and
 * uninteresting case. A channel that could not run at all is a different fact
 * and the rail states it in words.
 */
function renderOriginNotice(report: Report): HTMLElement | null {
  const origin = report.origin;
  if (!origin || origin.available) return null;
  const notice = document.createElement("div");
  notice.className = "note-origin";
  const headline = document.createElement("div");
  headline.append(document.createTextNode("Origin estimate unavailable. "));
  const strong = document.createElement("strong");
  strong.textContent = origin.status ?? "unavailable";
  headline.append(strong);
  const detail = document.createElement("div");
  detail.textContent = origin.reason ?? "The origin channel reported no estimate for this run.";
  notice.append(headline, detail);
  return notice;
}

function renderStats(report: Report): HTMLElement {
  const stats = document.createElement("div");
  stats.className = "stats";

  const gate = document.createElement("div");
  gate.className = "stat";
  gate.append(label("Gate"));
  const gateValue = document.createElement("div");
  gateValue.className = `stat-value ${report.gate.passed ? "is-pass" : "is-fail"}`;
  gateValue.textContent = report.gate.passed ? "PASS" : "FAIL";
  const gateNote = document.createElement("div");
  gateNote.className = "stat-note";
  // The exit code is the CLI's, and it is the reason the gate is on the page at
  // all: this is what would happen in CI to the text in the box.
  gateNote.textContent = report.gate.passed ? "exit 0" : "exit 1";
  gate.append(gateValue, gateNote);

  const index = document.createElement("div");
  index.className = "stat";
  // The number is the score of the worst sentence or paragraph by the weighted
  // rules. It is not the AI-sounding index of the page, which has its own card,
  // so the card says in words what the highest score is the highest of.
  index.append(label("Highest score"));
  const indexValue = document.createElement("div");
  indexValue.className = "stat-value";
  indexValue.textContent = `${formatScore(report.maxIndex)} / 100`;
  const track = document.createElement("div");
  track.className = "stat-track";
  const fill = document.createElement("div");
  fill.className = "stat-fill";
  fill.dataset.band = band(report.maxIndex);
  fill.style.width = `${Math.max(0, Math.min(100, report.maxIndex))}%`;
  track.append(fill);
  const indexNote = document.createElement("div");
  indexNote.className = "stat-note";
  indexNote.textContent = "worst sentence or paragraph";
  index.append(indexValue, track, indexNote);

  stats.append(gate, index);
  return stats;
}

function label(text: string): HTMLElement {
  const element = document.createElement("div");
  element.className = "stat-label";
  element.textContent = text;
  return element;
}

function renderNote(finding: Finding, index: number, more: ProfileDifference | null): HTMLElement {
  const severity = severityOf(finding);
  const note = document.createElement("button");
  note.type = "button";
  note.className = `note note-${severity}`;
  note.dataset.finding = finding.id;

  const badge = document.createElement("span");
  badge.className = "note-badge";
  badge.textContent = String(index + 1);
  badge.setAttribute("aria-hidden", "true");

  const rule = document.createElement("span");
  rule.className = "note-rule";
  rule.textContent = finding.ruleId;

  const message = document.createElement("span");
  message.className = "note-message";
  message.textContent = finding.message;

  const meta = document.createElement("span");
  meta.className = "note-meta";
  const severityLabel = document.createElement("span");
  severityLabel.className = `sev-${severity}`;
  severityLabel.textContent = severity;
  meta.append(severityLabel);
  if (finding.context) {
    meta.append(document.createTextNode(` · in ${finding.context}`));
  }
  if (finding.metric) {
    meta.append(document.createTextNode(` · ${describeMetric(finding)}`));
  }
  if (finding.related?.length) {
    meta.append(document.createTextNode(` · ${finding.related.length + 1} text locations`));
  }
  meta.append(document.createTextNode(` · +${formatScore(finding.points)} pts`));
  const tag = profileTag(more, finding);
  if (tag !== "") {
    const profileNote = document.createElement("span");
    profileNote.className = "note-profile";
    profileNote.textContent = tag;
    meta.append(document.createTextNode(" · "), profileNote);
  }

  note.append(badge, rule, message);
  if (finding.suggestion) {
    const suggestion = document.createElement("span");
    suggestion.className = "note-suggestion";
    suggestion.textContent = finding.suggestion;
    note.append(suggestion);
  }
  note.append(meta);
  note.setAttribute(
    "aria-label",
    `Finding ${index + 1} of rule ${finding.ruleId}: ${finding.message}. ` +
      (finding.suggestion ? `${finding.suggestion} ` : "") + (tag !== "" ? `Reported ${tag}. ` : "") +
      "Show it in the text.",
  );
  return note;
}

/**
 * The rule's own measurement, in the rule's own words.
 *
 * The engine names the metric, its value and its unit, and none of the three
 * is worth rewording here: "length 61 prose-words" is what the rule measured,
 * and a friendlier phrasing would be this page's opinion of it.
 */
function describeMetric(finding: Finding): string {
  const metric = finding.metric!;
  const value = formatScore(metric.value);
  return metric.unit ? `${metric.name} ${value} ${metric.unit}` : `${metric.name} ${value}`;
}
