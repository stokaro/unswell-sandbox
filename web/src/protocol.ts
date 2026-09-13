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
  related?: Span[];
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
}

export interface Report {
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
  incomplete: boolean;
  notes?: string[];
}

export type WorkerRequest =
  /** Boot the runtime. `base` is the URL every vendored asset resolves against. */
  | { type: "init"; base: string }
  | { type: "analyze"; runId: number; text: string; profile: string; format: string }
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
  | { type: "failed"; runId: number; message: string }
  /** Go's runtime panic path, and anything else that outlives a single run. */
  | { type: "panic"; message: string }
  /** The runtime never became usable. Nothing will work; the page says so. */
  | { type: "fatal"; message: string };
