/**
 * The Worker the playground runs the Unswell engine in.
 *
 * Boot order matters and is not negotiable:
 *
 *   1. install globalThis.__unswellHost, because Go resolves it once at startup
 *      and holds the object, so it cannot be swapped afterwards;
 *   2. load wasm_exec.js, which installs globalThis.Go;
 *   3. instantiate unswell.wasm and go.run() -- never awaited, since the
 *      program parks on select{} and only ends with the Worker.
 *
 * The engine runs here rather than on the main thread for one reason: an
 * analysis is a few hundred milliseconds of straight-line Go with no yield in
 * it, and on the main thread that is a few hundred milliseconds in which the
 * page cannot repaint, so the sweep animation the visitor is watching would
 * freeze exactly while the work it represents is happening.
 */

import type { BootPhase, HostEvent, ReadyInfo, Report, WorkerRequest } from "./protocol.ts";

declare const self: DedicatedWorkerGlobalScope;

/** Set by wasm_exec.js. */
declare class Go {
  argv: string[];
  env: Record<string, string>;
  exit: (code: number) => void;
  importObject: WebAssembly.Imports;
  run(instance: WebAssembly.Instance): Promise<void>;
}

/** The Go half of the contract, installed by cmd/unswell-wasm once running. */
interface UnswellGoHalf {
  analyze(runId: number, text: string, profile: string, format: string): void;
  cancel(runId: number): void;
}

let unswell: UnswellGoHalf | null = null;

function post(event: HostEvent): void {
  self.postMessage(event);
}

function phase(name: BootPhase, loaded = 0, total = 0): void {
  post({ type: "progress", phase: name, loaded, total });
}

/**
 * The same URL, keyed to the bytes it should return.
 *
 * GitHub Pages serves everything with a fixed max-age and cannot be told
 * otherwise, so a plain path lets a browser pair a freshly revalidated manifest
 * with the previous binary still in its cache -- the tab would then report one
 * version before boot and another after. A URL that changes with the content
 * makes that pairing impossible rather than merely detectable.
 *
 * An empty hash means the manifest did not carry one, and the plain URL is then
 * better than a query that pins nothing.
 */
function versioned(url: string, sha: string): string {
  return sha === "" ? url : `${url}?v=${sha.slice(0, 16)}`;
}

/**
 * Loads wasm_exec.js, which installs globalThis.Go.
 *
 * Through import() rather than importScripts(): this is a module worker, where
 * importScripts does not exist at all. The file is a plain IIFE that assigns
 * `globalThis.Go = class` and touches no CommonJS, so evaluating it as a module
 * has the same effect a <script> tag would.
 *
 * It is loaded rather than bundled because it must byte-match the toolchain
 * that built unswell.wasm; a minifier or a version bump would desync the pair
 * silently, and the manifest records its hash for exactly that reason.
 */
async function loadWasmExec(base: string, sha: string): Promise<void> {
  await import(versioned(new URL("vendor/unswell/wasm_exec.js", base).href, sha));
  if (typeof (self as unknown as { Go?: unknown }).Go !== "function") {
    throw new Error("wasm_exec.js did not install globalThis.Go");
  }
}

/**
 * Downloads and compiles unswell.wasm, reporting real bytes as they arrive.
 *
 * The counting stream sits between fetch and compileStreaming rather than
 * replacing it, so the module still compiles as it downloads instead of being
 * buffered first. `total` comes from the manifest because Content-Length on a
 * gzipped response is the ENCODED length while response.body yields decoded
 * bytes -- dividing one by the other would show 220%.
 */
async function compileWithProgress(url: string, total: number): Promise<WebAssembly.Module> {
  phase("fetching");
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`fetch unswell.wasm: ${response.status} ${response.statusText}`);
  }

  let loaded = 0;
  let lastPost = 0;
  const counted = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        loaded += chunk.byteLength;
        // One message per ~50 ms. A 46 MB module arrives in thousands of
        // chunks, and a postMessage per chunk would cost more than the render.
        const now = Date.now();
        if (now - lastPost > 50) {
          lastPost = now;
          phase("downloading", loaded, total);
        }
        controller.enqueue(chunk);
      },
      flush() {
        phase("downloading", loaded, Math.max(total, loaded));
        phase("compiling", loaded, Math.max(total, loaded));
      },
    }),
  );

  return WebAssembly.compileStreaming(
    new Response(counted, { headers: { "content-type": "application/wasm" } }),
  );
}

