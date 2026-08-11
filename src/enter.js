#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createSugangCaptchaRecognizer } from "./captcha/recognizer.js";
import { createSugangCaptchaTemplates } from "./captcha/templates.js";
import {
  SugangClient,
  SugangRegistrationResultKind,
} from "./client.js";
import {
  parseSugangCourse,
  SugangOrderedEntryPass,
} from "./sugang-ordered-entry-pass.js";

const ANSI = Object.freeze({
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  cyan: "\u001b[36m",
});

const COURSE_STATES = Object.freeze({
  pending: { symbol: "○", label: "pending", color: ANSI.dim },
  checking: { symbol: "●", label: "checking", color: ANSI.cyan },
  registered: { symbol: "✓", label: "registered", color: ANSI.green },
  full: { symbol: "!", label: "full — not registered", color: ANSI.yellow },
  captcha_exhausted: { symbol: "×", label: "CAPTCHA not solved", color: ANSI.red },
  rejected: { symbol: "×", label: "rejected", color: ANSI.red },
  session_expired: { symbol: "×", label: "session expired", color: ANSI.red },
});

class SugangEntryDisplay {
  #output;
  #interactive;
  #color;
  #active = false;
  #session = "waiting to log in";
  #courses;

  constructor(courseArguments, output = process.stdout, env = process.env) {
    this.#output = output;
    this.#interactive = output.isTTY === true;
    this.#color = this.#interactive && !("NO_COLOR" in env);
    this.#courses = courseArguments.map((value) => ({
      course: parseSugangCourse(value),
      state: "pending",
      detail: "",
    }));
  }

  start() {
    if (this.#interactive) {
      this.#active = true;
      this.#output.write("\u001b[?1049h");
      this.#render();
    }
  }

  update(event) {
    if (event.type === "session") this.#session = event.message;
    if (event.course) {
      const row = this.#courses.find(({ course }) => course.params === event.course.params);
      if (row) {
        row.state = event.state;
        row.detail = event.detail ?? "";
      }
    }
    if (this.#interactive) this.#render();
    else if (event.course || event.type === "session") this.#writePlainEvent(event);
  }

  finish(error = null) {
    if (error) this.#session = `stopped: ${error.message}`;
    else this.#session = "pass complete";
    if (this.#interactive && this.#active) {
      this.#render();
      this.#output.write("\u001b[?1049l");
      this.#active = false;
      this.#output.write(`${this.#lines().join("\n")}\n`);
    }
  }

  #paint(value, color) {
    return this.#color ? `${color}${value}${ANSI.reset}` : value;
  }

  #lines() {
    return [
      this.#paint("Sugang ordered entry", ANSI.bold),
      `Session: ${this.#session}`,
      "",
      ...this.#courses.map(({ course, state, detail }) => {
        const presentation = COURSE_STATES[state];
        const status = this.#paint(
          `${presentation.symbol} ${presentation.label}`,
          presentation.color,
        );
        return `${course.params.padEnd(18)} ${status}${detail ? ` · ${detail}` : ""}`;
      }),
    ];
  }

  #render() {
    this.#output.write(`\u001b[2J\u001b[H${this.#lines().join("\n")}\n`);
  }

  #writePlainEvent(event) {
    if (event.course) {
      const presentation = COURSE_STATES[event.state];
      this.#output.write(
        `${event.course.params} ${presentation.label}${event.detail ? `: ${event.detail}` : ""}\n`,
      );
    } else {
      this.#output.write(`Session: ${event.message}\n`);
    }
  }
}

export function requiredEnvironment(env) {
  const id = String(env.LMS_ID ?? "").trim();
  const pwd = env.LMS_PWD;
  if (!id) throw new Error("LMS_ID is required in the environment");
  if (typeof pwd !== "string" || !pwd) {
    throw new Error("LMS_PWD is required in the environment");
  }
  return { id, pwd };
}

export function parseCourseArguments(argv) {
  if (argv.length === 0) throw new Error("Provide at least one COURSE_CODE@SECTION argument");
  if (argv.some((argument) => argument.startsWith("-"))) {
    throw new Error("This command accepts only ordered COURSE_CODE@SECTION arguments");
  }
  return argv;
}

export function createDefaultMacroSolver(env = process.env) {
  const options = {};
  if (env.LMS_CAPTCHA_FONT) options.fontPath = env.LMS_CAPTCHA_FONT;
  if (env.LMS_IMAGEMAGICK_COMMAND) {
    options.imageMagickCommand = env.LMS_IMAGEMAGICK_COMMAND;
  }
  return createSugangCaptchaRecognizer(createSugangCaptchaTemplates(options));
}

function printTransition(transition, writeLine) {
  writeLine(JSON.stringify({
    course: transition.course.params,
    action: transition.action,
    reason: transition.reason ?? null,
    nextCourse: transition.nextCourse?.params ?? null,
    remaining: transition.remaining,
  }));
}

