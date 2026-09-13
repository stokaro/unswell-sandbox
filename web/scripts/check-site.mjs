// Gate for anything published to play.unswell.dev.
//
// Every assertion here exists because breaking it produces a site that looks
// fine in a diff and is broken in a browser: a link to a file that is not in
// the artifact, a 46 MB WebAssembly binary that does not match the manifest the
// page quotes it from, a github.io address that leaks the hosting.
//
// Run it against the source tree before the build, and against the staged
// directory that is actually uploaded:
//
//   node web/scripts/check-site.mjs --root web --no-wasm
//   node web/scripts/check-site.mjs --root _site
//
// Exit status is 0 with no findings, 1 with any.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, posix } from "node:path";
import { fileURLToPath } from "node:url";

const CNAME_EXPECTED = "play.unswell.dev";

// The wasm binary is a build product and is gitignored on purpose: a 46 MB file
// does not belong in git history. Jobs that have not linked it pass --no-wasm,
// and only this one path is then allowed to be missing.
const WASM_BINARY = "vendor/unswell/unswell.wasm";

// dist/worker.js is loaded by `new Worker(...)` from inside a bundle, and the
// samples are fetched by path from src/main.ts, so no HTML attribute references
// any of them and the link check below cannot see them. They are named here so
// that a build which stops producing one still fails.
const UNREFERENCED = [
  "dist/worker.js",
  "samples/ai-flavoured.md",
  "samples/revised.md",
  "samples/retry_client.py",
];

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const args = process.argv.slice(2);
let root = join(repoRoot, "web");
let requireWasm = true;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--root") root = resolve(args[++i]);
  else if (args[i] === "--no-wasm") requireWasm = false;
  else {
    console.error(`check-site: unknown option: ${args[i]}`);
    process.exit(2);
  }
}

/** @type {{ file?: string, line?: number, message: string }[]} */
const findings = [];

/** Records a failure. `file` is repo-relative and turns into a GitHub annotation. */
function fail(message, file, line) {
  findings.push({ file, line, message });
}

/** The 1-based line an offset falls on, so an annotation lands where the fix is. */
function lineAt(text, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

const readText = (path) => readFileSync(path, "utf8");

function exists(path) {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** Every file under `dir` with one of `extensions`, skipping build inputs. */
function walk(dir, extensions, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, extensions, out);
    else if (extensions.some((ext) => entry.name.endsWith(ext))) out.push(path);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. The domain. GitHub Pages serves whatever CNAME says; a stray character
//    here takes the site down with a certificate error, not a 404.
// ---------------------------------------------------------------------------

const cnamePath = join(root, "CNAME");
if (!exists(cnamePath)) {
  fail("CNAME is missing; GitHub Pages would serve the site at stokaro.github.io", "web/CNAME");
} else {
  const cname = readText(cnamePath);
  if (cname.trim() !== CNAME_EXPECTED) {
    fail(
      `CNAME is ${JSON.stringify(cname.trim())}, expected ${JSON.stringify(CNAME_EXPECTED)}`,
      "web/CNAME",
    );
  }
  if (cname.trim().split(/\s+/).length !== 1) {
    fail("CNAME must name exactly one host", "web/CNAME");
  }
}

// ---------------------------------------------------------------------------
// 2. The pages that have to exist.
// ---------------------------------------------------------------------------

for (const page of ["index.html", "404.html"]) {
  if (!exists(join(root, page))) {
    fail(`${page} is missing; the site needs it at the root of the artifact`);
  }
}

// ---------------------------------------------------------------------------
// 3. Every reference resolves. Both root-absolute and page-relative, because
//    the playground uses relative paths and 404.html uses absolute ones, and a
//    404 on either is invisible until someone loads the page.
// ---------------------------------------------------------------------------

const pages = walk(root, [".html"]);
const attributeRef = /\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const cssUrlRef = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]+))\s*\)/g;

/** True for anything that is not a path into this site. */
function isExternal(ref) {
  return (
    ref === "" ||
    ref.startsWith("#") ||
    ref.startsWith("//") ||
    /^[a-z][a-z0-9+.-]*:/i.test(ref)
  );
}

function checkRef(ref, fromFile, line) {
  if (isExternal(ref)) return;
  const clean = ref.split("#")[0].split("?")[0];
  if (clean === "") return;

  const where = relative(repoRoot, fromFile);
  const target = clean.startsWith("/")
    ? join(root, clean.slice(1))
    : resolve(dirname(fromFile), clean);

  const rel = relative(root, target);
  if (rel.startsWith("..")) {
    fail(`references ${ref}, which escapes the site root`, where, line);
    return;
  }

  if (isDirectory(target)) {
    // A directory link is served as its index.html or not at all.
    if (!exists(join(target, "index.html"))) {
      fail(`references ${ref}, a directory with no index.html`, where, line);
    }
    return;
  }

  if (exists(target)) return;

  const posixRel = rel.split(/[\\/]/).join(posix.sep);
  if (!requireWasm && posixRel === WASM_BINARY) return;

  fail(`references ${ref}, which does not exist`, where, line);
}

for (const page of pages) {
  const html = readText(page);
  for (const match of html.matchAll(attributeRef)) {
    checkRef(match[1] ?? match[2] ?? "", page, lineAt(html, match.index));
  }
}

