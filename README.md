# unswell-sandbox

The source of [play.unswell.dev](https://play.unswell.dev) — the Unswell engine
running in a browser tab. Real Unswell, compiled to WebAssembly. No server, no
account, nothing installed, and the text never leaves the page.

You paste a paragraph of English prose, or a Python file, and the engine marks
what it found inline and lists each finding as a note in the margin.

## Why it is built this way

A linter playground that fakes its output teaches people something false about
the linter. So this one does not fake anything:

- The rules are Unswell's own rule catalog, from a pinned upstream tag. The
  extraction, the segmentation, the forty rules, the scoring and the gate are
  the ones in the release, not a JavaScript imitation of them.
- The gate decision on screen is the gate decision the CLI would return, and
  the `exit 0` / `exit 1` beside it is the status your CI would see.
- The version in the footer is the version of the WebAssembly that is actually
  running, read out of the binary's build stamp — never the latest release
  number stamped on top of an older build.
- The score beside each paragraph is the engine's index for that paragraph, and
  the `+N pts` on a note is that finding's contribution to it **after** the
  rule and group caps, not its raw weight.

There is no JavaScript fallback and there will not be one. A second
implementation of the rules would drift from the engine, and the whole point of
the page is that it is the same code as the CLI. If WebAssembly is unavailable
or the module fails to compile, the engine strip says what failed and the page
stays readable.

## Layout

    third_party/unswell.pin  the upstream commit every build is made from
    upstream-patch/        empty, and meant to stay that way -- see below
    runtime/unswell/       new Go files copied into Unswell's module at build time
    scripts/               the wasm build, and the catalog helper it runs
    web/                   the playground itself, and its vendored runtime
    web/samples/           the three sample documents the toolbar loads
    test/                  the runtime driven outside a browser, under node

There is no `go.mod` here. The build materializes a copy of pinned Unswell and
builds inside Unswell's own module, so the browser entry point is an ordinary
command in that module and Unswell grows no public API for the sake of a
website.

## Build

    make wasm        # materialize, build unswell.wasm, write the manifest
    make build-web   # npm ci and bundle web/src into web/dist
    make test        # drive the whole runtime under node, no browser needed
    make serve       # serve web/ on http://127.0.0.1:8790/
    make ui-probe    # drive the real page in headless Chrome (needs `make serve`)
    make check-site  # the gate CI runs before publishing

`make wasm` needs the Go toolchain the pinned Unswell declares; `wasm_exec.js`
is copied from that same toolchain, because the pair has to match.

`make test` proves the engine and the contract; it never opens a browser.
`make ui-probe` is the one that proves the page is wired to them. It loads
`index.html` and drives it through the controls a visitor uses — the toolbar,
the samples, the marks, the keyboard — then asserts by reading the DOM. Add
`SHOTS=.refs` to write the 1560px and 390px renders as well.

### Measured

From a clean build on darwin/arm64 with go1.27.1, at the pin
`v0.1.0-alpha.3`:

| | |
| --- | --- |
| `unswell.wasm` | 47,786,668 bytes raw (45.57 MiB, 47.79 MB) |
| `unswell.wasm`, `gzip -9` | 21,793,562 bytes (20.78 MiB, 21.79 MB) |
| `wasm_exec.js` | 16,992 bytes |
| rules in the catalog | 40 |
| boot to `ready()`, node | ~490 ms |
| boot to `ready()`, headless Chrome, localhost | ~560 ms |
| one analysis of the AI-flavored sample | 150–190 ms |

## The pin

`third_party/unswell.pin` is the pin: three lines naming the upstream commit,
the version `git describe` gives it, and its commit date. It is the only place
that records which engine the site is built from.

Move it with `make pin`, which takes the tip of `main`, or `make pin
REF=v0.1.0-alpha.4` for a tag or a commit. Then `make wasm` and commit both the
pin and `web/vendor/unswell/manifest.json`.

There is no submodule. `scripts/build-wasm.sh` fetches the pinned commit into
`build/unswell-git`, a blobless bare mirror that holds the commit graph and the
tags and pulls file contents only when asked. It is under a megabyte until the
first build and about 40 MB after it, against 169 MB for a full clone.

The build checks the pin against git rather than trusting it: the commit must
exist, `git describe` must give the recorded version, and the commit date must
match. A hand-edited line fails the build instead of mislabeling a binary, and
`make check-site` makes the same comparison against the committed manifest.

The build then assembles a disposable tree from three tracked inputs:

1. `git archive` of the pinned commit into `build/unswell-src`, which gives a
   tree with no `.git` and with mtimes taken from the commit;
2. any patch in `upstream-patch/`, applied with `--directory` so a hunk that
   tried to escape the overlay would land outside it and fail;
3. `runtime/unswell/`, copied in at its target paths inside the module.

`build/unswell-src` is gitignored and rebuilt from scratch on every run, and so
is the mirror it is archived from.

`upstream-patch/` is empty on purpose. Unswell builds for `GOOS=js GOARCH=wasm`
unmodified — the engine never touches the network, discovers files, reads the
environment or exits, so a browser is just another caller. An empty directory
there is the goal state, not an oversight.

### What is committed and what is not

`unswell.wasm` is **not** in git. It is 46 MB, it is a build product, and it is
rebuilt in CI. `manifest.json` and `wasm_exec.js` **are** in git, because the
page reads its version stamp out of the manifest and because `wasm_exec.js` has
to byte-match the toolchain that linked the binary. So when the
pin moves, run `make wasm` and commit the manifest and the shim the build
rewrote. CI fails the deploy if you forget: it compares the manifest's
`unswellCommit` and `unswellVersion` against `third_party/unswell.pin`, and
compares what it built against what you committed.

`web/dist` is not in git either. CI bundles it. Locally, `make build-web`.

The manifest's rule list is walked from the rule registry by
`scripts/catalog/main.go`, which is copied into the materialized tree, run once
natively, and removed again. It is not part of what ships. The browser gets the
authoritative catalog from `Engine.Catalog()` at `ready()`; this copy exists so
the page can state what it is about to load before it has loaded it, and so CI
can compare a fresh build against the committed manifest. `test/contract.mjs`
asserts the two lists are the same list.

(`web/.nojekyll` is not needed by the Actions deploy path, which uploads the
directory as-is. It is there so that pointing Pages at a branch instead would
still publish every file rather than quietly dropping the ones Jekyll ignores.)

## The Go/JS boundary

JavaScript installs `globalThis.__unswellHost` **before** the Go program
starts. Go resolves it once at startup and holds it, so it cannot be installed
afterwards and cannot be swapped later.

    __unswellHost.ready(info)              once, before any analysis is accepted
    __unswellHost.result(runId, json)      one finished report, as a JSON string
    __unswellHost.failed(runId, message)   one analysis that produced no report
    __unswellHost.panic(message)           a fault that belongs to no single run

Go installs `globalThis.__unswell` once it is running:

    __unswell.analyze(runId, text, profile, format)
    __unswell.cancel(runId)

`ready(info)` carries the build stamp — `version`, `commit`, `goVersion` — and
the rule catalog from `Engine.Catalog()`, plus the profiles and formats this
build offers. The page's footer and engine strip are written from it, so they
describe the binary that is running rather than the site that was deployed.

Four properties of the Go half are load-bearing, and each one is asserted in
`test/contract.mjs`:

- **`main()` parks on `select {}`.** A js/wasm instance whose main returns is
  torn down, taking the engine with it.
- **Work is dispatched through `setTimeout(0)` plus a goroutine.** A bare
  goroutine is not enough: Go's js/wasm scheduler runs every runnable goroutine
  before handing control back to JavaScript, so an analysis started with `go
  run()` inside `analyze()` would finish, and call `result()`, *before*
  `analyze()` returned to its caller — and the page would paint its "analyzing"
  state after the answer had already arrived. `setTimeout` is what actually
  yields. The goroutine inside it is still required, because the analysis
  blocks and a `js.FuncOf` callback that blocks blocks the event loop.
- **Every `js.FuncOf` callback recovers.** A panic on a goroutine nobody is
  recovering takes the whole WebAssembly instance with it. One case is not
  hypothetical: `syscall/js` cannot represent a BigInt, and `js.Value.Type()`
  panics outright when handed one.
- **One analysis at a time.** A second `analyze()` while one is in flight is
  refused through that run's own `failed()`, so the host learns about it on the
  channel it is already listening to.

The report crosses as a JSON **string**, not a `js.Value` tree: `syscall/js`
builds a JavaScript object one property at a time across the boundary, and a
report with a few hundred findings costs far more that way than one `Marshal`
and one `JSON.parse`.

### What is in the payload, and what is derived

`runtime/unswell/cmd/unswell-wasm/payload.go` projects `unswell.Result` into
what the page renders. Two parts are derived rather than forwarded:

- **Units** are the paragraph-scope assessments only. They are the ranges the
  page segments the document by, the scores it prints in the gutter, and — in a
  source file, where most of the text is code — the only ranges the engine
  looked at, so everything between them is dimmed.
- **Context** (`in Installation`, `in retry_with_backoff`) is the
  grammar-derived block context. It is not on a `Finding`, so it is recovered
  by extracting the same source a second time under the same resolved policy
  with `IncludeStructure`, and matching blocks to findings **by span** rather
  than by block id: nothing in the API promises that requesting structure
  leaves block numbering untouched, and byte ranges are what both extractions
  agree on by construction. A failure there costs context lines and nothing
  else, so it is swallowed rather than failing an analysis that succeeded.

## The page

Vanilla TypeScript bundled by esbuild. No framework, no virtual DOM, two entry
points: `dist/main.js` and `dist/worker.js`.

The engine runs in a module Worker, because an analysis is a few hundred
milliseconds of straight-line Go with no yield in it, and on the main thread
that is a few hundred milliseconds in which the page cannot repaint — the sweep
animation the visitor is watching would freeze exactly while the work it
represents is happening.

Boot order in the Worker is not negotiable:

1. install `globalThis.__unswellHost`;
2. load `wasm_exec.js`, which installs `globalThis.Go`;
3. instantiate `unswell.wasm` and `go.run()`, never awaited.

`wasm_exec.js` is loaded rather than bundled, because it must byte-match the
toolchain that linked the binary; the manifest records its hash for exactly
that reason. Both vendored files are requested at a URL carrying the first 16
hex of their own sha256. GitHub Pages serves everything with a fixed max-age
and cannot be told otherwise, so a plain path would let a browser pair a
freshly revalidated manifest with the previous binary still in its cache — the
tab would then report one version before boot and another after.

Download progress is real bytes. A counting `TransformStream` sits between
`fetch` and `WebAssembly.compileStreaming`, so the module still compiles as it
downloads instead of being buffered first, and the denominator comes from the
manifest rather than `Content-Length`: on a gzipped response `Content-Length`
is the *encoded* length while `response.body` yields decoded bytes, and
dividing one by the other would show 220%.

### Three things the renderer has to get right

`web/src/render.ts` turns one string plus one report into the marked-up
document. Each of these is a correctness problem, not a styling one:

1. **The engine speaks in UTF-8 byte offsets; JavaScript strings are UTF-16.**
   An em dash, a curly quote or an accented name shifts every offset after it.
   The document is converted once into a byte-offset-to-code-unit table, and
   every slice goes through it. Slicing by raw offset is correct for pure ASCII
   and silently wrong for exactly the prose this tool is for.
2. **Findings overlap.** A long-sentence finding contains a phrase finding, and
   a paragraph-scope gate finding contains both. The ranges are flattened into
   non-overlapping slices first, and each slice is wrapped outermost-first so
   the DOM nests the way the spans nest.
3. **A finding's span is not all source text.** A phrase match in Markdown
   steps over the inline markup between its words, and the engine says so in
   `segments`. Segments separated by whitespace alone are merged, so "As an AI
   language model" is one fill rather than five; segments separated by anything
   else are left apart, because that gap is markup the rule never saw.

Everything is built with `createElement` and `textContent`. No string of HTML
is assembled from the visitor's text anywhere.

A finding whose scope is `paragraph` or `document` — or whose span is wider
than a phrase — is drawn as a dotted underline rather than a fill. Filling a
whole sentence would claim the rule objected to every word in it; an underline
says "this stretch", which is what the rule said.

### What is deliberately not there

- **No dark mode.** The mock is one light palette and the page implements that
  palette. `color-scheme: light` is declared so form controls match rather than
  inverting.
- **No Markdown or Python rendering.** The document pane shows the source as
  typed, with hard line breaks preserved. It is what the engine read.
- **Two formats, not eighteen.** The engine supports eighteen; each one would
  need a sample, a document font and a legend line of its own.

## The samples

Three files in `web/samples/`, and `test/samples.mjs` runs all three through
the real engine on every `make test`:

| File | technical | strict |
| --- | --- | --- |
| `ai-flavored.md` | 12 findings, max index 58.7, gate **fails** | 14 findings, gate fails |
| `revised.md` | **0 findings**, gate passes | 0 findings, gate passes |
| `retry_client.py` | 10 findings, max index 56.0, gate **fails** | 11 findings, gate fails |

The phrasings are derived from the executable examples in the rule catalog's
own descriptors, so every finding they trigger is a genuine activation of a
real rule rather than a guess at what the linter dislikes.

The revision's zero is asserted **exactly**, not as a floor. The page describes
it as clean, and a rule change upstream that turns it dirty has to fail the
build rather than make the page a liar. The other two are asserted as floors,
because a new rule catching more of a deliberately bad document is not a
regression.

## Deploy

The site is [play.unswell.dev](https://play.unswell.dev): GitHub Pages, with
the source set to *GitHub Actions* and the domain in `web/CNAME`. Every push to
`main` runs `.github/workflows/deploy.yml`; a pull request runs the checks and
stops. `workflow_dispatch` re-runs a deploy by hand.

**check** — typecheck, the unit suite, bundle, then
`web/scripts/check-site.mjs`: the CNAME says exactly `play.unswell.dev`;
`index.html` and `404.html` exist; every `href`, `src` and CSS `url()` on every
page resolves to a real file; the files JavaScript reaches by path
(`dist/worker.js`, the three samples) exist; the OFL texts sit beside the
woff2 files; no `github.io` address appears anywhere; the committed manifest
names the commit the pin records. No Go and no 46 MB link, so it
fails fast.

**deploy** — reads the pin, restores or builds the wasm, verifies it against what is committed, runs
`make test` against the linked binary, bundles, stages `_site`, runs the same
site check with nothing exempt — the binary's sha256 and byte count against the
manifest this time — asserts the artifact is under the Pages ceiling, and
uploads.

The wasm cache is keyed on the pin plus a hash of `runtime/`,
`upstream-patch/`, the build script and the catalog helper, with **no**
restore-keys: a near miss would hand the deploy a binary built from different
sources, which is worse than a slow build. When the key hits, the Go toolchain
is not even installed.

**smoke** — fetches the deployed site: 200 on the root, the site's own 404 page
on an unknown address, the bundle and the samples present, `application/wasm` on
the binary, and the sha256 of the bytes the CDN actually returned against the
manifest that same origin serves.

The manifest comparison in the deploy job is an **identity** check
(`unswellVersion`, `unswellCommit`, `unswellCommitDate`, `goVersion`,
`wasmExec`, `rules`), and the wasm's own sha256 is compared as a warning rather
than a gate. A Go js/wasm link is not byte-reproducible: the linker embeds a
build id derived from paths and build metadata, so two builds of identical
source differ even on the same host.

### The open question: compression

A cold visit downloads a 45.6 MiB WebAssembly binary. It compresses to
20.8 MiB, and the loading experience assumes that is what crosses the wire.
Whether the CDN in front of GitHub Pages compresses an asset that large has not
been measured here, so the smoke test measures it rather than assuming it,
sending `Accept-Encoding: gzip` by hand and reporting the wire bytes.

If it is compressed, the run says so. If it is not, it raises a warning with
the measured numbers: 45.6 MiB per cold visit instead of 20.8 MiB, and the
100 GB/month Pages bandwidth allowance covering roughly 2,200 visits instead of
4,900. That would need a real fix — a CDN in front that does compress, or a
pre-compressed copy served deliberately — not a smaller loader animation.

To measure it against anything, including `make serve`:

    make smoke BASE=http://127.0.0.1:8790/

## Security

The page sets its Content-Security-Policy in a meta tag:

    default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self';
    img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self';
    object-src 'none'; base-uri 'none'; form-action 'none'

`'wasm-unsafe-eval'` is what compiling the module needs. A dedicated Worker
started from a same-origin script with no CSP headers of its own inherits this
policy, which is why the directive has to be on the page rather than on the
Worker — and why the Worker is a real file rather than a `blob:` URL. The page
ships no inline script, so `script-src` carries no hash; `npm run build` fails
if an inline script appears without a matching one.

## License

MIT. The vendored web fonts carry their own terms; see
`web/assets/fonts/LICENSES.md`. Unswell itself is a separate repository with
its own license.
