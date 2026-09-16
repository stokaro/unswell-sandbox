/**
 * The notes rail: what the engine said, in the order the document says it.
 *
 * The rail never reads the document. It renders the same `Report` the marks
 * were drawn from, so a note and its mark cannot disagree about what a rule
 * found; they are two views of one array.
 */

import type { Finding, Report } from "./protocol.ts";
import { band, formatScore, severityOf } from "./render.ts";

export interface RailHandles {
  /** Every note element, by finding id. */
  notes: Map<string, HTMLElement>;
}

/** Draws the two stat cards and one card per finding. */
export function renderRail(body: HTMLElement, report: Report): RailHandles {
  body.replaceChildren();
  const notes = new Map<string, HTMLElement>();

  body.append(renderStats(report));

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
    return { notes };
  }

  report.findings.forEach((finding, index) => {
    const note = renderNote(finding, index);
    notes.set(finding.id, note);
    body.append(note);
  });

  return { notes };
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
  index.append(label("Max index"));
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
  index.append(indexValue, track);

  stats.append(gate, index);
  return stats;
}

function label(text: string): HTMLElement {
  const element = document.createElement("div");
  element.className = "stat-label";
  element.textContent = text;
  return element;
}

function renderNote(finding: Finding, index: number): HTMLElement {
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
      (finding.suggestion ? `${finding.suggestion} ` : "") + "Show it in the text.",
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
