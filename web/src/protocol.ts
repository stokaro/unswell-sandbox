/**
 * The message protocol between the page and the Worker, and the shape of the
 * engine's answer.
 *
 * Everything below the `Report` boundary is written by Go, in
 * runtime/unswell/cmd/unswell-wasm/payload.go. The two files are one contract:
 * a field renamed on one side and not the other is a silent `undefined` in the
 * rail, so they are edited together or not at all.
 */

/** One rule, as the build stamped it into the manifest and as ready() repeats it. */
export interface RuleInfo {
  id: string;
  version: string;
  group: string;
  severity: string;
  summary: string;
}

/** What one profile does with the catalog, by rule identifier in catalog order. */
export interface ProfilePolicy {
  /** The rules the profile runs. */
  enabled: string[];
  /** The rules among them whose match fails the gate on its own. */
  forbid: string[];
  /** The index at which a paragraph fails the gate. */
  paragraphFailAt: number;
  /** The index at which a sentence fails the gate. */
  sentenceFailAt: number;
}

/** What the runtime announces once, before it accepts any analysis. */
export interface ReadyInfo {
  /** The submodule tag this binary was built from, such as v0.1.0-alpha.3. */
  version: string;
  commit: string;
  commitDate: string;
  goVersion: string;
  /** The release identity the engine reports for itself. */
  engineTag: string;
  schema: string;
  rules: RuleInfo[];
  profiles: string[];
  /** What each profile runs, keyed by its name. */
  policies: Record<string, ProfilePolicy>;
  formats: string[];
  defaultName: string;
}

export interface Span {
  start: number;
  end: number;
}

export interface Metric {
  name: string;
  value: number;
  unit: string;
  onset: number;
  saturation: number;
}

/** One finding, as the page marks it and as the rail describes it. */
export interface Finding {
  id: string;
  ruleId: string;
  ruleVersion: string;
  severity: string;
  gate: string;
  group: string;
  scope: string;
  message: string;
  suggestion?: string;
  /** Heading trail in Markdown, enclosing function or class in Python. */
  context?: string;
  start: number;
  end: number;
  line: number;
  column: number;
  /** The parts of the span that are source text; markup between them is not. */
  segments: Span[];
  related?: (Span & { segments?: Span[] })[];
  metric?: Metric;
  /** What this finding contributed to the paragraph index, after caps. */
  points: number;
  activation: number;
  fingerprint: string;
  suppressed: boolean;
  unitIds: number[];
}

/**
 * One paragraph-scope assessment.
 *
 * These are the ranges the page segments the document by. In a source file they
 * are also the only ranges the engine looked at, so everything between them is
 * code and is dimmed.
 */
export interface Unit {
  id: number;
  start: number;
  end: number;
  words: number;
  score: number;
  context?: string;
  /**
   * The experimental origin estimate, present only for a paragraph the shipped
   * pack accepted. `originStatus` carries the reason when it is absent, which
   * is most paragraphs: the pack was fitted between 25 and 89 words and
   * abstains outside that.
   */
  origin?: number;
  originStatus?: string;
}

/** One counted signal of the AI-sounding index. */
export interface IndexSignal {
  name: string;
  /** The reading the signal belongs to: "marks" or "rhythm". */
  reading: string;
  count: number;
  /** The sentences in the runs of a run signal. */
  sentences?: number;
  perThousand: number;
}

/**
 * One counted mark of the AI-sounding index.
 *
 * `note` is what the CLI's own report prints at this mark after the position,
 * such as `em dash; write a comma`. The CLI lists a bounded number of marks in
 * one run, so a mark past that bound has no note. `fix` is the replacement
 * `unswell fix` makes; a stock word has none.
 */
export interface IndexMark {
  signal: string;
  start: number;
  end: number;
  line: number;
  column: number;
  word?: string;
  /** The length of a run of sentences, for a mark that is one. */
  sentences?: number;
  note?: string;
  fix?: Span & { text: string };
}

