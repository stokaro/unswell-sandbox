//go:build js

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/stokaro/unswell"
	"github.com/stokaro/unswell/document"
)

// maxFixPasses bounds the analyses of one fix, as the CLI's fix command does.
// One analysis lists a bounded number of marks, and a fix can leave out a mark
// that it overlaps.
const maxFixPasses = 8

// fixPayload is the answer to one fix: the text after the replacements, and
// what the command would report about it.
//
// The replacements are the engine's own: every mark of the index carries its
// fix, and unswell.RemoveAIMarks applies them. What this file adds is the loop
// around that call, which lives in the CLI's command package and is not part
// of the public API. It follows `unswell fix` step by step, and
// test/ai-sounding.mjs compares its text and its summary line with what the
// published binary wrote for the same page.
type fixPayload struct {
	Kind       string `json:"kind"`
	Name       string `json:"name"`
	DurationMs int64  `json:"durationMs"`
	// Text is the page after the last pass. It equals the input when nothing
	// was replaced.
	Text    string `json:"text"`
	Changed bool   `json:"changed"`
	// Indexed is false for a page without an index: another format, or fewer
	// prose words than the index covers.
	Indexed bool `json:"indexed"`
	// LeftLow says the page is at the level low and was left as it is.
	LeftLow bool           `json:"leftLow"`
	Before  int            `json:"before"`
	After   int            `json:"after"`
	Removed map[string]int `json:"removed"`
	Left    map[string]int `json:"left"`
	// Summary is the line `unswell fix` prints for the page, without its path.
	Summary string `json:"summary"`
	// Caution is the sentence `unswell fix` closes its report with.
	Caution string `json:"caution"`
}

// fixCaution is the last line of the report of `unswell fix`.
const fixCaution = "A replacement is mechanical. Read each one: a comma or a period is not always what the sentence needs, " +
	"and a stock word needs your own words."

// fixPage analyzes the page, applies the fixes of its marks, and analyzes the
// result again until no fix is left. A page that starts at the level low is
// left as it is unless includeLow is set: the check lists no marks there. Low
// is the level of the first reading, whose marks have a replacement.
func fixPage(ctx context.Context, engine *unswell.Engine, source document.Source, includeLow bool) (fixPayload, error) {
	started := time.Now()
	out := fixPayload{Kind: "fix", Name: source.Name, Removed: map[string]int{}, Left: map[string]int{}, Caution: fixCaution}
	current := source
	for pass := 0; ; pass++ {
		index, err := pageIndex(ctx, engine, current)
		if err != nil {
			return out, err
		}
		if index == nil {
			// A fix can take a short page below the words that the index needs.
			break
		}
		if pass == 0 {
			out.Indexed, out.Before = true, index.Index
			// The check lists the marks of a reading that is above the low
			// level, and the marks with a replacement are the first reading's.
			out.LeftLow = unswell.AILevel(index.Reading(unswell.AIReadingMarks)) == unswell.AISoundingLow && !includeLow
		}
		out.After = index.Index
		if out.LeftLow {
			break
		}
		revised, applied := unswell.RemoveAIMarks(current.Bytes, index.Marks)
		if applied == 0 || pass == maxFixPasses {
			out.Left = markCounts(leftMarks(index, includeLow), false)
			break
		}
		for name, count := range markCounts(index.Marks, true) {
			out.Removed[name] += count
		}
		current.Bytes = revised
	}
	out.Text = string(current.Bytes)
	out.Changed = total(out.Removed) > 0
	out.Summary = fixSummary(out)
	out.DurationMs = time.Since(started).Milliseconds()
	return out, nil
}

// leftMarks returns the marks that stay for a person: the marks that the check
// lists, and with includeLow the marks of a reading at the low level too.
func leftMarks(index *unswell.AISounding, includeLow bool) []unswell.AIMark {
	if includeLow {
		return index.Marks
	}
	listed, _ := index.Listed()
	return listed
}

// pageIndex returns the index of one page, or nil when it has none.
func pageIndex(ctx context.Context, engine *unswell.Engine, source document.Source) (*unswell.AISounding, error) {
	analysis, err := engine.Analyze(ctx, source)
	if err != nil {
		return nil, err
	}
	if len(analysis.Documents) == 0 || analysis.Documents[0].AISounding == nil ||
		analysis.Documents[0].AISounding.Status != "available" {
		return nil, nil
	}
	return analysis.Documents[0].AISounding, nil
}

// markCounts counts the marks with a fix, or the marks without one, by signal.
func markCounts(marks []unswell.AIMark, fixable bool) map[string]int {
	counts := map[string]int{}
	for _, mark := range marks {
		if (mark.Fix != nil) == fixable {
			counts[mark.Signal]++
		}
	}
	return counts
}

func total(counts map[string]int) int {
	sum := 0
	for _, count := range counts {
		sum += count
	}
	return sum
}

// fixSignalNames gives the singular and the plural that `unswell fix` prints
// for each signal, in the order of its report.
var fixSignalNames = [][3]string{
	{"em-dash", "em dash", "em dashes"},
	{"emoji-in-heading", "emoji in a heading", "emoji in headings"},
	{"emoji-at-list-item", "emoji at the start of a list item", "emoji at the start of list items"},
	{"arrow", "arrow", "arrows"},
	{"stock-word", "stock word", "stock words"},
	{"bold-label-in-list", "bold label", "bold labels"},
	{"plain-sentence-run", "run of plain sentences", "runs of plain sentences"},
	{"subject-opener-run", "run of sentences that open with their subject", "runs of sentences that open with their subject"},
}

// markText lists counted marks by signal, such as "3 em dashes, 1 arrow".
func markText(counts map[string]int) string {
	var parts []string
	for _, name := range fixSignalNames {
		switch count := counts[name[0]]; {
		case count == 1:
			parts = append(parts, "1 "+name[1])
		case count > 1:
			parts = append(parts, fmt.Sprintf("%d %s", count, name[2]))
		}
	}
	return strings.Join(parts, ", ")
}

// fixSummary is the line `unswell fix` prints for one page, without the path
// in front, and what its progress line says for a page it does not change.
func fixSummary(out fixPayload) string {
	switch {
	case !out.Indexed:
		return "No index: not a Markdown page of 150 prose words or more."
	case out.LeftLow:
		return fmt.Sprintf("AI-sounding index %d, marks low: left as it is.", out.Before)
	case out.Changed:
		line := fmt.Sprintf("AI-sounding index %d -> %d; removed %s.", out.Before, out.After, markText(out.Removed))
		if left := markText(out.Left); left != "" {
			line += fmt.Sprintf(" Left for you: %s.", left)
		}
		return line
	case total(out.Left) > 0:
		return fmt.Sprintf("AI-sounding index %d; nothing to replace. Left for you: %s.", out.Before, markText(out.Left))
	}
	return fmt.Sprintf("AI-sounding index %d; nothing to replace.", out.Before)
}

func (out fixPayload) encode() (string, error) {
	encoded, err := json.Marshal(out)
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}
