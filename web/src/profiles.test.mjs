// The wording about profiles is computed from the policy the engine announces.
// These tests give it a small made-up policy, so a change of the real profiles
// does not change them; test/contract.mjs checks the real announcement.
import assert from "node:assert/strict";
import test from "node:test";
import { describeProfile, describeReport, profileDifference, profileTag } from "./profiles.ts";

const policies = {
  technical: { enabled: ["a.one", "a.two", "b.three"], forbid: ["a.one"], paragraphFailAt: 65, sentenceFailAt: 80 },
  strict: {
    enabled: ["a.one", "a.two", "b.three", "c.four", "c.five"],
    forbid: ["a.one", "a.two", "c.five"],
    paragraphFailAt: 50,
    sentenceFailAt: 65,
  },
};
const finding = (ruleId, value) => (value === undefined ? { ruleId } : { ruleId, metric: { value } });

test("the difference names the rules a profile adds and the ones it makes fail the gate", () => {
  const more = profileDifference(policies, "strict");
  assert.deepEqual([...more.added], ["c.four", "c.five"]);
  // c.five fails the gate in strict too, but technical leaves it off: it is an added rule, counted once.
  assert.deepEqual([...more.stricter], ["a.two"]);
  assert.deepEqual(more.baseLimits, { paragraph: 65, sentence: 80 });
  assert.equal(profileDifference(policies, "technical"), null);
  assert.equal(profileDifference({}, "strict"), null);
  assert.equal(profileDifference(undefined, "strict"), null);
});

test("the line about a profile gives its counts, its limits, and the difference from the other one", () => {
  assert.equal(
    describeProfile(policies, "technical"),
    "technical: 3 rules, 1 of them fails the gate on one match. A paragraph fails at index 65, a sentence at 80. " +
      "strict adds 2 rules, makes 1 more fail the gate, and sets the limits to 50 and 65.",
  );
  assert.equal(
    describeProfile(policies, "strict"),
    "strict: 5 rules, 3 of them fail the gate on one match. A paragraph fails at index 50, a sentence at 65. " +
      "technical has 2 rules fewer, 1 fewer that fail the gate, and limits of 65 and 80.",
  );
  // A runtime from before the announcement says nothing, and the page says nothing.
  assert.equal(describeProfile(undefined, "strict"), "");
  assert.equal(describeProfile({}, "strict"), "");
});

test("a finding says when the base profile would not have reported it the same way", () => {
  const more = profileDifference(policies, "strict");
  assert.equal(profileTag(more, finding("c.four")), "only in strict");
  assert.equal(profileTag(more, finding("a.two")), "fails the gate only in strict");
  assert.equal(profileTag(more, finding("a.one")), "");
  assert.equal(profileTag(null, finding("c.four")), "");
  // A gate finding is only in strict while the index is under the limit of technical.
  assert.equal(profileTag(more, finding("gate.paragraph-score", 58.7)), "only in strict");
  assert.equal(profileTag(more, finding("gate.paragraph-score", 65)), "");
  assert.equal(profileTag(more, finding("gate.sentence-score", 79.9)), "only in strict");
  assert.equal(profileTag(more, finding("gate.sentence-score", 80)), "");
  assert.equal(profileTag(more, finding("gate.paragraph-score")), "");
});

test("a report says how many of its findings the base profile would not have made", () => {
  const more = profileDifference(policies, "strict");
  assert.equal(
    describeReport(more, [finding("a.one"), finding("c.four"), finding("gate.paragraph-score", 55)]),
    "2 of the 3 findings here are absent in technical.",
  );
  assert.equal(describeReport(more, [finding("a.one"), finding("c.four")]), "1 of the 2 findings here is absent in technical.");
  assert.equal(describeReport(more, [finding("a.one")]), "technical reports every finding shown here.");
  assert.equal(describeReport(more, []), "");
  assert.equal(describeReport(null, [finding("c.four")]), "");
});
