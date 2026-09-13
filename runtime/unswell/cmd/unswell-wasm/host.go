//go:build js

package main

import (
	"errors"
	"fmt"
	"runtime"
	"syscall/js"
)

// hostGlobal is the object JavaScript installs before starting Go. It has to
// exist by the time main runs; there is no way to install it afterwards,
// because Go has no way to wait for it without blocking the event loop that
// would deliver it.
const hostGlobal = "__unswellHost"

// runtimeGlobal is the object Go installs once it is running.
const runtimeGlobal = "__unswell"

// requiredHostMethods is the host half of the contract. Every one is checked at
// startup rather than at the first call, so a host that forgot one learns about
// it before a visitor has pressed Analyze.
var requiredHostMethods = []string{"ready", "result", "failed", "panic"}

// host is the JavaScript side of the boundary.
//
// The object is resolved once and held, rather than looked up per call: the
// host installs it before Go starts, and replacing it afterwards would swap the
// destination of a run's answer halfway through, which no host has a reason to
// do and no reader could make sense of.
type host struct {
	object js.Value
}

// connectHost resolves and validates the host object.
func connectHost() (*host, error) {
	object := js.Global().Get(hostGlobal)
	if object.Type() != js.TypeObject {
		return nil, fmt.Errorf("globalThis.%s is %s, want an object installed before the Go program starts",
			hostGlobal, object.Type())
	}
	var missing []error
	for _, method := range requiredHostMethods {
		if object.Get(method).Type() != js.TypeFunction {
			missing = append(missing, fmt.Errorf("%s.%s is not a function", hostGlobal, method))
		}
	}
	if len(missing) > 0 {
		return nil, fmt.Errorf("incomplete host boundary: %w", errors.Join(missing...))
	}
	return &host{object: object}, nil
}

// ready announces what this build is, once, before any analysis is accepted.
func (h *host) ready(info map[string]any) {
	h.object.Call("ready", info)
}

// result delivers one analysis. The payload is a JSON string rather than a
// js.Value tree: syscall/js builds a JavaScript object one property at a time
// across the boundary, and a report with a few hundred findings costs far more
// that way than one Marshal and one JSON.parse.
func (h *host) result(runID int, payload string) {
	h.object.Call("result", runID, payload)
}

// failed reports that one analysis did not produce a report. Operational
// failures are errors here exactly as they are in the engine; a document with
// no findings is a successful result, not a failure.
func (h *host) failed(runID int, message string) {
	h.object.Call("failed", runID, message)
}

// reportPanic hands the host a failure that belongs to no single run.
//
// It swallows a throw from the host itself. This is the last channel a failure
// has, and a host whose panic handler throws would otherwise turn one fault
// into an unrecoverable one inside a deferred recover.
func (h *host) reportPanic(message string) {
	defer func() { _ = recover() }()
	h.object.Call("panic", message)
}

// readyInfo is the capability announcement.
//
// The version and commit come from this binary's build stamp, so the page
// reports the Unswell that is actually running rather than whatever release the
// site was built beside. The rule list comes from Engine.Catalog() for the same
// reason: a hand-maintained list is a list that is wrong.
func readyInfo(engines *engineSet) map[string]any {
	descriptors := engines.catalog()
	rules := make([]any, 0, len(descriptors))
	for _, descriptor := range descriptors {
		rules = append(rules, map[string]any{
			"id":       descriptor.ID,
			"version":  descriptor.Version,
			"group":    descriptor.Group,
			"severity": descriptor.Defaults.Severity,
			"summary":  descriptor.Summary,
		})
	}
	profiles := make([]any, 0, len(engineProfiles))
	for _, profile := range engineProfiles {
		profiles = append(profiles, profile)
	}
	return map[string]any{
		"version":     buildVersion,
		"commit":      buildCommit,
		"commitDate":  buildDate,
		"goVersion":   runtime.Version(),
		"engineTag":   engines.engineVersion(),
		"schema":      engines.schemaVersion(),
		"rules":       rules,
		"profiles":    profiles,
		"formats":     supportedFormats(),
		"defaultName": defaultSourceName,
	}
}
