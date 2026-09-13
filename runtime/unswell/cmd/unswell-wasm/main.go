//go:build js

// Command unswell-wasm is the Unswell engine compiled for a browser.
//
// It is the real engine, not a reimplementation: the same rule catalog, the
// same extraction, the same scoring and the same gate as the CLI, from a pinned
// upstream tag. What differs is everything around it -- there is no process, no
// filesystem to discover sources in and no terminal to print to -- so this
// package supplies the two things a command would have given it: a host
// boundary to answer through, and one document at a time to analyze.
//
//   - JavaScript installs globalThis.__unswellHost before the Go program
//     starts; Go installs globalThis.__unswell once it is running. See host.go
//     and analyzer.go.
//   - An engine per scoring profile, sharing one NLP provider, built once and
//     reused. See engines.go.
//
// The program never exits. main installs the boundary and then blocks forever,
// because a js/wasm instance whose main returns is torn down, taking the engine
// with it.
package main

import (
	"fmt"
	"os"
)

// Stamped by scripts/build-wasm.sh from the submodule pin. The defaults are
// what a hand build reports, and they are deliberately not a version number: a
// binary that does not know what it is should say so rather than claim a
// release.
var (
	buildVersion = "(unstamped)"
	buildCommit  = "(unstamped)"
	buildDate    = ""
)

func main() {
	host, err := connectHost()
	if err != nil {
		// Nothing to report the failure through: the host boundary is the
		// failure. fd 2 is the only channel left, and returning from main ends
		// the instance without ever calling ready(), which is what tells the
		// host that initialization failed.
		fmt.Fprintf(os.Stderr, "unswell-wasm: %v\n", err)
		return
	}

	engines, err := newEngineSet()
	if err != nil {
		host.reportPanic(fmt.Sprintf("unswell-wasm: %v", err))
		return
	}

	analyzer := newAnalyzer(host, engines)
	analyzer.install()
	host.ready(readyInfo(engines))

	// A js/wasm main that returns ends the instance. Everything from here on
	// happens in the goroutines the JavaScript callbacks start.
	select {}
}