// Stylesheets pull fonts with url(), and a missing font subset is a silent
// fallback rather than an error in the console.
for (const sheet of walk(root, [".css"])) {
  const css = readText(sheet);
  for (const match of css.matchAll(cssUrlRef)) {
    checkRef((match[1] ?? match[2] ?? match[3] ?? "").trim(), sheet, lineAt(css, match.index));
  }
}

for (const entry of UNREFERENCED) {
  if (!exists(join(root, entry))) {
    fail(`${entry} is missing; it is loaded from JavaScript, so nothing else would catch this`);
  }
}

// Every font file needs its license text beside it. The fonts are OFL and
// redistributing them without the license is the one legal mistake a static
// site can make by forgetting a `cp`.
const fontDir = join(root, "assets/fonts");
if (exists(fontDir)) {
  const faces = readdirSync(fontDir).filter((name) => name.endsWith(".woff2"));
  if (faces.length > 0) {
    for (const required of ["LICENSES.md", "OFL-Crimson-Pro.txt", "OFL-IBM-Plex.txt"]) {
      if (!exists(join(fontDir, required))) {
        fail(`assets/fonts/${required} is missing; the woff2 files are redistributed under it`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 4. No github.io. The site is play.unswell.dev; a hard-coded Pages address
//    breaks the moment the domain moves and tells visitors the wrong origin.
// ---------------------------------------------------------------------------

for (const file of [...pages, ...walk(root, [".css"])]) {
  const lines = readText(file).split("\n");
  lines.forEach((line, index) => {
    if (line.includes("github.io")) {
      fail(
        "contains a github.io address; the site is play.unswell.dev",
        relative(repoRoot, file),
        index + 1,
      );
    }
  });
}

// ---------------------------------------------------------------------------
// 5. The manifest and the binaries agree, and both agree with the submodule
//    pin. This is the check that keeps a stale wasm from shipping beside
//    freshly built JavaScript: the page reads its version, its commit and its
//    byte count out of this file, so if the file describes a different build
//    than the one in the artifact, the engine strip is lying.
// ---------------------------------------------------------------------------

const manifestPath = join(root, "vendor/unswell/manifest.json");
if (!exists(manifestPath)) {
  fail("vendor/unswell/manifest.json is missing; the page reads its version stamp from it");
} else {
  const manifest = JSON.parse(readText(manifestPath));

  let pinned = "";
  try {
    const line = execFileSync("git", ["ls-files", "-s", "--", "third_party/unswell"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    const fields = line.split(/\s+/);
    if (fields[0] === "160000") pinned = fields[1];
  } catch (err) {
    fail(`could not read the third_party/unswell pin from git: ${err.message}`);
  }

  if (!pinned) {
    fail("third_party/unswell is not recorded as a submodule gitlink; there is no pin to compare against");
  } else if (manifest.unswellCommit !== pinned) {
    fail(
      `manifest.unswellCommit is ${manifest.unswellCommit}, but third_party/unswell is pinned at ${pinned}. ` +
        "Run `make wasm` and commit web/vendor/unswell/manifest.json.",
      "web/vendor/unswell/manifest.json",
    );
  }

  const binaries = [
    { key: "wasm", path: join(root, WASM_BINARY), optional: !requireWasm },
    { key: "wasmExec", path: join(root, "vendor/unswell/wasm_exec.js"), optional: false },
  ];

  for (const { key, path, optional } of binaries) {
    const entry = manifest[key];
    if (!entry) {
      fail(`manifest has no ${key} section`, "web/vendor/unswell/manifest.json");
      continue;
    }
    if (!exists(path)) {
      if (!optional) fail(`${relative(root, path)} is missing but the manifest describes it`);
      continue;
    }
    const actualSha = sha256(path);
    const actualBytes = statSync(path).size;
    if (actualSha !== entry.sha256) {
      fail(
        `${relative(root, path)} has sha256 ${actualSha}, manifest says ${entry.sha256}`,
        "web/vendor/unswell/manifest.json",
      );
    }
    if (actualBytes !== entry.bytes) {
      fail(
        `${relative(root, path)} is ${actualBytes} bytes, manifest says ${entry.bytes}`,
        "web/vendor/unswell/manifest.json",
      );
    }
  }

  if (!Array.isArray(manifest.rules) || manifest.rules.length === 0) {
    fail("manifest lists no rules; the page states the catalog size before it boots",
      "web/vendor/unswell/manifest.json");
  }
}

// ---------------------------------------------------------------------------

const inCI = process.env.GITHUB_ACTIONS === "true";
const seen = new Set();
for (const finding of findings) {
  // The same broken reference usually appears several times on a page; report
  // each distinct place once so the output stays readable.
  const key = `${finding.file}:${finding.line}:${finding.message}`;
  if (seen.has(key)) continue;
  seen.add(key);

  const where = finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ""}` : "";
  if (inCI) {
    const location = finding.file
      ? `file=${finding.file}${finding.line ? `,line=${finding.line}` : ""}`
      : "";
    console.log(`::error ${location}::${finding.message}`);
  }
  console.error(where ? `${where}: ${finding.message}` : finding.message);
}

const scanned = `${pages.length} page(s)`;
if (seen.size > 0) {
  console.error(`check-site: ${seen.size} problem(s) in ${relative(repoRoot, root) || "."} (${scanned})`);
  process.exit(1);
}
console.log(`check-site: ${relative(repoRoot, root) || "."} is publishable (${scanned})`);