export async function enterOrderedCourses({
  courseArguments,
  id,
  pwd,
  fetchImpl = fetch,
  macroSolver,
  signal,
  env = process.env,
  writeLine = console.log,
  onStatus = () => {},
}) {
  const pass = new SugangOrderedEntryPass(courseArguments);
  const transitionsByCourse = new Map();
  let rejectionRetries = 0;
  const ownsMacroSolver = !macroSolver;
  let solver;
  let client;
  let failure = null;
  let stoppedReason = null;
  let closeResult = { loggedOut: false, error: null };
  let solverCloseError = null;

  try {
    solver = macroSolver ?? createDefaultMacroSolver(env);
    client = new SugangClient({
      course: pass.current.course,
      fetchImpl,
      macroSolver: solver,
      signal,
    });
    onStatus({ type: "session", message: "logging in" });
    await client.open({ id, pwd });
    onStatus({ type: "session", message: "authenticated" });
    while (!pass.complete) {
      const course = pass.current.course;
      if (client.course.params !== course.params) await client.selectCourse(course);

      onStatus({ type: "course", course, state: "checking" });
      const result = await client.registerCourse();

      const transition = pass.record(result);
      transitionsByCourse.set(course.params, transition);
      if (transition.action === "retry") rejectionRetries += 1;
      printTransition(transition, writeLine);
      onStatus({
        type: "course",
        course,
        state: result.kind === SugangRegistrationResultKind.REGISTERED
          ? "registered"
          : transition.reason,
        detail: result.kind === SugangRegistrationResultKind.CAPTCHA_EXHAUSTED
          ? `automatic solver exhausted ${result.macroAttempts?.length ?? 0} attempts`
          : result.sessionRenewed
          ? "session renewed"
          : result.kind === SugangRegistrationResultKind.REGISTERED && result.macroAttempts?.length
            ? `CAPTCHA passed automatically in ${result.macroAttempts.length} attempt${
                result.macroAttempts.length === 1 ? "" : "s"
              }`
            : result.message,
      });
      if (result.kind === SugangRegistrationResultKind.SESSION_EXPIRED) {
        stoppedReason = result.kind;
        break;
      }
    }
  } catch (error) {
    failure = error;
  } finally {
    if (client) closeResult = await client.close();
    if (ownsMacroSolver && solver) {
      try {
        solver.close();
      } catch (error) {
        solverCloseError = error;
        if (failure) failure.solverCloseError = error;
      }
    }
  }

  if (closeResult.error) {
    onStatus({
      type: "warning",
      message: `Remote logout failed; local credentials were cleared: ${closeResult.error.message}`,
    });
    if (failure) failure.logoutError = closeResult.error;
  }
  if (solverCloseError) {
    onStatus({
      type: "warning",
      message: `CAPTCHA solver cleanup failed: ${solverCloseError.message}`,
    });
  }
  if (failure) throw failure;

  return Object.freeze({
    transitions: Object.freeze([...transitionsByCourse.values()]),
    notRegistered: Object.freeze(
      [...transitionsByCourse.values()].filter(({ reason }) =>
        ["full", "captcha_exhausted"].includes(reason),
      ),
    ),
    rejectionRetries,
    remaining: pass.remaining,
    complete: pass.complete,
    stoppedReason,
    logoutError: closeResult.error,
    solverCloseError,
  });
}

async function main() {
  const courseArguments = parseCourseArguments(process.argv.slice(2));
  const { id, pwd } = requiredEnvironment(process.env);
  const display = new SugangEntryDisplay(courseArguments);
  const abortController = new AbortController();
  let interruptedSignal = null;
  const interrupt = (signalName) => {
    interruptedSignal ??= signalName;
    abortController.abort(new Error(`Interrupted by ${signalName}`));
  };
  const onSigint = () => interrupt("SIGINT");
  const onSigterm = () => interrupt("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  display.start();
  try {
    const result = await enterOrderedCourses({
      courseArguments,
      id,
      pwd,
      signal: abortController.signal,
      writeLine: () => {},
      onStatus: (event) => display.update(event),
    });
    if (!result.complete) {
      const error = new Error(
        `Ordered entry stopped: ${result.stoppedReason ?? "pass incomplete"}`,
      );
      error.logoutError = result.logoutError;
      error.solverCloseError = result.solverCloseError;
      throw error;
    }
    display.finish();
    if (result.notRegistered.length > 0) {
      console.log(
        `Not registered in this pass: ${result.notRegistered
          .map(({ course, reason }) => `${course.params} (${reason})`)
          .join(", ")}`,
      );
    } else {
      console.log("All requested courses were registered.");
    }
    if (result.logoutError) {
      console.error(`Warning: ${result.logoutError.message}`);
    }
    if (result.solverCloseError) {
      console.error(`Warning: ${result.solverCloseError.message}`);
    }
  } catch (error) {
    display.finish(error);
    if (error.logoutError) {
      console.error(`Warning: ${error.logoutError.message}`);
    }
    if (error.solverCloseError) {
      console.error(`Warning: ${error.solverCloseError.message}`);
    }
    if (interruptedSignal) {
      error.exitCode = interruptedSignal === "SIGINT" ? 130 : 143;
    }
    throw error;
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
}

const isEntryPoint =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isEntryPoint) {
  main().catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = error.exitCode ?? 1;
  });
}
