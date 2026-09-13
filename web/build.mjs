// Bundles the playground, and refuses to ship a page that contradicts itself.
//
// wasm_exec.js is deliberately NOT bundled: it must byte-match the toolchain
// that built unswell.wasm, so it stays a real file next to the binary whose
// hash the manifest records beside its own.
//
// Two checks run before esbuild, both guarding claims the HTML makes:
//
//   * the Content-Security-Policy allows every inline script the page ships.
//     Today the page ships none and the policy carries no hash, which is the
//     state this check defends: an inline script added later without a matching
//     hash would be silently dead in the browser and perfectly fine in a diff.
//   * the sample files the page offers exist, and the page's own labels name
//     them. A button that fetches a 404 looks like an engine failure.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { build } from "esbuild";

const dev = process.argv.includes("--dev");
const problems = [];

const html = readFileSync("index.html", "utf8");

/* ---------- The CSP allows exactly the inline scripts that exist ---------- */

const policy = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html);
if (policy === null) {
  problems.push("index.html has no Content-Security-Policy meta tag");
} else {
  if (!policy[1].includes("'wasm-unsafe-eval'")) {
    problems.push("the Content-Security-Policy does not allow 'wasm-unsafe-eval'; the module cannot compile");
  }
  if (!policy[1].includes("worker-src 'self'")) {
    problems.push("the Content-Security-Policy does not allow worker-src 'self'; the engine cannot start");
  }
  for (const match of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
    const digest = createHash("sha256").update(match[1], "utf8").digest("base64");
    if (!policy[1].includes(`'sha256-${digest}'`)) {
      problems.push(
        `index.html carries an inline script the Content-Security-Policy does not allow. ` +
          `Add 'sha256-${digest}' to script-src, or move the script into src/.`,
      );
    }
  }
}

/* ---------- The samples the page offers are really there ---------- */

for (const sample of ["samples/ai-flavored.md", "samples/revised.md", "samples/retry_client.py"]) {
  if (!existsSync(sample)) {
    problems.push(`${sample} is missing; a toolbar button fetches it by that exact path`);
  }
}

const source = readFileSync("src/main.ts", "utf8");
for (const sample of ["samples/ai-flavored.md", "samples/revised.md", "samples/retry_client.py"]) {
  if (!source.includes(sample)) {
    problems.push(`src/main.ts no longer names ${sample}; the file and the page have drifted apart`);
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`build: ${problem}`);
  process.exit(1);
}

/* ---------- Bundle ---------- */

await build({
  entryPoints: { main: "src/main.ts", worker: "src/worker.ts" },
  outdir: "dist",
  bundle: true,
  format: "esm",
  target: "es2022",
  // Two entry points, no splitting: the page and the Worker are separate
  // realms, and each loads exactly one file. src/main.ts reaches the second one
  // by name, as dist/worker.js next to dist/main.js.
  splitting: false,
  minify: !dev,
  sourcemap: dev ? "inline" : "external",
  logLevel: "info",
});
