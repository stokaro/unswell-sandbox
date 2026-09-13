/**
 * The page.
 *
 * It owns the two modes -- editing and reading a report -- and the one rule
 * that keeps them honest: a report is only ever shown for the exact text it was
 * produced from. Any edit, any profile change, any format change returns the
 * page to editing, because a mark drawn at byte 412 of a string that no longer
 * exists is worse than no mark at all.
 *
 * There is no JavaScript implementation of any rule here, and there will not
 * be one. If the WebAssembly does not load, the page says so and stays
 * readable; it does not fall back to a second opinion that would drift from the
 * engine and quietly stop being the same answer the CLI gives.
 */

import { EngineStrip } from "./engine-strip.ts";
import type { HostEvent, Report, WorkerRequest } from "./protocol.ts";
import { ByteText, renderReport } from "./render.ts";
import { renderRail } from "./rail.ts";

type Format = "markdown" | "python";
type Profile = "technical" | "strict";

const SAMPLES: Record<Format, { flavored: string; revised: string; label: string }> = {
  markdown: {
    flavored: "samples/ai-flavored.md",
    revised: "samples/revised.md",
    label: "Load AI-flavored sample",
  },
  python: {
    flavored: "samples/retry_client.py",
    // There is one revision and it is prose. The Python sample's point is the
    // extraction boundary, not a second before-and-after, so the button loads
    // the same revision and the format switches with it.
    revised: "samples/revised.md",
    label: "Load AI-flavored retry_client.py",
  },
};

const element = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`the page is missing #${id}`);
  return found as T;
};

const input = element<HTMLTextAreaElement>("input");
const editView = element("edit");
const reportView = element("report");
const pane = element("pane");
const railBody = element("rail-body");
const railCount = element("rail-count");
const wordcount = element("wordcount");
const analyzeButton = element<HTMLButtonElement>("analyze");
const sampleButton = element<HTMLButtonElement>("load-sample");
const revisionButton = element<HTMLButtonElement>("load-revision");
const clearButton = element<HTMLButtonElement>("clear");
const legendCode = element("legend-code");
const footerTag = element("footer-tag");
const strip = new EngineStrip(element("engine"));

let profile: Profile = "technical";
let format: Format = "markdown";
let engineReady = false;
let engineFailure = "";
let runId = 0;
let inFlight = 0;
/** The report on screen, and the exact text it describes. */
let current: { report: Report; source: ByteText } | null = null;
let activeFinding: string | null = null;
let marks = new Map<string, HTMLElement[]>();
let notes = new Map<string, HTMLElement>();

/* ---------------------------------------------------------------------------
 * The Worker
 * ------------------------------------------------------------------------ */

// dist/worker.js, resolved against dist/main.js. It is a separate esbuild
// entry point rather than an inlined blob: a blob: worker would need a CSP that
// allows blob: workers, and the Worker must inherit this page's policy so that
// 'wasm-unsafe-eval' reaches the module it compiles.
const worker = new Worker(new URL("worker.js", import.meta.url), { type: "module" });

function send(message: WorkerRequest): void {
  worker.postMessage(message);
}

worker.addEventListener("message", (event: MessageEvent<HostEvent>) => {
  const message = event.data;
  switch (message.type) {
    case "progress":
      strip.progress(message.phase, message.loaded, message.total);
      return;
    case "ready":
      engineReady = true;
      strip.ready(message.bootMs);
      footerTag.textContent =
        `unswell ${message.info.version} · ${message.info.rules.length} rules · ` +
        `${message.info.goVersion} · MIT · offline`;
      updateControls();
      return;
    case "report":
      if (message.runId !== inFlight) return;
      inFlight = 0;
      showReport(message.report);
      return;
    case "failed":
      if (message.runId !== inFlight) return;
      inFlight = 0;
      showRunFailure(message.message);
      return;
    case "panic":
      // The engine is still running, but something in it faulted. Say so where
      // the visitor is looking rather than only in the console.
      showRunFailure(message.message);
      return;
    case "fatal":
      engineReady = false;
      engineFailure = message.message;
      strip.failed(message.message);
      updateControls();
      return;
  }
});

