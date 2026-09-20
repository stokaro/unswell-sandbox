//go:build js

package main

import (
	"context"
	"sort"

	"github.com/stokaro/unswell/document"
)

// originEstimate is one paragraph's answer from the origin channel: a value
// when the pack accepted the paragraph, and the reason it did not otherwise.
type originEstimate struct {
	value  *float64
	status string
}

// originChannelStamp is what the page says about the channel as a whole. The
// page needs the difference between "the model estimated a low number" and
// "the model could not run at all", and a blank badge says neither.
type originChannelStamp struct {
	Available bool   `json:"available"`
	Status    string `json:"status,omitempty"`
	Reason    string `json:"reason,omitempty"`
}

// collectOrigins runs the origin engine over the same source and returns its
// estimates by span. The origin engine disables the rules that require
// document structure, so the text reaches the pack prepared the way the pack
// was fitted; see originOverrides.
//
// Nothing else of that run is used. Its findings, its index and its gate are
// discarded: the page prints the findings of the profile the visitor chose,
// and a second rule set must not change them.
func collectOrigins(ctx context.Context, engines *engineSet, profile string,
	source document.Source,
) (map[document.Span]originEstimate, originChannelStamp) {
	engine, err := engines.originEngine(profile)
	if err != nil {
		return nil, originChannelStamp{Status: "engine_unavailable", Reason: originReason("engine_unavailable")}
	}
	result, err := engine.Analyze(ctx, source)
	if err != nil {
		// A failed second run is not a failed analysis. The page keeps the
		// findings it already has and says the estimate is missing.
		return nil, originChannelStamp{Status: "run_failed", Reason: originReason("run_failed")}
	}

	estimates := map[document.Span]originEstimate{}
	counts := map[string]int{}
	available := false
	for _, assessment := range result.Assessments {
		if assessment.Scope != "paragraph" {
			continue
		}
		estimates[assessment.Span] = originEstimate{value: assessment.OriginEstimate, status: assessment.OriginStatus}
		if assessment.OriginEstimate != nil {
			available = true
			continue
		}
		if assessment.OriginStatus != "" {
			counts[assessment.OriginStatus]++
		}
	}
	if available {
		return estimates, originChannelStamp{Available: true, Status: "available"}
	}
	status := dominantStatus(counts)
	if status == "" {
		status = "no_prose"
	}
	return estimates, originChannelStamp{Status: status, Reason: originReason(status)}
}

// dominantStatus names the reason that covers most paragraphs, with ties
// broken by name so the page does not change its wording between identical
// runs.
func dominantStatus(counts map[string]int) string {
	names := make([]string, 0, len(counts))
	for name := range counts {
		names = append(names, name)
	}
	sort.Strings(names)
	best := ""
	for _, name := range names {
		if best == "" || counts[name] > counts[best] {
			best = name
		}
	}
	return best
}

// originReason puts an engine status into the words a visitor can act on. An
// unknown status is passed through rather than hidden, because a status this
// build has never seen is exactly the case where the raw name helps.
func originReason(status string) string {
	switch status {
	case "incompatible_model":
		return "The shipped model was fitted on text prepared differently from this build, " +
			"so the engine refuses it rather than reporting numbers it cannot stand behind."
	case "unsupported_unit":
		return "No paragraph fell in the 25 to 89 word band the model was fitted on."
	case "insufficient_evidence":
		return "The model found too little of its vocabulary in this text to estimate."
	case "engine_unavailable":
		return "This build could not construct the engine that runs the origin channel."
	case "run_failed":
		return "The origin channel did not finish for this text."
	case "no_prose":
		return "This text has no paragraph the origin channel measures."
	default:
		return "The origin channel reported " + status + "."
	}
}
