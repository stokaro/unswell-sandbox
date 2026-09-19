# The sandbox has no Go module of its own; everything is built inside a
# materialized copy of the commit third_party/unswell.pin names. See
# scripts/build-wasm.sh.

SHELL := /bin/sh

.POSIX:
.PHONY: wasm pin build-web serve check-site smoke test test-contract test-samples test-frames test-rhetoric test-numbered \
	typecheck test-unit ui-probe dev-tree clean

# wasm builds web/vendor/unswell/{unswell.wasm,wasm_exec.js,manifest.json}.
wasm:
	scripts/build-wasm.sh

# pin moves the playground to another Unswell commit and records it in
# third_party/unswell.pin. `make pin REF=v0.1.0-alpha.4` takes a tag or a
# commit; with no REF it takes the tip of main. Run `make wasm` after it.
pin:
	scripts/pin-unswell.sh $(REF)

# build-web installs the pinned npm dependencies and bundles the page's
# TypeScript into web/dist. It does not touch the wasm; `make wasm` does that,
# and the two are independent -- the page loads and reads as a page before any
# WebAssembly arrives.
build-web:
	cd web && npm ci && npm run build

typecheck:
	cd web && npx tsc --noEmit

# serve serves web/ the way GitHub Pages does: a directory of static files at
# the root of the origin, nothing generated on request. Run `make build-web`
# and `make wasm` first, or the page will 404 on dist/ and on the binary.
serve:
	@echo "web/ on http://127.0.0.1:8790/ -- ^C to stop"
	cd web && python3 -m http.server 8790 --bind 127.0.0.1

# check-site is the gate the deploy workflow runs before publishing: the CNAME,
# every href/src and CSS url() resolving, the font licenses present, no
# github.io address, and the manifest agreeing with both the wasm and the
# recorded pin. Run it before pushing and CI will not tell you anything you
# did not already know.
check-site:
	node web/scripts/check-site.mjs --root web

# test drives the real binary outside a browser: the host contract, then the
# three sample documents through the real rule catalog. It needs
# web/vendor/unswell/unswell.wasm, so run `make wasm` first if Go source moved.
test: test-unit test-contract test-samples test-frames test-rhetoric test-numbered

# test-contract exercises the host boundary itself: ready(), one analysis, a
# refused concurrent analysis, a rejected format and a rejected profile.
test-contract:
	node test/contract.mjs

# test-samples asserts that the three sample documents still mean what the page
# says they mean, including that the revision produces exactly zero findings.
test-samples:
	node test/samples.mjs

# test-frames checks contextual constructions on declared probes and pinned Ptah prose.
test-frames:
	node test/frames.mjs

test-rhetoric:
	node test/ptah-rhetoric.mjs

test-numbered:
	node test/numbered-framing.mjs

# test-unit is the renderer's arithmetic: UTF-8 byte offsets onto UTF-16
# indices, and the score bands. No wasm and no browser.
test-unit:
	cd web && npm run test:unit

# ui-probe drives the real page in headless Chrome and asserts by reading the
# DOM: the runtime reaches ready, the samples analyze, the marks and the notes
# point at each other, the revision comes back clean, Python mode dims the code,
# and an edit drops the report. It needs `make serve` running in another shell,
# and Chrome on the PATH or in $$CHROME.
#   make ui-probe                  assert only
#   make ui-probe SHOTS=.refs      assert, then write desktop.png and narrow.png
SHOTS =
ui-probe:
	node web/scripts/ui-probe.mjs --base http://127.0.0.1:8790/ \
	  $(if $(SHOTS),--shots $(abspath $(SHOTS)),)

# smoke drives the deployed site over the network. With no argument it tests
# production; pass a base URL to point it at `make serve`:
#   make smoke BASE=http://127.0.0.1:8790/
BASE = https://play.unswell.dev/
smoke:
	sh web/scripts/smoke.sh "$(BASE)"

# dev-tree materializes build/unswell-src with runtime/unswell symlinked in and
# writes a go.work, so an editor can typecheck the sandbox's Go sources against
# the real unswell module without a build.
dev-tree:
	scripts/build-wasm.sh --tree-only --link

clean:
	rm -rf build go.work go.work.sum _site web/dist
	rm -f web/vendor/unswell/unswell.wasm web/vendor/unswell/wasm_exec.js \
		web/vendor/unswell/manifest.json