worker.addEventListener("error", (event) => {
  engineReady = false;
  engineFailure = event.message || "the Worker failed to start";
  strip.failed(engineFailure);
  updateControls();
});

strip.booting();
send({ type: "init", base: new URL(".", document.baseURI).href });

/* ---------------------------------------------------------------------------
 * Modes
 * ------------------------------------------------------------------------ */

function editing(): boolean {
  return current === null;
}

/** Drops any report and returns to the text. Called by every edit. */
function toEditing(): void {
  if (current === null) return;
  current = null;
  activeFinding = null;
  marks = new Map();
  notes = new Map();
  reportView.replaceChildren();
  reportView.hidden = true;
  editView.hidden = false;
  railBody.replaceChildren(emptyRail());
  railCount.textContent = `— · ${profile}`;
  updateControls();
}

function emptyRail(): HTMLElement {
  const empty = document.createElement("p");
  empty.className = "rail-empty";
  empty.textContent =
    "Nothing analyzed yet. Paste something, or load a sample, then press Analyze.";
  return empty;
}

function showReport(report: Report): void {
  const source = new ByteText(input.value);
  const rendered = renderReport(source, report);
  reportView.replaceChildren(rendered.root);
  marks = rendered.marks;
  reportView.hidden = false;
  editView.hidden = true;
  current = { report, source };

  notes = renderRail(railBody, report).notes;
  railCount.textContent = `${report.findings.length} · ${report.profile}`;
  strip.analyzed(report.durationMs);
  document.body.classList.remove("is-analyzing");
  pane.scrollTop = 0;
  updateControls();
}

function showRunFailure(message: string): void {
  document.body.classList.remove("is-analyzing");
  const failure = document.createElement("div");
  failure.className = "rail-error";
  failure.textContent = message === "canceled" ? "That analysis was canceled." : message;
  railBody.replaceChildren(failure);
  railCount.textContent = `— · ${profile}`;
  strip.analyzed(0);
  updateControls();
}

/* ---------------------------------------------------------------------------
 * Controls
 * ------------------------------------------------------------------------ */

function updateControls(): void {
  const hasText = input.value.trim() !== "";
  analyzeButton.replaceChildren();
  if (editing()) {
    analyzeButton.append(document.createTextNode("Analyze "));
    const key = document.createElement("kbd");
    key.textContent = "↵";
    analyzeButton.append(key);
    analyzeButton.disabled = !engineReady || !hasText || inFlight !== 0;
  } else {
    analyzeButton.textContent = "Edit text";
    analyzeButton.disabled = false;
  }
  if (!engineReady && engineFailure !== "") {
    analyzeButton.title = engineFailure;
  } else {
    analyzeButton.removeAttribute("title");
  }
  clearButton.disabled = !hasText;
  sampleButton.textContent = SAMPLES[format].label;
  legendCode.hidden = format !== "python";
  countWords();
}

function countWords(): void {
  const words = input.value.trim() === "" ? 0 : input.value.trim().split(/\s+/).length;
  wordcount.textContent = `${words} word${words === 1 ? "" : "s"}`;
}

function segmented(id: string, onPick: (value: string) => void): void {
  const group = element(id);
  group.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-value]");
    if (!button || button.getAttribute("aria-pressed") === "true") return;
    for (const other of group.querySelectorAll("button[data-value]")) {
      other.setAttribute("aria-pressed", String(other === button));
    }
    onPick(button.dataset.value!);
  });
}

segmented("profile-control", (value) => {
  profile = value as Profile;
  // A report produced under one profile does not describe the other, so the
  // page goes back to the text rather than relabeling an old answer.
  toEditing();
  updateControls();
});

segmented("format-control", (value) => {
  format = value as Format;
  document.body.dataset.format = format;
  toEditing();
  updateControls();
});

analyzeButton.addEventListener("click", () => {
  if (editing()) analyze();
  else toEditing();
});

