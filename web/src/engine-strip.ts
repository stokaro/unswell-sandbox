/**
 * The engine strip: one line that always says what the runtime is doing.
 *
 * It reports real work. The byte counts are bytes that have arrived, the phases
 * appear only once they have started, and "ready in NNN ms" is measured from
 * the moment the Worker was told to boot. There is no invented percentage and
 * no timer pretending to be progress.
 *
 * It is also the page's only error surface for the runtime. A failure here is
 * stated in full -- what failed and what that means -- because the alternative
 * is a page that looks ready and does nothing when the button is pressed.
 */

import type { BootPhase } from "./protocol.ts";

const MB = 1000 * 1000;

/** Megabytes, decimal, because that is what a download meter shows. */
function mb(bytes: number): string {
  return (bytes / MB).toFixed(1);
}

const PHASE_LABELS: Record<BootPhase, string> = {
  fetching: "Fetching unswell.wasm",
  downloading: "Downloading unswell.wasm",
  compiling: "Compiling module",
  starting: "Starting Go runtime",
};

export class EngineStrip {
  private readonly root: HTMLElement;
  private readonly label: HTMLElement;
  private readonly detail: HTMLElement;
  private readonly fill: HTMLElement;

  constructor(root: HTMLElement) {
    this.root = root;
    this.label = root.querySelector<HTMLElement>("#engine-label")!;
    this.detail = root.querySelector<HTMLElement>("#engine-detail")!;
    this.fill = root.querySelector<HTMLElement>("#engine-fill")!;
  }

  private set(state: string, label: string, detail: string): void {
    this.root.dataset.state = state;
    this.label.textContent = label;
    this.detail.textContent = detail;
  }

  booting(): void {
    this.set("loading", PHASE_LABELS.fetching, "");
    this.fill.style.width = "0%";
  }

  progress(phase: BootPhase, loaded: number, total: number): void {
    if (phase === "downloading" && total > 0) {
      this.set("loading", PHASE_LABELS.downloading, `${mb(loaded)} / ${mb(total)} MB`);
      this.fill.style.width = `${Math.min(100, (loaded / total) * 100).toFixed(1)}%`;
      return;
    }
    // Nothing after the download has a measurable extent, so the bar holds at
    // full rather than standing still at a number that has stopped meaning
    // anything.
    this.set("loading", PHASE_LABELS[phase], "");
    if (phase !== "fetching") this.fill.style.width = "100%";
  }

  ready(bootMs: number): void {
    this.set("ready", "unswell.wasm", `ready in ${Math.round(bootMs)} ms · offline`);
    this.fill.style.width = "100%";
  }

  analyzing(): void {
    this.set("busy", "unswell.wasm", "analyzing");
  }

  analyzed(durationMs: number): void {
    this.set("ready", "unswell.wasm", `analyzed in ${durationMs} ms`);
  }

  failed(message: string): void {
    this.set("failed", "engine unavailable", message);
    this.fill.style.width = "0%";
  }
}
