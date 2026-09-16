//go:build js

package main

import (
	"context"
	"encoding/json"
	"sort"
	"strings"
	"time"

	"github.com/stokaro/unswell"
	"github.com/stokaro/unswell/document"
	"github.com/stokaro/unswell/extract"
)

// The payload is the whole answer to one analysis, as the page needs it.
//
// It is a projection of unswell.Result, not a copy: the result carries a rule
// manifest, a baseline section, suppression bookkeeping and per-sentence
// assessments, and sending all of it would be several hundred kilobytes of JSON
// the page never reads. What is here is what the page renders, plus the three
// numbers it quotes back to the visitor.
//
// Two things are derived rather than forwarded, and both are worth naming:
//
//   - Units are the PARAGRAPH-scope assessments only. They are the ranges the
//     page segments the document by, the gutter scores it prints, and -- in a
//     source file, where most of the text is code -- the only ranges the engine
//     looked at, so everything outside them is dimmed.
//   - Context is the grammar-derived block context (a heading trail in
//     Markdown, the enclosing function or class in Python). It is not on a
//     Finding, so it is recovered by extracting the same source under the same
//     policy and matching blocks to findings by span. See [blockContexts].
type payload struct {
	Profile    string        `json:"profile"`
	Format     string        `json:"format"`
	Name       string        `json:"name"`
	DurationMs int64         `json:"durationMs"`
	Engine     engineStamp   `json:"engine"`
	Document   documentStamp `json:"document"`
	Gate       gateStamp     `json:"gate"`
	MaxIndex   float64       `json:"maxIndex"`
	Units      []unitStamp   `json:"units"`
	Findings   []findingStub `json:"findings"`
	// Incomplete is the engine's own word for a run that did not cover
	// everything it was asked to. The page says so rather than presenting a
	// partial report as a whole one.
	Incomplete bool     `json:"incomplete"`
	Notes      []string `json:"notes,omitempty"`
}

type engineStamp struct {
	Version        string `json:"version"`
	SchemaVersion  string `json:"schemaVersion"`
	ScoringProfile string `json:"scoringProfile"`
	RulesetHash    string `json:"rulesetHash"`
	ConfigHash     string `json:"configHash"`
	GateMode       string `json:"gateMode"`
}

type documentStamp struct {
	Bytes      int     `json:"bytes"`
	ProseWords int     `json:"proseWords"`
	Blocks     int     `json:"blocks"`
	Sentences  int     `json:"sentences"`
	Maximum    float64 `json:"maximum"`
	Median     float64 `json:"median"`
	P90        float64 `json:"p90"`
}

type gateStamp struct {
	Passed  bool         `json:"passed"`
	Reasons []gateReason `json:"reasons"`
}

type gateReason struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	FindingID string `json:"findingId,omitempty"`
}

// unitStamp is one paragraph-scope assessment: a range of the source, the score
// the engine gave it, and how many words it was judged on.
type unitStamp struct {
	ID      int     `json:"id"`
	Start   int     `json:"start"`
	End     int     `json:"end"`
	Words   int     `json:"words"`
	Score   float64 `json:"score"`
	Context string  `json:"context,omitempty"`
	// Origin is the experimental origin estimate, present only for a paragraph
	// the pack accepted. OriginStatus carries the reason when it is absent, so
	// the page can say why instead of leaving a blank.
	Origin       *float64 `json:"origin,omitempty"`
	OriginStatus string   `json:"originStatus,omitempty"`
}

// findingStub is one finding as the page marks it: where it is, what it says,
// and what it cost.
type findingStub struct {
	ID          string        `json:"id"`
	RuleID      string        `json:"ruleId"`
	RuleVersion string        `json:"ruleVersion"`
	Severity    string        `json:"severity"`
	Gate        string        `json:"gate"`
	Group       string        `json:"group"`
	Scope       string        `json:"scope"`
	Message     string        `json:"message"`
	Suggestion  string        `json:"suggestion,omitempty"`
	Context     string        `json:"context,omitempty"`
	Start       int           `json:"start"`
	End         int           `json:"end"`
	Line        int           `json:"line"`
	Column      int           `json:"column"`
	Segments    []span        `json:"segments"`
	Related     []relatedSpan `json:"related,omitempty"`
	Metric      *metric       `json:"metric,omitempty"`
	Points      float64       `json:"points"`
	Activation  int           `json:"activation"`
	Fingerprint string        `json:"fingerprint"`
	Suppressed  bool          `json:"suppressed"`
	UnitIDs     []int         `json:"unitIds"`
	Occurrences []string      `json:"-"`
}

type relatedSpan struct {
	Start    int    `json:"start"`
	End      int    `json:"end"`
	Segments []span `json:"segments"`
}

type span struct {
	Start int `json:"start"`
	End   int `json:"end"`
}

type metric struct {
	Name       string  `json:"name"`
	Value      float64 `json:"value"`
	Unit       string  `json:"unit"`
	Onset      float64 `json:"onset"`
	Saturation float64 `json:"saturation"`
}

