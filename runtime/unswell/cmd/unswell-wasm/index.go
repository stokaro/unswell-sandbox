//go:build js

package main

import (
	"bytes"
	"fmt"
	"strings"

	"github.com/stokaro/unswell"
	"github.com/stokaro/unswell/report"
)

// indexStamp is the engine's AI-sounding index of a Markdown page, as the page
// shows it. The number, the level, the counts and the marks are the engine's;
// the words beside them are the lines the CLI's own text report prints, so the
// page cannot describe a mark differently from `unswell check`.
//
// The index is the higher of two readings: the marks that people remove from a
// model's text, and the rhythm of the sentences. The engine lists the marks of
// a reading only when that reading is above the level low, and the stamp holds
// the marks it lists.
type indexStamp struct {
	// Status is "available", or the engine's reason for no index.
	Status string `json:"status"`
	Index  int    `json:"index"`
	Level  string `json:"level,omitempty"`
	// Marks and Rhythm are the two readings that the index is the higher of.
	MarksReading  int `json:"marksReading"`
	RhythmReading int `json:"rhythmReading"`
	Words         int `json:"words"`
	// Summary is the count of each kind of mark, cut from the CLI's index line:
	// "7 stock words." or "none of its marks."
	Summary string        `json:"summary,omitempty"`
	Signals []indexSignal `json:"signals"`
	// Marks holds the marks that the engine lists, at most its limit for one
	// page.
	Marks []indexMark `json:"marks"`
	// Counted is every mark of the listed readings, which can exceed len(Marks).
	Counted int `json:"counted"`
	// Fixable is how many listed marks carry a mechanical replacement.
	Fixable int `json:"fixable"`
	// FixableUnlisted is how many marks with a replacement are not listed
	// because their reading is at the level low. `unswell fix` leaves them
	// unless it is told to include such pages.
	FixableUnlisted int `json:"fixableUnlisted"`
	// Unlisted is the CLI's line about marks its report does not list, if any.
	Unlisted string `json:"unlisted,omitempty"`
	// Advice holds the CLI's lines below the marks: that `unswell fix` makes
	// the replacements, and that a run of sentences has none.
	Advice []string `json:"advice,omitempty"`
	// About is the CLI's sentence on what the index is and is not.
	About string `json:"about,omitempty"`
}

type indexSignal struct {
	Name    string `json:"name"`
	Reading string `json:"reading"`
	Count   int    `json:"count"`
	// Sentences is the number of sentences in the runs of a run signal.
	Sentences   int     `json:"sentences,omitempty"`
	PerThousand float64 `json:"perThousand"`
}

// indexMark is one counted mark: where it is, and the replacement that removes
// it when there is a mechanical one.
type indexMark struct {
	Signal string `json:"signal"`
	Start  int    `json:"start"`
	End    int    `json:"end"`
	Line   int    `json:"line"`
	Column int    `json:"column"`
	Word   string `json:"word,omitempty"`
	// Sentences is the length of a run of sentences, for a mark that is one.
	Sentences int `json:"sentences,omitempty"`
	// Note is what the CLI's report says at this mark, after the position:
	// `em dash; write a comma`. The CLI lists a bounded number of marks in one
	// run, and a mark past that bound has no note.
	Note string    `json:"note,omitempty"`
	Fix  *indexFix `json:"fix,omitempty"`
}

type indexFix struct {
	Start int    `json:"start"`
	End   int    `json:"end"`
	Text  string `json:"text"`
}

// The CLI's text report frames the index block with these two lines. They are
// matched as prefixes of whole lines; a pin that rewords them leaves the notes
// empty, and test/ai-sounding.mjs fails the build on that.
const (
	indexLinePrefix  = "AI-sounding index: "
	indexClosePrefix = "The index is the higher"
)

// projectIndex turns the engine's index into the page's shape. It returns nil
// for a document without one, which is every format but Markdown.
func projectIndex(result unswell.Result, cliText string) *indexStamp {
	if len(result.Documents) == 0 || result.Documents[0].AISounding == nil {
		return nil
	}
	doc := result.Documents[0]
	index := doc.AISounding
	listed, counted := index.Listed()
	stamp := &indexStamp{
		Status:        index.Status,
		Index:         index.Index,
		Level:         index.Level,
		MarksReading:  index.Reading(unswell.AIReadingMarks),
		RhythmReading: index.Reading(unswell.AIReadingRhythm),
		Words:         index.Words,
		Signals:       make([]indexSignal, 0, len(index.Signals)),
		Marks:         make([]indexMark, 0, len(listed)),
		Counted:       counted,
	}
	for _, signal := range index.Signals {
		stamp.Signals = append(stamp.Signals, indexSignal{Name: signal.Name, Reading: signal.Reading, Count: signal.Count,
			Sentences: signal.Sentences, PerThousand: signal.PerThousand})
	}
	for _, mark := range listed {
		projected := indexMark{
			Signal:    mark.Signal,
			Start:     mark.Span.Start,
			End:       mark.Span.End,
			Line:      mark.Start.Line,
			Column:    mark.Start.Column,
			Word:      mark.Word,
			Sentences: mark.Sentences,
		}
		if mark.Fix != nil {
			projected.Fix = &indexFix{Start: mark.Fix.Span.Start, End: mark.Fix.Span.End, Text: mark.Fix.Text}
			stamp.Fixable++
		}
		stamp.Marks = append(stamp.Marks, projected)
	}
	for _, mark := range index.Marks {
		if mark.Fix != nil {
			stamp.FixableUnlisted++
		}
	}
	stamp.FixableUnlisted -= stamp.Fixable
	block, about := indexBlock(cliText)
	stamp.About = about
	describeIndex(stamp, doc.Name, block)
	return stamp
}

// cliReport renders the completed result the way `unswell check` prints it.
// A failure costs the words beside the index and nothing else.
func cliReport(result unswell.Result) string {
	var text bytes.Buffer
	if err := report.Write(&text, "text", result, report.Options{}); err != nil {
		return ""
	}
	return text.String()
}

// indexBlock returns the lines of the text report that describe the index of
// the one page: its index line, its mark lines, and the lines after them up to
// the closing sentence. The closing sentence is returned beside them.
func indexBlock(cliText string) ([]string, string) {
	lines := strings.Split(cliText, "\n")
	for start, line := range lines {
		if !strings.HasPrefix(line, indexLinePrefix) {
			continue
		}
		for end := start + 1; end < len(lines); end++ {
			if strings.HasPrefix(lines[end], indexClosePrefix) {
				return lines[start:end], lines[end]
			}
		}
		return lines[start:], ""
	}
	return nil, ""
}

// describeIndex copies the CLI's words onto the stamp: the counts from the
// index line, one note for each mark the report lists, and the two lines the
// report adds below the list.
func describeIndex(stamp *indexStamp, name string, block []string) {
	if len(block) == 0 {
		return
	}
	if _, summary, found := strings.Cut(block[0], " in "+name+": "); found {
		stamp.Summary = summary
	}
	next := 1
	for position := range stamp.Marks {
		if next >= len(block) {
			break
		}
		mark := &stamp.Marks[position]
		prefix := fmt.Sprintf("  %s:%d:%d: ", name, mark.Line, mark.Column)
		if !strings.HasPrefix(block[next], prefix) {
			break
		}
		mark.Note = strings.TrimPrefix(block[next], prefix)
		next++
	}
	for _, line := range block[next:] {
		switch {
		case strings.HasPrefix(line, "  "):
			stamp.Unlisted = strings.TrimSpace(line)
		case strings.TrimSpace(line) != "":
			stamp.Advice = append(stamp.Advice, line)
		}
	}
}
