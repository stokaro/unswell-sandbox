// Command catalog prints the engine's rule catalog as JSON.
//
// It is copied into the materialized Unswell tree at build time, run once, and
// removed again; see scripts/build-wasm.sh. The point is that the list in
// web/vendor/unswell/manifest.json is walked from the same rule registry the
// js/wasm binary links, so the page can never advertise a rule the engine does
// not have.
//
// The output is deliberately small. The page shows a count and the browser gets
// the authoritative catalog from Engine.Catalog() at ready(); this copy exists
// so the page can state what it is about to load before it has loaded it, and
// so CI can compare a fresh build against the committed manifest.
package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/stokaro/unswell"
)

type entry struct {
	ID       string `json:"id"`
	Version  string `json:"version"`
	Group    string `json:"group"`
	Severity string `json:"severity"`
	Summary  string `json:"summary"`
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "catalog: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	engine, err := unswell.New(unswell.Options{})
	if err != nil {
		return err
	}
	descriptors := engine.Catalog()
	entries := make([]entry, 0, len(descriptors))
	for _, descriptor := range descriptors {
		entries = append(entries, entry{
			ID:       descriptor.ID,
			Version:  descriptor.Version,
			Group:    descriptor.Group,
			Severity: descriptor.Defaults.Severity,
			Summary:  descriptor.Summary,
		})
	}
	// Indented, because the manifest is committed and a one-line array of two
	// hundred rules makes every pin bump an unreadable diff.
	encoded, err := json.MarshalIndent(entries, "  ", "  ")
	if err != nil {
		return err
	}
	_, err = os.Stdout.Write(encoded)
	return err
}