// buildPayload projects one result into the page's shape and encodes it.
func buildPayload(
	ctx context.Context,
	engine *unswell.Engine,
	source document.Source,
	result unswell.Result,
	profile string,
	elapsed time.Duration,
) (string, error) {
	out := payload{
		Profile:    profile,
		Format:     string(source.Format),
		Name:       source.Name,
		DurationMs: elapsed.Milliseconds(),
		Engine: engineStamp{
			Version:        result.Manifest.ToolVersion,
			SchemaVersion:  result.SchemaVersion,
			ScoringProfile: result.Manifest.ScoringProfile,
			RulesetHash:    result.Manifest.RulesetHash,
			ConfigHash:     result.Manifest.ConfigHash,
			GateMode:       result.Manifest.GateMode,
		},
		Gate:       gateStamp{Passed: result.Gate.Passed, Reasons: []gateReason{}},
		Units:      []unitStamp{},
		Findings:   []findingStub{},
		Incomplete: result.Status != "complete",
	}
	for _, reason := range result.Gate.Reasons {
		out.Gate.Reasons = append(out.Gate.Reasons,
			gateReason{Code: reason.Code, Message: reason.Message, FindingID: reason.FindingID})
	}
	for _, failure := range result.Errors {
		out.Notes = append(out.Notes, failure.Message)
	}
	if len(result.Documents) > 0 {
		doc := result.Documents[0]
		out.Document = documentStamp{
			Bytes:      doc.Bytes,
			ProseWords: doc.ProseWords,
			Blocks:     doc.Blocks,
			Sentences:  doc.Sentences,
			Maximum:    doc.Maximum,
			Median:     doc.Median,
			P90:        doc.P90,
		}
		out.MaxIndex = doc.Maximum
	}

	contexts := blockContexts(ctx, engine, source)

	// Points come from the paragraph assessments, which is where the engine
	// applies its rule and group caps: the raw weight of a finding is not what
	// it contributed to the index the page prints beside it.
	points := map[string]float64{}
	units := map[string][]int{}
	for _, assessment := range result.Assessments {
		if assessment.Scope != "paragraph" {
			continue
		}
		out.Units = append(out.Units, unitStamp{
			ID:           assessment.UnitID,
			Start:        assessment.Span.Start,
			End:          assessment.Span.End,
			Words:        assessment.Words,
			Score:        assessment.EffectiveSlopScore,
			Context:      contextAt(contexts, assessment.Span),
			Origin:       assessment.OriginEstimate,
			OriginStatus: assessment.OriginStatus,
		})
		for _, contribution := range effectiveContributions(assessment) {
			points[contribution.FindingID] += contribution.Effective
			units[contribution.FindingID] = append(units[contribution.FindingID], assessment.UnitID)
		}
	}
	sort.Slice(out.Units, func(i, j int) bool { return out.Units[i].Start < out.Units[j].Start })

	for _, finding := range result.Findings {
		out.Findings = append(out.Findings, projectFinding(finding, contexts, points, units))
	}
	// Reading order. The engine sorts by rule and path for reproducibility; the
	// page numbers marks down the document, so the notes rail has to agree.
	sort.SliceStable(out.Findings, func(i, j int) bool {
		if out.Findings[i].Start != out.Findings[j].Start {
			return out.Findings[i].Start < out.Findings[j].Start
		}
		return out.Findings[i].End < out.Findings[j].End
	})

	encoded, err := json.Marshal(out)
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}

// effectiveContributions prefers the post-cap list when the engine produced
// one. EffectiveContributions is omitted when nothing was capped, and the plain
// Contributions are then already effective.
func effectiveContributions(assessment unswell.Assessment) []unswell.Contribution {
	if len(assessment.EffectiveContributions) > 0 {
		return assessment.EffectiveContributions
	}
	return assessment.Contributions
}

func projectFinding(
	finding unswell.Finding,
	contexts []blockContext,
	points map[string]float64,
	units map[string][]int,
) findingStub {
	stub := findingStub{
		ID:          finding.ID,
		RuleID:      finding.RuleID,
		RuleVersion: finding.RuleVersion,
		Severity:    finding.Severity,
		Gate:        finding.Gate,
		Group:       finding.Group,
		Scope:       finding.Scope,
		Message:     finding.Message,
		Suggestion:  finding.Evidence.Suggestion,
		Context:     contextAt(contexts, finding.Primary.Span),
		Start:       finding.Primary.Span.Start,
		End:         finding.Primary.Span.End,
		Line:        finding.Primary.Start.Line,
		Column:      finding.Primary.Start.Column,
		Segments:    []span{},
		Activation:  finding.Evidence.Activation,
		Points:      points[finding.ID],
		Fingerprint: finding.Fingerprint,
		Suppressed:  finding.Suppressed,
		UnitIDs:     units[finding.ID],
	}
	// Segments are the parts of the span that are actually source text: a
	// phrase match in Markdown skips the inline markup between its words, and
	// filling the whole span would highlight punctuation the rule never saw.
	for _, segment := range finding.Primary.Segments {
		stub.Segments = append(stub.Segments, span{Start: segment.Start, End: segment.End})
	}
	if len(stub.Segments) == 0 {
		stub.Segments = append(stub.Segments, span{Start: stub.Start, End: stub.End})
	}
	for _, related := range finding.Related {
		location := relatedSpan{Start: related.Span.Start, End: related.Span.End}
		for _, segment := range related.Segments {
			location.Segments = append(location.Segments, span{Start: segment.Start, End: segment.End})
		}
		stub.Related = append(stub.Related, location)
	}
	if len(finding.Evidence.Metrics) > 0 {
		first := finding.Evidence.Metrics[0]
		stub.Metric = &metric{
			Name:       first.Name,
			Value:      first.Value,
			Unit:       first.Unit,
			Onset:      first.Onset,
			Saturation: first.Saturation,
		}
	}
	if stub.UnitIDs == nil {
		stub.UnitIDs = []int{}
	}
	return stub
}

