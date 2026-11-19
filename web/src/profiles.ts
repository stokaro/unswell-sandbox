/**
 * What a profile runs, said in words.
 *
 * Two profiles can return reports that look alike at a glance: the same gate
 * line, the same index. The counts and limits here come from the policy the
 * engine holds for each profile, which ready() announces, so the page keeps no
 * list of its own.
 */

import type { Finding, ProfilePolicy } from "./protocol.ts";

/** The profile every other one is compared with. */
export const BASE_PROFILE = "technical";

/** What a profile does beyond the base one. */
export interface ProfileDifference {
  /** The profile this describes. */
  profile: string;
  /** Rules the profile runs and the base profile leaves off. */
  added: Set<string>;
  /** Rules whose match fails the gate in the profile and only warns in the base one. */
  stricter: Set<string>;
  /** The index at which a paragraph and a sentence fail the gate in the base profile. */
  baseLimits: { paragraph: number; sentence: number };
}

/**
 * Compares a profile with the base one. The answer is null for the base
 * profile itself and when the runtime announced no policy for either.
 */
export function profileDifference(
  policies: Record<string, ProfilePolicy> | undefined,
  profile: string,
): ProfileDifference | null {
  const base = policies?.[BASE_PROFILE];
  const selected = policies?.[profile];
  if (!base || !selected || profile === BASE_PROFILE) return null;
  const baseEnabled = new Set(base.enabled);
  const baseForbid = new Set(base.forbid);
  return {
    profile,
    added: new Set(selected.enabled.filter((id) => !baseEnabled.has(id))),
    // A rule the base profile leaves off is counted once, as an added rule.
    stricter: new Set(selected.forbid.filter((id) => baseEnabled.has(id) && !baseForbid.has(id))),
    baseLimits: { paragraph: base.paragraphFailAt, sentence: base.sentenceFailAt },
  };
}

function rules(count: number): string {
  return `${count} rule${count === 1 ? "" : "s"}`;
}

/** The counts and limits of one profile, in one sentence pair. */
function own(profile: string, policy: ProfilePolicy): string {
  const fails = policy.forbid.length === 1 ? "fails" : "fail";
  return `${profile}: ${rules(policy.enabled.length)}, ${policy.forbid.length} of them ${fails} the gate on one match. ` +
    `A paragraph fails at index ${policy.paragraphFailAt}, a sentence at ${policy.sentenceFailAt}.`;
}

/**
 * A few short sentences about the selected profile: how many rules it runs,
 * how many of them fail the gate on one match, where the index limits are,
 * and how the other profile differs.
 */
export function describeProfile(policies: Record<string, ProfilePolicy> | undefined, profile: string): string {
  const selected = policies?.[profile];
  if (!selected) return "";
  const head = own(profile, selected);
  if (profile !== BASE_PROFILE) {
    const more = profileDifference(policies, profile);
    if (!more) return head;
    return `${head} ${BASE_PROFILE} has ${rules(more.added.size)} fewer, ${more.stricter.size} fewer that fail the gate, ` +
      `and limits of ${more.baseLimits.paragraph} and ${more.baseLimits.sentence}.`;
  }
  const others = Object.keys(policies ?? {})
    .map((name) => profileDifference(policies, name))
    .filter((more): more is ProfileDifference => more !== null)
    .map((more) => {
      const other = policies![more.profile];
      return `${more.profile} adds ${rules(more.added.size)}, makes ${more.stricter.size} more fail the gate, ` +
        `and sets the limits to ${other.paragraphFailAt} and ${other.sentenceFailAt}.`;
    });
  return [head, ...others].join(" ");
}

/**
 * Reports whether a finding is one that the base profile would not have made:
 * its rule is off there, or it is a gate finding for an index under the base
 * limit.
 */
function onlyHere(more: ProfileDifference, finding: Finding): boolean {
  if (more.added.has(finding.ruleId)) return true;
  const value = finding.metric?.value;
  if (value === undefined) return false;
  if (finding.ruleId === "gate.paragraph-score") return value < more.baseLimits.paragraph;
  if (finding.ruleId === "gate.sentence-score") return value < more.baseLimits.sentence;
  return false;
}

/** What the difference says about one finding, or "" when it says nothing. */
export function profileTag(more: ProfileDifference | null, finding: Finding): string {
  if (!more) return "";
  if (onlyHere(more, finding)) return `only in ${more.profile}`;
  if (more.stricter.has(finding.ruleId)) return `fails the gate only in ${more.profile}`;
  return "";
}

/** How many findings of a report the base profile would not have made. */
export function describeReport(more: ProfileDifference | null, findings: Finding[]): string {
  if (!more || findings.length === 0) return "";
  const extra = findings.filter((finding) => onlyHere(more, finding)).length;
  if (extra === 0) return `${BASE_PROFILE} reports every finding shown here.`;
  return `${extra} of the ${findings.length} findings here ${extra === 1 ? "is" : "are"} absent in ${BASE_PROFILE}.`;
}
