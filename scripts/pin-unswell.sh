#!/bin/sh
# Move the playground to another Unswell commit.
#
#   scripts/pin-unswell.sh              # main
#   scripts/pin-unswell.sh v0.1.0-alpha.4
#   scripts/pin-unswell.sh 1f5c7a6
#
# It resolves the ref against the mirror, records the commit, the version git
# describes it as, and its commit date, and leaves the build to scripts/
# build-wasm.sh. Nothing else in the repository holds a copy of that commit,
# so this file is the whole pin.
set -eu

LC_ALL=C
export LC_ALL

repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo"

die() {
	echo "pin-unswell: $*" >&2
	exit 1
}

. "$repo/scripts/unswell-git.sh"

ref=${1:-main}
[ $# -le 1 ] || die "usage: pin-unswell.sh [ref]"

mirror_ready
mirror_fetch

# The mirror is bare, so the remote's branches are its own heads: "main", not
# "origin/main". Accept either spelling rather than make the caller remember.
resolved=${ref#origin/}
commit=$(git -C "$UNSWELL_MIRROR" rev-parse --verify --quiet "$resolved^{commit}") ||
	die "$ref does not name a commit in $UNSWELL_REMOTE"

# --abbrev is pinned because git sizes the default from the repository's object
# count, so the same commit describes as g2a2a6d441534 in one clone and
# g2a2a6d4 in another. Twelve is the width Go pseudo-versions use, and it makes
# the suffix the first twelve of the commit the pin records beside it.
version=$(git -C "$UNSWELL_MIRROR" describe --tags --always --abbrev=12 "$commit")
date=$(git -C "$UNSWELL_MIRROR" show -s --format=%cI "$commit")

previous=$(pin_field commit 2>/dev/null || true)

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
# Keep the comment header and replace only the three data lines, so the file
# explains itself to the next reader without this script owning its prose.
awk -v commit="$commit" -v version="$version" -v date="$date" '
	$1 == "commit"  { print "commit " commit;   next }
	$1 == "version" { print "version " version; next }
	$1 == "date"    { print "date " date;       next }
	{ print }
' "$UNSWELL_PIN" >"$tmp"
cat "$tmp" >"$UNSWELL_PIN"

if [ "$previous" = "$commit" ]; then
	echo "pin-unswell: already at $version ($commit)"
else
	echo "pin-unswell: $version ($commit)"
	echo "pin-unswell: run 'make wasm' and commit $UNSWELL_PIN with web/vendor/unswell/manifest.json"
fi
