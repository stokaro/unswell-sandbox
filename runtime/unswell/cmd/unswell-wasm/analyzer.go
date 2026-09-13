//go:build js

package main

import (
	"context"
	"fmt"
	"runtime/debug"
	"sync"
	"syscall/js"
	"time"

	"github.com/stokaro/unswell/document"
)

// analyzer owns the Go half of the boundary: globalThis.__unswell.
//
// One analysis runs at a time. Not a policy choice -- a js/wasm instance is one
// goroutine scheduler over one linear memory, and a second engine run started
// while the first is still walking a document buys nothing and doubles the peak
// heap. A second analyze while one is in flight is refused through that run's
// own failed(), so the host learns about it on the channel it is already
// listening to.
type analyzer struct {
	host    *host
	engines *engineSet

	mu     sync.Mutex
	active *activeRun
}

type activeRun struct {
	id     int
	cancel context.CancelFunc
}

func newAnalyzer(h *host, engines *engineSet) *analyzer {
	return &analyzer{host: h, engines: engines}
}

// install publishes globalThis.__unswell.
//
// The js.Func values are never released. They are the program's entire
// interface and the program never exits; releasing them would leave the host
// holding functions that throw.
func (a *analyzer) install() {
	js.Global().Set(runtimeGlobal, js.ValueOf(map[string]any{
		"analyze": js.FuncOf(a.jsAnalyze),
		"cancel":  js.FuncOf(a.jsCancel),
	}))
}

// jsAnalyze implements __unswell.analyze(runId, text, profile, format).
//
// It validates and returns. The analysis itself runs on a goroutine started
// from a setTimeout callback, because a js.FuncOf callback that blocks blocks
// JavaScript's event loop with it, and this one is going to block: extraction,
// segmentation and forty rules over the whole document, with no yield in the
// middle.
func (a *analyzer) jsAnalyze(_ js.Value, args []js.Value) any {
	defer a.recoverCallback("analyze")

	runID, ok := argInt(args, 0)
	if !ok {
		// Without a usable run id there is no run to report a failure against.
		a.host.reportPanic(fmt.Sprintf(
			"unswell-wasm: %s.analyze: the first argument must be a run id number", runtimeGlobal))
		return nil
	}
	text, ok := argString(args, 1)
	if !ok {
		a.refuse(runID, "the second argument must be the text to analyze, as a string")
		return nil
	}
	profile, ok := argString(args, 2)
	if !ok {
		a.refuse(runID, "the third argument must be a profile name, as a string")
		return nil
	}
	format, ok := argString(args, 3)
	if !ok {
		a.refuse(runID, "the fourth argument must be a format name, as a string")
		return nil
	}
	a.start(runID, text, profile, format)
	return nil
}

// jsCancel implements __unswell.cancel(runId).
//
// Cancelation is cooperative and only that. It cancels the run's context, which
// the engine checks between sources, between rules and inside the longer loops,
// so it takes effect wherever the engine looks -- and nowhere else. It cannot
// interrupt a rule in the middle of one document: that call owns the thread
// until it returns, no other goroutine runs during it, and the JavaScript event
// loop that would deliver a second message is not running either. On a document
// this page accepts, the whole analysis is short enough that this is a
// distinction without a visible difference; it is still what the word means.
func (a *analyzer) jsCancel(_ js.Value, args []js.Value) any {
	defer a.recoverCallback("cancel")

	runID, ok := argInt(args, 0)
	if !ok {
		return nil
	}
	a.mu.Lock()
	run := a.active
	a.mu.Unlock()
	if run != nil && run.id == runID {
		run.cancel()
	}
	return nil
}

