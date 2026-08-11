import { normalizeSugangCourse, parseSugangCourse } from "./sugang-course.js";

export { parseSugangCourse } from "./sugang-course.js";

const RESULT_KINDS = new Set([
  "registered",
  "full",
  "rejected",
  "macro_required",
  "captcha_exhausted",
  "session_expired",
]);

function courseFrom(value) {
  return typeof value === "string" ? parseSugangCourse(value) : normalizeSugangCourse(value);
}

function summarizeResult(result) {
  return Object.freeze({
    kind: result.kind,
    code: String(result.code ?? ""),
    message: result.message ?? "",
    sessionRenewed: result.sessionRenewed === true,
  });
}

function publicEntry(entry) {
  return Object.freeze({
    course: entry.course,
    attempts: entry.attempts,
    disposition: entry.disposition,
    lastResult: entry.lastResult,
  });
}

export class SugangOrderedEntryPass {
  #entries;
  #cursor = 0;

  constructor(courses) {
    if (!Array.isArray(courses) || courses.length === 0) {
      throw new Error("SugangOrderedEntryPass requires at least one course");
    }
    const seen = new Set();
    this.#entries = courses.map((value) => {
      const course = courseFrom(value);
      if (seen.has(course.params)) throw new Error(`Duplicate course ${course.params}`);
      seen.add(course.params);
      return { course, attempts: 0, disposition: "pending", lastResult: null };
    });
  }

  get empty() {
    return this.#entries.length === 0;
  }

  get complete() {
    return this.empty || this.#entries.every(
      ({ disposition }) => disposition === "captcha_exhausted",
    );
  }

  get current() {
    return this.empty ? null : publicEntry(this.#entries[this.#cursor]);
  }

  get remaining() {
    if (this.empty) return Object.freeze([]);
    return Object.freeze([
      ...this.#entries.slice(this.#cursor),
      ...this.#entries.slice(0, this.#cursor),
    ].map(publicEntry));
  }

  record(result) {
    if (this.empty) throw new Error("Cannot record a course result after the pass is complete");
    if (!result || typeof result !== "object" || !RESULT_KINDS.has(result.kind)) {
      throw new Error("A semantic course result kind is required");
    }

    const entry = this.#entries[this.#cursor];
    const summary = summarizeResult(result);
    let resultCourse = null;
    if (result.course !== undefined && result.course !== null) {
      resultCourse = normalizeSugangCourse(result.course);
    } else if (summary.kind !== "session_expired") {
      throw new Error("Course-scoped result must identify its course");
    }
    if (resultCourse && resultCourse.params !== entry.course.params) {
      throw new Error(
        `Result for ${resultCourse.params} does not match current course ${entry.course.params}`,
      );
    }

    entry.attempts += 1;
    entry.lastResult = summary;

    if (["registered", "full"].includes(summary.kind)) {
      const completed = entry.course;
      this.#entries.splice(this.#cursor, 1);
      if (!this.empty && this.#cursor === this.#entries.length) this.#cursor = 0;
      return Object.freeze({
        action: "dequeued",
        reason: summary.kind === "full" ? "full" : undefined,
        course: completed,
        nextCourse: this.current?.course ?? null,
        remaining: this.#entries.length,
      });
    }

    if (["macro_required", "session_expired"].includes(summary.kind)) {
      entry.disposition = summary.kind;
      return this.#heldTransition(entry.course, summary.kind);
    }

    entry.disposition = summary.kind;
    const attempted = entry.course;
    if (summary.kind === "rejected") {
      return Object.freeze({
        action: "retry",
        reason: entry.disposition,
        course: attempted,
        nextCourse: attempted,
        remaining: this.#entries.length,
      });
    }
    this.#cursor = (this.#cursor + 1) % this.#entries.length;
    return Object.freeze({
      action: "advanced",
      reason: entry.disposition,
      course: attempted,
      nextCourse: this.current.course,
      remaining: this.#entries.length,
    });
  }

  #heldTransition(course, reason) {
    return Object.freeze({
      action: "held",
      reason,
      course,
      nextCourse: course,
      remaining: this.#entries.length,
    });
  }
}
