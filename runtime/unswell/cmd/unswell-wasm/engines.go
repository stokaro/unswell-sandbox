//go:build js

package main

import (
	_ "embed"
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

// originPack is the fitted origin model this build ships. It is an experimental
// research artifact over a corpus that is not qualified, it decides no gate, and
// it estimates similarity to a training class rather than anything about who
// wrote a text. The page says as much beside every number it produces.
//
//go:embed origin-pack.json
var originPack []byte

// originContexts is the extraction policy the pack was fitted under. A pack is
// refused unless the run prepares text the same way, and the builtin default
// leaves this section implicit, which hashes differently. Writing the same list
// out changes no finding -- the contexts are the ones the builtin profiles
// already use -- and it is what lets the channel run at all.
const originContexts = "extraction:\n  contexts: [comment, heading, list-item, paragraph, string, table-cell]\n"

// originChannel turns the channel on for an experimental pack and keeps it out
// of the gate. An incompatible pack abstains rather than failing the run: the
// visitor came to see findings, and losing them to a model mismatch would be a
// worse answer than a missing estimate.
const originChannel = "origin:\n  model: pack\n  accept_experimental: true\n  on_incompatible: unavailable\n"

// profileConfig is the whole configuration the playground supplies: one builtin
// profile layer, the extraction contexts the origin pack requires, and the
// origin channel itself. Anything more would make the page's findings depend on
// settings the visitor cannot see.
func profileConfig(profile string) []byte {
	layer := ""
	if profile != "technical" {
		layer = fmt.Sprintf("extends:\n  - builtin:%s-v1\n", profile)
	}
	return []byte("version: 1\n" + layer + originContexts + originChannel)
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
		Config:      profileConfig(profile),
		NLP:         s.provider,
		OriginModel: originPack,
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
