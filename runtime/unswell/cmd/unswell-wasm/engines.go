//go:build js

package main

import (
	"fmt"
	"sync"

	"github.com/stokaro/unswell"
	"github.com/stokaro/unswell/document"
	"github.com/stokaro/unswell/nlp"
	"github.com/stokaro/unswell/nlp/english"
	"github.com/stokaro/unswell/rule"
)

// engineProfiles are the scoring profiles this build offers, in the order the
// page presents them. Both are builtin Unswell profiles; the playground does
// not invent a third.
var engineProfiles = []string{"technical", "strict"}

// defaultSourceName is the logical filename the page's text is analyzed under.
// The engine resolves per-file policy overrides by name, and there are none
// here, but the name still appears in every Location.Path and in the report, so
// it is chosen to read as what it is rather than as a real path.
const defaultSourceName = "playground"

// profileConfig is the whole configuration the playground supplies: one builtin
// profile layer and nothing else. Anything more would make the page's findings
// depend on settings the visitor cannot see.
func profileConfig(profile string) []byte {
	if profile == "technical" {
		// The builtin default. Passing no config at all is the same policy and
		// keeps the config hash the one a CLI run with no .unswell.yaml
		// produces, which is what a visitor would reproduce locally.
		return nil
	}
	return []byte(fmt.Sprintf("version: 1\nextends:\n  - builtin:%s-v1\n", profile))
}

// engineSet holds one engine per profile over one shared NLP provider.
//
// The provider is the expensive half of construction -- it carries the sentence
// segmentation model -- and unswell.Options takes it as an input, so building it
// once and handing it to both engines halves the boot cost. Engines are
// immutable after construction and safe for concurrent use, which is what makes
// sharing them across runs legitimate rather than merely convenient.
type engineSet struct {
	provider nlp.Provider

	mu      sync.Mutex
	engines map[string]*unswell.Engine
}

func newEngineSet() (*engineSet, error) {
	provider, err := english.New()
	if err != nil {
		return nil, fmt.Errorf("build the English NLP provider: %w", err)
	}
	set := &engineSet{provider: provider, engines: map[string]*unswell.Engine{}}

	// The default profile is built eagerly: ready() announces the rule catalog,
	// and the catalog comes from an engine. The others are built on first use,
	// so a visitor who never leaves the default never pays for them.
	if _, err := set.engine(engineProfiles[0]); err != nil {
		return nil, err
	}
	return set, nil
}

// engine returns the engine for a profile, building it on first use.
func (s *engineSet) engine(profile string) (*unswell.Engine, error) {
	if !validProfile(profile) {
		return nil, fmt.Errorf("unknown profile %q", profile)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if engine := s.engines[profile]; engine != nil {
		return engine, nil
	}
	engine, err := unswell.New(unswell.Options{
		Config: profileConfig(profile),
		NLP:    s.provider,
		// The page analyzes whatever was typed, including an empty box and a
		// code file with no prose in it. An empty scan is a legitimate answer
		// here -- "nothing to report" -- not an operational failure, so the
		// gate's fail-on-empty is not what the visitor should meet.
		AllowEmpty: true,
		// One document, one goroutine. js/wasm has one scheduler over one
		// linear memory and the page never submits a batch.
		Jobs: 1,
	})
	if err != nil {
		return nil, fmt.Errorf("build the %s engine: %w", profile, err)
	}
	s.engines[profile] = engine
	return engine, nil
}

func (s *engineSet) catalog() []rule.Descriptor {
	engine, err := s.engine(engineProfiles[0])
	if err != nil {
		return nil
	}
	return engine.Catalog()
}

// engineVersion is the release identity the engine itself reports, which is not
// the same thing as the submodule tag this repository pinned. They agree on a
// released commit and disagree on a commit between releases, and the page shows
// both rather than picking one.
func (s *engineSet) engineVersion() string { return unswell.Version }

func (s *engineSet) schemaVersion() string { return unswell.SchemaVersion }

func validProfile(profile string) bool {
	for _, candidate := range engineProfiles {
		if candidate == profile {
			return true
		}
	}
	return false
}

// supportedFormats are the input syntaxes the page offers.
//
// The engine supports eighteen; the page offers two, because every format needs
// a sample, a document font and a legend line of its own, and a select box of
// eighteen syntaxes is not the point of the page. Both names are
// document.Format constants rather than strings, so a rename upstream fails
// this build instead of the visitor's analysis.
func supportedFormats() []any {
	return []any{string(document.Markdown), string(document.Python)}
}

// parseFormat maps a name from the host onto a document.Format, refusing
// anything the page does not offer.
func parseFormat(name string) (document.Format, error) {
	for _, offered := range supportedFormats() {
		if offered == name {
			return document.Format(name), nil
		}
	}
	return "", fmt.Errorf("unsupported format %q", name)
}