async function boot(base: string): Promise<{ info: ReadyInfo; bootMs: number }> {
  const started = Date.now();

  // The manifest names the versions, so it is the one file that must never be
  // read from cache without asking. `no-cache` revalidates rather than
  // re-downloads: a few kilobytes and an ETag, against the alternative of
  // describing a build the tab is not running.
  const manifest = await (
    await fetch(new URL("vendor/unswell/manifest.json", base).href, { cache: "no-cache" })
  ).json();

  const wasmSha = String(manifest?.wasm?.sha256 ?? "");
  const execSha = String(manifest?.wasmExec?.sha256 ?? "");
  const total = Number(manifest?.wasm?.bytes) || 0;

  const compiled = compileWithProgress(
    versioned(new URL("vendor/unswell/unswell.wasm", base).href, wasmSha),
    total,
  );
  // wasm_exec.js is 17 kB beside a 46 MB module, so it is fetched alongside
  // rather than after; it has to be evaluated before go.run, not before the
  // download.
  const shimLoaded = loadWasmExec(base, execSha);

  const [module] = await Promise.all([compiled, shimLoaded]);
  phase("starting");

  const ready = new Promise<ReadyInfo>((resolve, reject) => {
    (self as unknown as { __unswellHost: unknown }).__unswellHost = {
      ready: (info: ReadyInfo) => resolve(info),
      result: (runId: number, json: string) => {
        let report: Report;
        try {
          report = JSON.parse(json) as Report;
        } catch (err) {
          post({ type: "failed", runId, message: `could not parse the report: ${String(err)}` });
          return;
        }
        post({ type: "report", runId, report });
      },
      failed: (runId: number, message: string) => post({ type: "failed", runId, message }),
      panic: (message: string) => {
        // A panic before ready() means the runtime never came up; after it,
        // the runtime is still there but something in it faulted. Both are
        // reported, and the first one also ends the boot.
        reject(new Error(message));
        post({ type: "panic", message });
      },
    };
  });

  const go = new (self as unknown as { Go: typeof Go }).Go();
  go.argv = ["unswell"];
  go.env = {};
  go.exit = (code: number) => {
    throw new Error(`unswell-wasm called os.Exit(${code}); it must never exit`);
  };

  const instance = await WebAssembly.instantiate(module, go.importObject);
  void go.run(instance).catch((err: unknown) => {
    post({ type: "fatal", message: `the Go runtime stopped: ${String(err)}` });
  });

  const info = await ready;
  unswell = (self as unknown as { __unswell: UnswellGoHalf }).__unswell;
  if (!unswell) {
    throw new Error("the Go program did not install globalThis.__unswell");
  }
  return { info, bootMs: Date.now() - started };
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  switch (message.type) {
    case "init": {
      try {
        const { info, bootMs } = await boot(message.base);
        post({ type: "ready", info, bootMs });
      } catch (err) {
        post({ type: "fatal", message: describe(err) });
      }
      return;
    }
    case "analyze": {
      if (!unswell) {
        post({ type: "failed", runId: message.runId, message: "the engine is not running yet" });
        return;
      }
      try {
        unswell.analyze(message.runId, message.text, message.profile, message.format);
      } catch (err) {
        post({ type: "failed", runId: message.runId, message: describe(err) });
      }
      return;
    }
    case "cancel": {
      unswell?.cancel(message.runId);
      return;
    }
  }
};

/**
 * A message a visitor can act on.
 *
 * The distinction that matters is between "this browser cannot run the engine"
 * and "the engine is there and broke", because only the first has anything the
 * visitor could do about it.
 */
function describe(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  if (typeof WebAssembly === "undefined") {
    return "this browser has no WebAssembly, and the rules only exist as WebAssembly";
  }
  if (/compileStreaming|CompileError|magic|Wasm|WebAssembly/i.test(text)) {
    return `unswell.wasm did not compile: ${text}`;
  }
  return text;
}
