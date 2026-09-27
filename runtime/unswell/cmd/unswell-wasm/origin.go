//go:build js

package main

import (
	"sort"

	"github.com/stokaro/unswell"
)

// originChannelStamp is what the page says about the channel as a whole. The
// page needs the difference between "the model estimated a low number" and
// "the model could not run at all", and a blank badge says neither.
type originChannelStamp struct {
	Available bool   `json:"available"`
	Status    string `json:"status,omitempty"`
	Reason    string `json:"reason,omitempty"`
}

// summarizeOrigin describes the channel already present in the completed result.
// Core prepares each model's features using that pack's recorded contract, so
// the playground does not need a second analysis with structural rules disabled.
func summarizeOrigin(result unswell.Result) originChannelStamp {
	counts := map[string]int{}
	available := false
	for _, assessment := range result.Assessments {
		if assessment.Scope != "paragraph" {
			continue
		}
		if assessment.OriginEstimate != nil {
			available = true
			continue
		}
		if assessment.OriginStatus != "" {
			counts[assessment.OriginStatus]++
		}
	}
	if available {
		return originChannelStamp{Available: true, Status: "available"}
	}
	status := dominantStatus(counts)
	if status == "" {
		status = "no_prose"
	}
	return originChannelStamp{Status: status, Reason: originReason(status)}
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