clearButton.addEventListener("click", () => {
  input.value = "";
  toEditing();
  updateControls();
  input.focus();
});

sampleButton.addEventListener("click", () => void loadSample(SAMPLES[format].flavored));
revisionButton.addEventListener("click", () => {
  // The revision is prose. Loading it while the page is in Python mode would
  // analyze Markdown as Python and find nothing, so the mode follows the text.
  if (format === "python") {
    format = "markdown";
    document.body.dataset.format = format;
    for (const button of element("format-control").querySelectorAll<HTMLElement>("button")) {
      button.setAttribute("aria-pressed", String(button.dataset.value === "markdown"));
    }
  }
  void loadSample(SAMPLES.markdown.revised);
});

async function loadSample(path: string): Promise<void> {
  try {
    const response = await fetch(new URL(path, document.baseURI).href);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    input.value = await response.text();
  } catch (err) {
    showRunFailure(`could not load ${path}: ${String(err)}`);
    return;
  }
  toEditing();
  updateControls();
  input.focus();
  input.setSelectionRange(0, 0);
  if (engineReady) analyze();
}

function analyze(): void {
  if (!engineReady || inFlight !== 0) return;
  const text = input.value;
  if (text.trim() === "") return;
  inFlight = ++runId;
  document.body.classList.add("is-analyzing");
  strip.analyzing();
  updateControls();
  send({ type: "analyze", runId: inFlight, text, profile, format });
}

input.addEventListener("input", () => {
  if (!editing()) toEditing();
  updateControls();
});

/* ---------------------------------------------------------------------------
 * Keyboard
 * ------------------------------------------------------------------------ */

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    if (editing()) analyze();
    else toEditing();
    return;
  }
  if (event.key === "Escape" && activeFinding !== null) {
    focusFinding(null);
  }
});

/* ---------------------------------------------------------------------------
 * Marks and notes point at each other
 * ------------------------------------------------------------------------ */

/**
 * Makes one finding the active one, everywhere.
 *
 * Both directions scroll their counterpart into view, and both are idempotent,
 * so a hover that follows a click does not fight it.
 */
function focusFinding(id: string | null, scroll: "mark" | "note" | "none" = "none"): void {
  if (activeFinding === id) return;
  if (activeFinding !== null) {
    for (const mark of marks.get(activeFinding) ?? []) mark.classList.remove("is-active");
    notes.get(activeFinding)?.classList.remove("is-active");
  }
  activeFinding = id;
  if (id === null) return;

  const elements = marks.get(id) ?? [];
  for (const mark of elements) mark.classList.add("is-active");
  const note = notes.get(id);
  note?.classList.add("is-active");

  if (scroll === "mark" && elements[0]) {
    elements[0].scrollIntoView({ block: "nearest", behavior: motion() });
  }
  if (scroll === "note" && note) {
    note.scrollIntoView({ block: "nearest", behavior: motion() });
  }
}

function motion(): ScrollBehavior {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}

function findingAt(target: EventTarget | null): string | null {
  const element = (target as HTMLElement | null)?.closest<HTMLElement>("[data-finding]");
  return element?.dataset.finding ?? null;
}

reportView.addEventListener("pointerover", (event) => focusFinding(findingAt(event.target), "note"));
reportView.addEventListener("click", (event) => focusFinding(findingAt(event.target), "note"));
reportView.addEventListener("focusin", (event) => focusFinding(findingAt(event.target), "note"));
reportView.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const id = findingAt(event.target);
  if (id === null) return;
  event.preventDefault();
  focusFinding(id, "note");
});

railBody.addEventListener("pointerover", (event) => focusFinding(findingAt(event.target), "mark"));
railBody.addEventListener("click", (event) => focusFinding(findingAt(event.target), "mark"));
railBody.addEventListener("focusin", (event) => focusFinding(findingAt(event.target), "mark"));

/* ---------------------------------------------------------------------------
 * Start
 * ------------------------------------------------------------------------ */

document.body.dataset.format = format;
updateControls();
