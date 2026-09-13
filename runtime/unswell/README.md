# runtime/unswell

Go sources that are copied into a materialized copy of the pinned Unswell tree
at build time, at the paths shown here. They compile as part of
`github.com/stokaro/unswell`, which is why `cmd/unswell-wasm` can be an
ordinary command in that module and Unswell grows no public API for the sake of
a website.

    cmd/unswell-wasm/    the browser entry point

Nothing in here is ever built from this directory. `scripts/build-wasm.sh`
assembles `build/unswell-src` from the submodule plus these files and builds
there; `make dev-tree` does the same with symlinks so an editor typechecks the
real files against the real module.

`main_notjs.go` exists so the package compiles on every platform. Every other
file is `//go:build js`, and a package whose files are all excluded by build
constraints is an error the moment anything names it directly.
