import assert from "node:assert/strict";
import test from "node:test";

import { SugangClient } from "../src/client.js";
import {
  parseSugangCourse,
  SugangOrderedEntryPass,
} from "../src/sugang-ordered-entry-pass.js";

test("course arguments use COURSE_CODE@SECTION and normalize case", () => {
  assert.deepEqual(parseSugangCourse("cose211@01"), {
    courseCode: "COSE211",
    section: "01",
    params: "COSE211@01",
  });
  assert.throws(() => parseSugangCourse("COSE211"), /COURSE_CODE@SECTION/);
  assert.throws(() => parseSugangCourse("A@01@extra"), /COURSE_CODE@SECTION/);
  assert.throws(() => new SugangOrderedEntryPass(["COSE211@01", "cose211@01"]), /Duplicate/);
});

test("registered course is dequeued and the next course keeps its order", () => {
  const courses = new SugangOrderedEntryPass(["COSE211@01", "MATH161@02", "STAT201@03"]);
  const transition = courses.record({
    kind: "registered",
    state: "ready",
    outcome: "registered",
    code: "200",
    message: "Registered",
    course: courses.current.course,
  });

  assert.equal(transition.action, "dequeued");
  assert.equal(transition.course.params, "COSE211@01");
  assert.equal(transition.nextCourse.params, "MATH161@02");
  assert.equal(transition.remaining, 2);
  assert.deepEqual(courses.remaining.map(({ course }) => course.params), ["MATH161@02", "STAT201@03"]);
  assert.equal(courses.complete, false);
});

test("full courses are dequeued immediately", () => {
  const courses = new SugangOrderedEntryPass(["COSE211@01", "MATH161@02"]);

  const first = courses.record({
    kind: "full",
    code: "501",
    state: "ready",
    outcome: "rejected",
    message: "Full",
    course: courses.current.course,
  });
  assert.deepEqual(
    { action: first.action, reason: first.reason, next: first.nextCourse.params },
    { action: "dequeued", reason: "full", next: "MATH161@02" },
  );
  assert.equal(first.remaining, 1);

  const second = courses.record({
    kind: "full",
    code: "501",
    state: "ready",
    outcome: "rejected",
    message: "Full",
    course: courses.current.course,
  });
  assert.deepEqual(
    { action: second.action, reason: second.reason, next: second.nextCourse },
    { action: "dequeued", reason: "full", next: null },
  );
  assert.equal(second.remaining, 0);
  assert.deepEqual(courses.remaining, []);
  assert.equal(courses.complete, true);
});

test("macro and expired session results hold the current course", () => {
  const courses = new SugangOrderedEntryPass(["COSE211@01", "MATH161@02"]);

  assert.deepEqual(courses.record({
    kind: "macro_required",
    code: "118",
    state: "macro_required",
    course: courses.current.course,
  }), {
    action: "held",
    reason: "macro_required",
    course: courses.current.course,
    nextCourse: courses.current.course,
    remaining: 2,
  });
  assert.equal(courses.current.course.params, "COSE211@01");
  assert.equal(courses.current.disposition, "macro_required");
  assert.equal(courses.complete, false);

  assert.equal(courses.record({
    kind: "session_expired",
    code: "999",
    state: "expired",
  }).reason, "session_expired");
  assert.equal(courses.current.course.params, "COSE211@01");
  assert.equal(courses.current.disposition, "session_expired");
  assert.equal(courses.complete, false);
});

test("ordinary rejection holds the current course for an immediate retry", () => {
  const courses = new SugangOrderedEntryPass(["COSE211@01", "MATH161@02"]);
  const transition = courses.record({
    kind: "rejected",
    code: "500",
    state: "ready",
    outcome: "rejected",
    message: "Ineligible",
    course: courses.current.course,
  });
  assert.equal(transition.action, "retry");
  assert.equal(transition.reason, "rejected");
  assert.equal(transition.nextCourse.params, "COSE211@01");
  assert.equal(courses.current.lastResult.message, "Ineligible");
  assert.equal(courses.complete, false);
});

test("result cannot advance a different current course", () => {
  const courses = new SugangOrderedEntryPass(["COSE211@01", "MATH161@02"]);
  assert.throws(
    () => courses.record({
      kind: "registered",
      code: "200",
      state: "ready",
      outcome: "registered",
      course: parseSugangCourse("MATH161@02"),
    }),
    /does not match current course/,
  );
  assert.equal(courses.current.attempts, 0);
});

test("client and list share one canonical course identity", () => {
  const client = new SugangClient({ course: { courseCode: "cose211", section: "ab" } });
  const courses = new SugangOrderedEntryPass(["COSE211@AB"]);
  assert.deepEqual(client.course, courses.current.course);
  assert.equal(courses.record({
    kind: "registered",
    code: "200",
    state: "ready",
    outcome: "registered",
    course: client.course,
  }).action, "dequeued");
});

test("malformed results never mutate or advance the list", () => {
  const courses = new SugangOrderedEntryPass(["COSE211@01", "MATH161@02"]);
  const invalidResults = [
    {},
    { code: "200", outcome: "registered" },
    { code: "200", outcome: "rejected", course: courses.current.course },
    { code: "501", outcome: "registered", course: courses.current.course },
    { code: "118", state: "expired", course: courses.current.course },
    {
      code: "200",
      state: "expired",
      outcome: "registered",
      course: courses.current.course,
    },
    {
      code: "501",
      state: "macro_required",
      outcome: "rejected",
      course: courses.current.course,
    },
    {
      code: "118",
      state: "macro_required",
      outcome: "registered",
      course: courses.current.course,
    },
    { code: "999", state: "expired", outcome: "registered" },
  ];
  for (const result of invalidResults) {
    assert.throws(() => courses.record(result), /semantic course result kind|identify/);
    assert.equal(courses.current.course.params, "COSE211@01");
    assert.equal(courses.current.attempts, 0);
    assert.equal(courses.current.lastResult, null);
  }
});

test("CAPTCHA exhaustion is retained as a completed pass disposition", () => {
  const courses = new SugangOrderedEntryPass(["COSE211@01"]);
  const transition = courses.record({
    kind: "captcha_exhausted",
    code: "500",
    message: "Wrong answer",
    course: courses.current.course,
  });

  assert.equal(transition.reason, "captcha_exhausted");
  assert.equal(courses.current.disposition, "captcha_exhausted");
  assert.equal(courses.complete, true);
});