// blockContext is one extracted block and the scope labels the grammar gave it.
type blockContext struct {
	span    document.Span
	context string
}

// blockContexts recovers the grammar-derived context of every block.
//
// The engine does not put it on a Finding, and the page wants it: a note that
// says "in retry_with_backoff" or "in Installation" is placeable, and one that
// says only "warning" is not. So the same source is extracted a second time,
// under the policy this engine resolved for it, with structure requested.
//
// Blocks are matched to findings by SPAN rather than by block id. The engine's
// own extraction may have been run without structure, and nothing in the API
// promises that requesting structure leaves block numbering untouched; byte
// ranges are what both runs agree on by construction.
//
// A failure here costs context lines and nothing else, so it is swallowed: an
// analysis that succeeded must not be reported as failed because a decoration
// could not be computed.
func blockContexts(ctx context.Context, engine *unswell.Engine, source document.Source) []blockContext {
	policy, err := engine.ResolvedPolicy(source.Name)
	if err != nil {
		return nil
	}
	doc, err := extract.Parse(ctx, source, extract.Options{
		IncludeStructure: true,
		IncludeQuotes:    policy.Analysis.IncludeQuotes,
		MaxBytes:         policy.Analysis.MaxFileBytes,
		MaxBlocks:        policy.Analysis.MaxBlocks,
		Policy:           policy.Extraction,
	})
	if err != nil {
		return nil
	}
	contexts := make([]blockContext, 0, len(doc.Blocks))
	for _, block := range doc.Blocks {
		if len(block.Context) == 0 {
			continue
		}
		// The last label is the nearest enclosing scope. The whole trail is
		// available, and one label is what fits on the note's meta line.
		label := humanContext(block.Context[len(block.Context)-1])
		if label == "" {
			continue
		}
		contexts = append(contexts, blockContext{span: block.Span, context: label})
	}
	return contexts
}

// humanContext turns one extraction context label into something a reader
// recognizes.
//
// The labels are built for identity, not for display, and there are two shapes.
// Markdown headings are "heading-<level>:<canonical inline label>", where the
// label is the JSON encoding of the heading's inline nodes, because a heading
// containing a link or code has no single plain string. Source files use
// "<node kind>:<field>:<name>" with optional ":<qualifier>:<text>" pairs, so a
// Python function arrives as "function_definition:name:retry_with_backoff".
//
// Anything this does not recognize is returned unchanged. A label the page
// cannot pretty-print is still better than no label, and inventing a fallback
// that hides an upstream change would be worse than showing it.
func humanContext(label string) string {
	kind, rest, found := strings.Cut(label, ":")
	if !found {
		return label
	}
	switch {
	case strings.HasPrefix(kind, "heading-"):
		return canonicalLabelText(rest)
	case kind == "container":
		// "container:list_item" and "container:block_quote": the block has no
		// named owner, only a shape. That is not a place, so it is dropped
		// rather than printed as one.
		return ""
	}
	// The name is the second field; the qualifiers after it are a receiver or a
	// parameter list, which identify an overload and do not help a reader place
	// a sentence.
	if _, name, ok := strings.Cut(rest, ":"); ok {
		if cut, _, _ := strings.Cut(name, ":"); cut != "" {
			return cut
		}
	}
	if rest != "" {
		return rest
	}
	return label
}

// canonicalLabelText flattens a canonical inline label back to its text.
func canonicalLabelText(encoded string) string {
	var nodes []map[string]any
	if err := json.Unmarshal([]byte(encoded), &nodes); err != nil {
		return encoded
	}
	var text strings.Builder
	for _, node := range nodes {
		if value, ok := node["text"].(string); ok {
			text.WriteString(value)
		}
	}
	if text.Len() == 0 {
		return encoded
	}
	return strings.Join(strings.Fields(text.String()), " ")
}

// contextAt returns the context of the innermost block containing a span.
func contextAt(contexts []blockContext, target document.Span) string {
	best := ""
	width := 0
	for _, candidate := range contexts {
		if candidate.span.Start > target.Start || candidate.span.End < target.End {
			continue
		}
		size := candidate.span.End - candidate.span.Start
		if best == "" || size < width {
			best, width = candidate.context, size
		}
	}
	return best
}