/**
 * The engine's AI-sounding index of a Markdown or MDX page.
 *
 * The number, the level, the counts and the marks are the engine's. The words
 * (`summary`, each mark's `note`, `unlisted`, `advice`, `about`) are lines of
 * the CLI's text report for the same result.
 *
 * The index is the higher of two readings: the marks that people remove from
 * a model's text, and the rhythm of the sentences. The engine lists the marks
 * of a reading only when that reading is above the level low, and `marks`
 * holds the marks it lists.
 */
export interface AISounding {
  /** "available", or the engine's reason for no index, such as "too_short". */
  status: string;
  index: number;
  level?: "low" | "elevated" | "high";
  marksReading: number;
  rhythmReading: number;
  words: number;
  summary?: string;
  signals: IndexSignal[];
  marks: IndexMark[];
  /** Every mark of the listed readings. `marks` holds at most the engine's limit. */
  counted: number;
  /** How many listed marks carry a mechanical replacement. */
  fixable: number;
  /** Marks with a replacement that are not listed, because their reading is low. */
  fixableUnlisted: number;
  unlisted?: string;
  /** The CLI's lines below the marks: what a command can replace, and what it cannot. */
  advice?: string[];
  about?: string;
}

/** The answer to a fix: the text after the replacements `unswell fix` makes. */
export interface FixResult {
  kind: "fix";
  name: string;
  durationMs: number;
  text: string;
  changed: boolean;
  indexed: boolean;
  leftLow: boolean;
  before: number;
  after: number;
  removed: Record<string, number>;
  left: Record<string, number>;
  /** The line `unswell fix` prints for the page, without its path. */
  summary: string;
  /** The sentence `unswell fix` closes its report with. */
  caution: string;
}

export interface Report {
  kind: "report";
  profile: string;
  format: string;
  name: string;
  durationMs: number;
  engine: {
    version: string;
    schemaVersion: string;
    scoringProfile: string;
    rulesetHash: string;
    configHash: string;
    gateMode: string;
  };
  document: {
    bytes: number;
    proseWords: number;
    blocks: number;
    sentences: number;
    maximum: number;
    median: number;
    p90: number;
  };
  gate: {
    passed: boolean;
    reasons: { code: string; message: string; findingId?: string }[];
  };
  maxIndex: number;
  units: Unit[];
  findings: Finding[];
  /**
   * The state of the experimental origin channel for this run. A run where no
   * paragraph carries an estimate is not the same as a run where every
   * paragraph scored zero, and the page says which it was.
   */
  origin?: {
    available: boolean;
    status?: string;
    reason?: string;
  };
  /** Absent for every format but Markdown: the engine measures none there. */
  aiSounding?: AISounding;
  incomplete: boolean;
  notes?: string[];
}

export type WorkerRequest =
  /** Boot the runtime. `base` is the URL every vendored asset resolves against. */
  | { type: "init"; base: string }
  | { type: "analyze"; runId: number; text: string; profile: string; format: string }
  | { type: "fix"; runId: number; text: string; profile: string; format: string; includeLow: boolean }
  | { type: "cancel"; runId: number };

/**
 * Where the boot has got to. The phases are real work, in order, and
 * `downloading` carries real byte counts. There is no invented percentage.
 */
export type BootPhase = "fetching" | "downloading" | "compiling" | "starting";

export type HostEvent =
  | { type: "ready"; info: ReadyInfo; bootMs: number }
  /**
   * loaded/total are UNCOMPRESSED bytes. Content-Length would be the encoded
   * length on a gzipped response while response.body yields decoded bytes, so
   * the denominator is the size the manifest publishes for this exact build.
   */
  | { type: "progress"; phase: BootPhase; loaded: number; total: number }
  | { type: "report"; runId: number; report: Report }
  | { type: "fixed"; runId: number; fix: FixResult }
  | { type: "failed"; runId: number; message: string }
  /** Go's runtime panic path, and anything else that outlives a single run. */
  | { type: "panic"; message: string }
  /** The runtime never became usable. Nothing will work; the page says so. */
  | { type: "fatal"; message: string };
