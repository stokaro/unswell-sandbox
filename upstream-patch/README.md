# upstream-patch

Empty, and meant to stay that way.

Unswell builds for `GOOS=js GOARCH=wasm` unmodified: the engine never touches
the network, never discovers files, never reads the environment and never
exits, so a browser is just another caller. `scripts/build-wasm.sh` applies no
patches and reports the fact.

If something the browser needs ever cannot be done from outside Unswell, a
patch goes in this directory in the shape it will be proposed as upstream, and
leaves again when it merges. An empty directory here is the goal state, not an
oversight, and the build script treats it as one.
