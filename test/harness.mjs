/**
 * Boots web/vendor/unswell/unswell.wasm outside a browser and drives the host
 * boundary the page drives.
 *
 * The point is to test the Go half without a browser, a bundler or a DOM: this
 * is the same wasm_exec.js, the same globalThis.__unswellHost, the same
 * __unswell.analyze, and the same JSON payload the Worker receives. If the
 * contract breaks, it breaks here first and the failure names the method.
 *
 * wasm_exec.js is loaded rather than imported as a module because it is a plain
 * IIFE that assigns globalThis.Go; evaluating it in this realm has the same
 * effect a <script> tag would.
 */

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vendor = join(repoRoot, "web/vendor/unswell");

/** Boots the runtime once and returns a driver for it. */
export async function boot() {
  const manifest = JSON.parse(await readFile(join(vendor, "manifest.json"), "utf8"));
  runInThisContext(await readFile(join(vendor, "wasm_exec.js"), "utf8"), {
    filename: "wasm_exec.js",
  });
  if (typeof globalThis.Go !== "function") {
    throw new Error("wasm_exec.js did not install globalThis.Go");
  }

  /** @type {Map<number, {resolve: Function, reject: Function}>} */
  const pending = new Map();
  const panics = [];
  let readyInfo = null;
  // True only while a call into __unswell.analyze is on the stack. The Go side
  // dispatches through setTimeout so that an answer can never arrive while this
  // is set; a bare goroutine would break exactly this and nothing else.
  let insideAnalyze = false;
  let answeredInsideAnalyze = false;

  const ready = new Promise((resolveReady, rejectReady) => {
    globalThis.__unswellHost = {
      ready: (info) => {
        readyInfo = info;
        resolveReady(info);
      },
      result: (runId, json) => {
        if (insideAnalyze) answeredInsideAnalyze = true;
        const waiter = pending.get(runId);
        pending.delete(runId);
        if (waiter) waiter.resolve(JSON.parse(json));
      },
      failed: (runId, message) => {
        if (insideAnalyze) answeredInsideAnalyze = true;
        const waiter = pending.get(runId);
        pending.delete(runId);
        if (waiter) waiter.reject(new Error(message));
      },
      panic: (message) => {
        panics.push(message);
        rejectReady(new Error(message));
      },
    };
  });

  const go = new globalThis.Go();
  go.argv = ["unswell"];
  go.exit = (code) => {
    throw new Error(`unswell-wasm called os.Exit(${code}); it must never exit`);
  };

  const module = await WebAssembly.compile(await readFile(join(vendor, "unswell.wasm")));
  const instance = await WebAssembly.instantiate(module, go.importObject);
  // Never awaited: the program parks on select{} and only ends with the realm.
  void go.run(instance);

  await ready;

  let nextRun = 0;

  /** Calls analyze with the in-call flag set, so the dispatch can be observed. */
  function call(runId, text, profile, format) {
    insideAnalyze = true;
    try {
      globalThis.__unswell.analyze(runId, text, profile, format);
    } finally {
      insideAnalyze = false;
    }
  }

  return {
    manifest,
    info: readyInfo,
    panics,
    /** True if any answer arrived while an analyze() call was still on the stack. */
    answeredInsideAnalyze: () => answeredInsideAnalyze,
    /** Runs one analysis and resolves with the parsed payload. */
    analyze(text, profile = "technical", format = "markdown") {
      const runId = ++nextRun;
      const settled = new Promise((res, rej) => pending.set(runId, { resolve: res, reject: rej }));
      call(runId, text, profile, format);
      return settled;
    },
    /** Starts an analysis without waiting, so a second one can be raced at it. */
    start(text, profile = "technical", format = "markdown") {
      const runId = ++nextRun;
      const settled = new Promise((res, rej) => pending.set(runId, { resolve: res, reject: rej }));
      call(runId, text, profile, format);
      return { runId, settled };
    },
    cancel(runId) {
      globalThis.__unswell.cancel(runId);
    },
  };
}

export { repoRoot, vendor };
