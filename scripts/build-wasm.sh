#!/bin/sh
# Build web/vendor/unswell/{unswell.wasm,wasm_exec.js,manifest.json} from the
# commit named in third_party/unswell.pin.
#
# The sandbox has no Go module of its own. Everything is built inside a
# materialized copy of unswell at the pinned commit, so the browser entry point
# lives under github.com/stokaro/unswell/... and the engine grows no public API
# for the sake of a website. The copy is rebuilt from scratch on every run, and
# build/unswell-src is never edited by hand.
#
# Usage:
#   scripts/build-wasm.sh              build everything
#   scripts/build-wasm.sh --tree-only  materialize build/unswell-src and stop
#   scripts/build-wasm.sh --link       symlink runtime/unswell instead of copying,
#                                      so an editor pointed at build/unswell-src
#                                      edits the real files
set -eu

LC_ALL=C
export LC_ALL

# Deterministic go: never let a developer's go.work or module cache settings
# decide what a release build links.
GOWORK=off
GOFLAGS=
export GOWORK GOFLAGS

repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo"

srcdir=build/unswell-src
outdir=web/vendor/unswell
runtime=runtime/unswell

tree_only=0
link_runtime=0
for arg in "$@"; do
	case "$arg" in
	--tree-only) tree_only=1 ;;
	--link) link_runtime=1 ;;
	*)
		echo "build-wasm: unknown option: $arg" >&2
		exit 2
		;;
	esac
done

die() {
	echo "build-wasm: $*" >&2
	exit 1
}

sha256() {
	if command -v shasum >/dev/null 2>&1; then
		shasum -a 256 "$1" | cut -d' ' -f1
	elif command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | cut -d' ' -f1
	else
		die "no sha256 tool found (looked for shasum, sha256sum)"
	fi
}

bytes() {
	wc -c <"$1" | tr -d ' \t'
}