// start accepts a run, or refuses it because one is already in flight.
func (a *analyzer) start(runID int, text, profile, format string) {
	a.mu.Lock()
	if a.active != nil {
		busy := a.active.id
		a.mu.Unlock()
		a.refuse(runID, fmt.Sprintf(
			"analysis %d is still running; this runtime analyzes one document at a time", busy))
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	a.active = &activeRun{id: runID, cancel: cancel}
	a.mu.Unlock()

	a.spawn(func() { a.execute(ctx, runID, text, profile, format) })
}

// spawn runs fn after the JavaScript call that asked for it has returned.
//
// A bare goroutine is not enough, and the difference is observable. Go's
// js/wasm scheduler runs every runnable goroutine before it hands control back
// to JavaScript, so work started with `go run()` inside __unswell.analyze
// executes in full -- and calls result() -- before analyze() returns to its
// caller. The page would then have painted its "analyzing" state after the
// answer had already arrived.
//
// setTimeout is what actually yields: the callback is a fresh macrotask, so the
// host's analyze() has returned and its own bookkeeping has run before the
// engine touches the document. The goroutine inside the callback is still
// required, because fn blocks and a js.FuncOf callback that blocks blocks the
// event loop.
func (a *analyzer) spawn(fn func()) {
	var callback js.Func
	callback = js.FuncOf(func(js.Value, []js.Value) any {
		callback.Release()
		go func() {
			// The last resort. A panic on a goroutine nobody is recovering
			// takes the whole WebAssembly instance with it, and the host is
			// left with a runtime that answers nothing. Everything reachable
			// from here has its own recover; this one exists for what those
			// miss.
			defer func() {
				if recovered := recover(); recovered != nil {
					a.host.reportPanic(fmt.Sprintf("unswell-wasm: %v\n\n%s", recovered, debug.Stack()))
				}
			}()
			fn()
		}()
		return nil
	})
	js.Global().Call("setTimeout", callback, 0)
}

// refuse reports a run that was never accepted, through the same failed() the
// host is already waiting on.
//
// Deferred like an accepted run, so that a refusal and a report reach the host
// the same way: after analyze() has returned.
func (a *analyzer) refuse(runID int, message string) {
	a.spawn(func() {
		a.host.failed(runID, "unswell-wasm: "+message)
	})
}

// execute analyzes one document to completion. It runs on its own goroutine;
// see [analyzer.jsAnalyze].
func (a *analyzer) execute(ctx context.Context, runID int, text, profile, format string) {
	defer func() {
		if recovered := recover(); recovered != nil {
			// The engine returns operational failures as errors, so reaching
			// here means the fault was outside it -- in this package, or in the
			// host boundary. It is reported as a fault and the run is still
			// completed, so the page is not left waiting.
			safely(func() { a.host.failed(runID, fmt.Sprintf("unswell-wasm: internal error: %v", recovered)) })
			a.host.reportPanic(fmt.Sprintf("run %d: %v\n\n%s", runID, recovered, debug.Stack()))
		}
		a.finish(runID)
	}()

	syntax, err := parseFormat(format)
	if err != nil {
		a.host.failed(runID, "unswell-wasm: "+err.Error())
		return
	}
	engine, err := a.engines.engine(profile)
	if err != nil {
		a.host.failed(runID, "unswell-wasm: "+err.Error())
		return
	}

	source := document.Source{
		Name:   defaultSourceName + extensionFor(syntax),
		Format: syntax,
		Bytes:  []byte(text),
	}

	started := time.Now()
	result, err := engine.Analyze(ctx, source)
	elapsed := time.Since(started)
	if err != nil {
		// A cancelation is a cancelation, not a broken engine, and the page
		// says so rather than showing an error card for a run the visitor
		// abandoned.
		if ctx.Err() != nil {
			a.host.failed(runID, "canceled")
			return
		}
		a.host.failed(runID, err.Error())
		return
	}

	encoded, err := buildPayload(ctx, engine, source, result, profile, elapsed)
	if err != nil {
		a.host.failed(runID, "unswell-wasm: "+err.Error())
		return
	}
	a.host.result(runID, encoded)
}

func (a *analyzer) finish(runID int) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.active != nil && a.active.id == runID {
		a.active = nil
	}
}

// extensionFor gives the source a filename the engine's own format detection
// would agree with. Nothing here depends on it -- Source.Format is explicit --
// but a report that names "playground.md" reads as a document and one that
// names "playground" reads as a mistake.
func extensionFor(format document.Format) string {
	switch format {
	case document.Markdown:
		return ".md"
	case document.Python:
		return ".py"
	default:
		return ".txt"
	}
}

// recoverCallback keeps a fault inside a JavaScript callback from taking down
// the WebAssembly instance.
//
// One case is not hypothetical: syscall/js cannot represent a JavaScript
// BigInt, and js.Value.Type() panics outright when handed one. A host that
// passes a BigInt run id gets a reported fault instead of a dead runtime.
func (a *analyzer) recoverCallback(method string) {
	if recovered := recover(); recovered != nil {
		a.host.reportPanic(fmt.Sprintf("unswell-wasm: %s.%s: %v", runtimeGlobal, method, recovered))
	}
}

func argInt(args []js.Value, index int) (int, bool) {
	if index >= len(args) || args[index].Type() != js.TypeNumber {
		return 0, false
	}
	return args[index].Int(), true
}

func argString(args []js.Value, index int) (string, bool) {
	if index >= len(args) || args[index].Type() != js.TypeString {
		return "", false
	}
	return args[index].String(), true
}

// safely runs fn and swallows a panic from it. Used only where the alternative
// is worse than the fault: a throw crossing back from the host during a run's
// teardown, where losing the fault costs a diagnostic and keeping it costs the
// instance.
func safely(fn func()) {
	defer func() { _ = recover() }()
	fn()
}