# json_string escapes a value for embedding in the manifest. Only the two
# characters that can appear in a path, a version or a rule id are handled;
# anything else would mean the input is not what this script thinks it is.
json_string() {
	printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

# ---------------------------------------------------------------------------
# 1. The pin. third_party/unswell.pin names the commit, the version git
#    describes it as, and its commit date. All three are checked against git
#    rather than trusted, so an edited line fails the build instead of
#    mislabeling a binary.
# ---------------------------------------------------------------------------

. "$repo/scripts/unswell-git.sh"

pinned=$(pin_field commit)
unswell_version=$(pin_field version)
unswell_date=$(pin_field date)

case "$pinned" in
*[!0-9a-f]* | "") die "$UNSWELL_PIN records commit $pinned, which is not a hexadecimal object name" ;;
esac
[ ${#pinned} -eq 40 ] || die "$UNSWELL_PIN records a $((${#pinned}))-character commit; the full 40 are needed"

mirror_ready
mirror_has "$pinned" || mirror_fetch
mirror_has "$pinned" ||
	die "$UNSWELL_REMOTE has no commit $pinned; run: scripts/pin-unswell.sh REF"

actual_version=$(git -C "$UNSWELL_MIRROR" describe --tags --always --abbrev=12 "$pinned")
[ "$actual_version" = "$unswell_version" ] ||
	die "$UNSWELL_PIN says version $unswell_version but git describes $pinned as $actual_version;\nrun: scripts/pin-unswell.sh $pinned"

actual_date=$(git -C "$UNSWELL_MIRROR" show -s --format=%cI "$pinned")
[ "$actual_date" = "$unswell_date" ] ||
	die "$UNSWELL_PIN says date $unswell_date but $pinned was committed at $actual_date;\nrun: scripts/pin-unswell.sh $pinned"

# ---------------------------------------------------------------------------
# 2. Materialize. git archive gives a tree with no .git and with mtimes taken
#    from the commit, so two runs of this script produce identical inputs.
# ---------------------------------------------------------------------------

rm -rf "$srcdir"
mkdir -p "$srcdir"
git -C "$UNSWELL_MIRROR" archive --format=tar "$pinned" | tar -x -C "$srcdir"
echo "build-wasm: materialized unswell@$(echo "$pinned" | cut -c1-12) -> $srcdir"

# An empty upstream-patch/ is the goal state, not an error: every change the
# browser build needs is meant to end up in Unswell itself. See its README.
for patch in upstream-patch/*.patch; do
	[ -e "$patch" ] || break
	# --directory rather than a cd, so the patch paths stay repo-relative and a
	# hunk that tried to escape the overlay would land outside it and fail.
	git apply --directory="$srcdir" --whitespace=error -p1 "$repo/$patch" ||
		die "failed to apply $patch"
	echo "build-wasm: applied $patch"
done

# ---------------------------------------------------------------------------
# 3. Overlay the sandbox's own Go sources at their target paths inside unswell.
# ---------------------------------------------------------------------------

if [ "$link_runtime" = 1 ]; then
	# Symlink each file so an editor opening build/unswell-src edits
	# runtime/unswell. Files only: a symlinked directory would let a stray
	# write land outside the overlay, and Go's loader is happier with real
	# directories.
	(cd "$runtime" && find . -type d) | while read -r dir; do
		mkdir -p "$srcdir/$dir"
	done
	(cd "$runtime" && find . -type f) | while read -r file; do
		ln -sf "$repo/$runtime/${file#./}" "$srcdir/${file#./}"
	done
	echo "build-wasm: linked $runtime into $srcdir"
else
	tar -cf - -C "$runtime" . | tar -xf - -C "$srcdir"
	echo "build-wasm: copied $runtime into $srcdir"
fi

# The origin pack is a file in the pinned tree, and go:embed cannot reach out of
# its own package, so it is copied next to the browser entry point. The build
# fails without it rather than shipping a page whose origin channel is silently
# off.
pack=research/origin/packs/unswell-origin-lexical-v1.json
[ -f "$srcdir/$pack" ] || die "$pack is missing from the pinned tree"
cp "$srcdir/$pack" "$srcdir/cmd/unswell-wasm/origin-pack.json"
echo "build-wasm: embedded $(basename "$pack")"

# The rule catalog has to come from the rule registry, so the helper that walks
# it is built inside the module and removed again; it is not part of what ships.
tooldir="$srcdir/cmd/internal/buildtools/catalog"
mkdir -p "$tooldir"
cp scripts/catalog/main.go "$tooldir/main.go"

if [ "$tree_only" = 1 ]; then
	rm -rf "$srcdir/cmd/internal/buildtools"
	cat >go.work <<-EOF
		go $(sed -n 's/^go \([0-9.]*\)$/\1/p' "$srcdir/go.mod" | head -1)

		use ./$srcdir
	EOF
	echo "build-wasm: wrote go.work for $srcdir"
	echo "build-wasm: tree only, stopping before the build"
	exit 0
fi

# ---------------------------------------------------------------------------
# 4. Build. The wasm binary and the JS shim that starts it are one interface
#    and must come from one toolchain, so both are taken from this GOROOT and
#    the shim's digest is recorded next to the binary's.
# ---------------------------------------------------------------------------

# The manifest records the toolchain, and CI re-links to compare, so the two
# hosts have to agree on the compiler. The engine's go.mod states the module's
# MINIMUM Go version, not the one this site is built with, so it is the wrong
# pin: reading it let a 1.25 runner disagree with a 1.27 desk.
# .go-version is the single declaration both read.
pinned_go=$(tr -d '[:space:]' < "$repo/.go-version")
go_version=$(go version | awk '{print $3}')
if [ "$go_version" != "go$pinned_go" ]; then
	die "this Go is $go_version; .go-version pins go$pinned_go. Install it or change the pin."
fi
goroot=$(go env GOROOT)
wasm_exec="$goroot/lib/wasm/wasm_exec.js"
[ -f "$wasm_exec" ] || wasm_exec="$goroot/misc/wasm/wasm_exec.js"
[ -f "$wasm_exec" ] || die "wasm_exec.js not found under $goroot"

# The catalog is walked from the rule registry rather than maintained by hand,
# so the manifest can never advertise a rule the engine does not have. It runs
# natively: the registry it reads is the same package the js/wasm link below
# compiles, from the same materialized tree.
echo "build-wasm: reading the rule catalog from the registry"
rules=$(cd "$srcdir" && go run ./cmd/internal/buildtools/catalog) ||
	die "could not read the rule catalog"
rm -rf "$srcdir/cmd/internal/buildtools"

mkdir -p "$outdir"
echo "build-wasm: building ./cmd/unswell-wasm for js/wasm with $go_version"
(
	cd "$srcdir"
	GOOS=js GOARCH=wasm go build \
		-trimpath \
		-ldflags "-s -w \
-X github.com/stokaro/unswell.BuildCommit=$pinned \
-X main.buildVersion=$unswell_version \
-X main.buildCommit=$pinned \
-X main.buildDate=$unswell_date" \
		-o "$repo/$outdir/unswell.wasm" \
		./cmd/unswell-wasm
)

cp "$wasm_exec" "$outdir/wasm_exec.js"

rule_count=$(printf '%s\n' "$rules" | grep -c '"id"')

# ---------------------------------------------------------------------------
# 5. Manifest. Everything a page needs to say what it is running, and
#    everything a bug report needs to say what it ran.
# ---------------------------------------------------------------------------

wasm_sha=$(sha256 "$outdir/unswell.wasm")
wasm_bytes=$(bytes "$outdir/unswell.wasm")
wasm_gzip=$(gzip -9 -c "$outdir/unswell.wasm" | wc -c | tr -d ' \t')
exec_sha=$(sha256 "$outdir/wasm_exec.js")
exec_bytes=$(bytes "$outdir/wasm_exec.js")

# SOURCE_DATE_EPOCH keeps the one non-deterministic field out of the way when a
# caller wants byte-identical output from two runs.
if [ -n "${SOURCE_DATE_EPOCH-}" ]; then
	built_at=$(date -u -r "$SOURCE_DATE_EPOCH" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null ||
		date -u -d "@$SOURCE_DATE_EPOCH" +%Y-%m-%dT%H:%M:%SZ)
else
	built_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
fi

{
	echo '{'
	printf '  "unswellVersion": "%s",\n' "$(json_string "$unswell_version")"
	printf '  "unswellCommit": "%s",\n' "$pinned"
	printf '  "unswellCommitDate": "%s",\n' "$(json_string "$unswell_date")"
	printf '  "goVersion": "%s",\n' "$(json_string "$go_version")"
	printf '  "builtAt": "%s",\n' "$built_at"
	echo '  "wasmExec": {'
	echo '    "file": "wasm_exec.js",'
	printf '    "sha256": "%s",\n' "$exec_sha"
	printf '    "bytes": %s\n' "$exec_bytes"
	echo '  },'
	echo '  "wasm": {'
	echo '    "file": "unswell.wasm",'
	printf '    "sha256": "%s",\n' "$wasm_sha"
	printf '    "bytes": %s,\n' "$wasm_bytes"
	printf '    "gzipBytes": %s\n' "$wasm_gzip"
	echo '  },'
	printf '  "rules": %s\n' "$rules"
	echo '}'
} >"$outdir/manifest.json"

echo "build-wasm: unswell.wasm   $wasm_bytes bytes raw, $wasm_gzip bytes gzip -9"
echo "build-wasm: wasm_exec.js   $exec_bytes bytes, sha256 $exec_sha"
echo "build-wasm: unswell        $unswell_version ($(echo "$pinned" | cut -c1-12)), $rule_count rules"
echo "build-wasm: wrote $outdir/{unswell.wasm,wasm_exec.js,manifest.json}"
