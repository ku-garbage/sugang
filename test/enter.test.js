import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  enterOrderedCourses,
  parseCourseArguments,
  requiredEnvironment,
} from "../src/enter.js";

const gif = await readFile(new URL("../samples/live-one.gif", import.meta.url));

test("entry CLI accepts only course arguments and environment credentials", () => {
  assert.deepEqual(parseCourseArguments(["COSE211@01", "MATH161@02"]), [
    "COSE211@01",
    "MATH161@02",
  ]);
  assert.deepEqual(requiredEnvironment({ LMS_ID: " student ", LMS_PWD: "secret" }), {
    id: "student",
    pwd: "secret",
  });
  assert.throws(() => parseCourseArguments([]), /at least one/);
  assert.throws(() => parseCourseArguments(["--pwd", "secret"]), /only ordered/);
  assert.throws(() => requiredEnvironment({ LMS_ID: "student" }), /LMS_PWD/);
});

test("ordered entry uses one session, passes CAPTCHA automatically, and dequeues a full course", async () => {
  const calls = [];
  const addCounts = new Map();
  let macroCheckCount = 0;
  const proofName = "x-sugang-proof";
  const proofValue = "ordered-proof";
  const divider =
    `<div id="divider" data-rn="${Buffer.from(proofName).toString("base64")}" ` +
    `data-rv="${Buffer.from(proofValue).toString("base64")}"></div>`;
  const fetchImpl = async (url, init) => {
    calls.push({ path: url.pathname, init });
    switch (url.pathname) {
      case "/":
        return new Response("home", { headers: { "Set-Cookie": "WMONID=one; Path=/" } });
      case "/d/l/loginCheck":
        return Response.json({ code: "200", message: "OK" });
      case "/p/s/sugangMain":
        return new Response(divider);
      case "/d/s/add": {
        const course = new URLSearchParams(init.body).get("params");
        const count = (addCounts.get(course) ?? 0) + 1;
        addCounts.set(course, count);
        if (course === "COSE211@01") {
          return Response.json({ code: "501", message: "Full" });
        }
        return Response.json(
          count === 1
            ? { code: "118", message: "Macro required" }
            : { code: "200", message: "Registered" },
        );
      }
      case "/p/m/macroMain":
        return new Response("<html></html>");
      case "/d/m/macroInit":
        return Response.json({ code: "200", failCnt: 10 });
      case "/d/m/macroImg":
        return new Response(gif, { headers: { "Content-Type": "image/gif" } });
      case "/d/m/macroCheck":
        macroCheckCount += 1;
        assert.equal(
          new URLSearchParams(init.body).get("secNumber"),
          macroCheckCount === 1 ? "AAAA" : "A7H1",
        );
        return Response.json(
          macroCheckCount === 1
            ? { code: "500", message: "Wrong answer", failCnt: 9 }
            : { code: "200", message: "" },
        );
      case "/p/l/logOut":
        return new Response("logged out");
      default:
        return new Response("not found", { status: 404 });
    }
  };
  let recognitionCount = 0;
  const macroSolver = {
    solveMacroChallenge(bytes) {
      recognitionCount += 1;
      assert.deepEqual(bytes, gif);
      return {
        answer: recognitionCount === 1 ? "AAAA" : "A7H1",
        diagnostics: {
          mismatchedPixelCount: 4,
          runnerUpMismatchGap: 24,
          glyphOriginsX: [20, 37, 49, 66],
        },
      };
    },
  };
  const lines = [];
  const statuses = [];

  const result = await enterOrderedCourses({
    courseArguments: ["cose211@01", "math161@02"],
    id: "student",
    pwd: "secret",
    fetchImpl,
    macroSolver,
    writeLine: (line) => lines.push(JSON.parse(line)),
    onStatus: (status) => statuses.push(status),
  });

  assert.equal(recognitionCount, 2);
  assert.equal(macroCheckCount, 2);
  assert.deepEqual(result.transitions.map(({ action }) => action), ["dequeued", "dequeued"]);
  assert.deepEqual(result.remaining, []);
  assert.deepEqual(
    result.notRegistered.map(({ course, reason }) => [course.params, reason]),
    [["COSE211@01", "full"]],
  );
  assert.deepEqual(lines.map(({ course, action }) => [course, action]), [
    ["COSE211@01", "dequeued"],
    ["MATH161@02", "dequeued"],
  ]);
  assert.deepEqual(
    statuses.filter(({ course }) => course?.params === "COSE211@01").map(({ state }) => state),
    ["checking", "full"],
  );
  assert.deepEqual(
    statuses.filter(({ course }) => course?.params === "MATH161@02").map(({ state }) => state),
    ["checking", "registered"],
  );
  assert.equal(
    statuses.find(({ course, state }) => course?.params === "MATH161@02" && state === "registered")
      .detail,
    "CAPTCHA passed automatically in 2 attempts",
  );
  assert.equal(calls.filter(({ path }) => path === "/").length, 1);
  assert.equal(calls.filter(({ path }) => path === "/d/l/loginCheck").length, 1);
  assert.equal(calls.filter(({ path }) => path === "/p/s/sugangMain").length, 1);
  assert.equal(calls.filter(({ path }) => path === "/d/m/macroInit").length, 2);
  assert.equal(calls.filter(({ path }) => path === "/p/l/logOut").length, 1);
});

function entryProof() {
  return (
    `<div id="divider" data-rn="${Buffer.from("x-sugang-proof").toString("base64")}" ` +
    `data-rv="${Buffer.from("entry-proof").toString("base64")}"></div>`
  );
}

test("CAPTCHA exhaustion becomes a course result and the ordered pass continues", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url.pathname);
    switch (url.pathname) {
      case "/":
        return new Response("home");
      case "/d/l/loginCheck":
        return Response.json({ code: "200" });
      case "/p/s/sugangMain":
        return new Response(entryProof());
      case "/d/s/add": {
        const course = new URLSearchParams(init.body).get("params");
        return Response.json(
          course === "COSE211@01"
            ? { code: "118", message: "Macro required" }
            : { code: "501", message: "Full" },
        );
      }
      case "/p/m/macroMain":
        return new Response("macro");
      case "/d/m/macroInit":
        return Response.json({ code: "200", failCnt: 10 });
      case "/d/m/macroImg":
        return new Response(gif, { headers: { "Content-Type": "image/gif" } });
      case "/d/m/macroCheck":
        return Response.json({ code: "500", message: "Wrong", failCnt: 7 });
      case "/p/l/logOut":
        return new Response("bye");
      default:
        return new Response("missing", { status: 404 });
    }
  };
  const macroSolver = {
    solveMacroChallenge() {
      return { answer: "AAAA", diagnostics: {} };
    },
  };
  const statuses = [];

  const result = await enterOrderedCourses({
    courseArguments: ["COSE211@01", "MATH161@02"],
    id: "student",
    pwd: "secret",
    fetchImpl,
    macroSolver,
    writeLine: () => {},
    onStatus: (status) => statuses.push(status),
  });

  assert.deepEqual(
    result.transitions.map(({ reason }) => reason),
    ["captcha_exhausted", "full"],
  );
  assert.deepEqual(
    result.remaining.map(({ course, disposition }) => [course.params, disposition]),
    [["COSE211@01", "captcha_exhausted"]],
  );
  assert.deepEqual(
    result.notRegistered.map(({ course, reason }) => [course.params, reason]),
    [
      ["COSE211@01", "captcha_exhausted"],
      ["MATH161@02", "full"],
    ],
  );
  assert.equal(calls.filter((path) => path === "/d/m/macroInit").length, 3);
  assert.equal(calls.filter((path) => path === "/d/m/macroImg").length, 3);
  assert.equal(
    statuses.find(({ state }) => state === "captcha_exhausted").detail,
    "automatic solver exhausted 3 attempts",
  );
});

test("successful enrollment is preserved when remote logout fails", async () => {
  const statuses = [];
  const fetchImpl = async (url) => {
    switch (url.pathname) {
      case "/":
        return new Response("home");
      case "/d/l/loginCheck":
        return Response.json({ code: "200" });
      case "/p/s/sugangMain":
        return new Response(entryProof());
      case "/d/s/add":
        return Response.json({ code: "200", message: "Registered" });
      case "/p/l/logOut":
        throw new Error("logout transport failed");
      default:
        return new Response("missing", { status: 404 });
    }
  };

  const result = await enterOrderedCourses({
    courseArguments: ["COSE211@01"],
    id: "student",
    pwd: "secret",
    fetchImpl,
    macroSolver: { solveMacroChallenge() {} },
    writeLine: () => {},
    onStatus: (status) => statuses.push(status),
  });

  assert.equal(result.transitions[0].action, "dequeued");
  assert.match(result.logoutError.message, /Logout failed: logout transport failed/);
  assert.match(statuses.at(-1).message, /Remote logout failed/);
});

test("ten rejection-plus-macro cycles register in one CLI invocation", async () => {
  const addCourses = [];
  const addCounts = new Map();
  const macroRequiredAt = [];
  let macroCheckCount = 0;
  const fetchImpl = async (url, init) => {
    switch (url.pathname) {
      case "/":
        return new Response("home");
      case "/d/l/loginCheck":
        return Response.json({ code: "200" });
      case "/p/s/sugangMain":
        return new Response(entryProof());
      case "/d/s/add": {
        const course = new URLSearchParams(init.body).get("params");
        addCourses.push(course);
        const count = (addCounts.get(course) ?? 0) + 1;
        addCounts.set(course, count);
        if (course !== "COSE211@01" || count > 110) {
          return Response.json({ code: "200", message: "Registered" });
        }
        if (count % 11 === 0) {
          macroRequiredAt.push(count);
          return Response.json({ code: "118", message: "Macro required" });
        }
        return Response.json({ code: "500", message: "Rejected" });
      }
      case "/p/m/macroMain":
        return new Response("macro");
      case "/d/m/macroInit":
        return Response.json({ code: "200", failCnt: 10 });
      case "/d/m/macroImg":
        return new Response(gif, { headers: { "Content-Type": "image/gif" } });
      case "/d/m/macroCheck":
        macroCheckCount += 1;
        return Response.json({ code: "200", failCnt: 10 });
      case "/p/l/logOut":
        return new Response("bye");
      default:
        return new Response("missing", { status: 404 });
    }
  };

  const result = await enterOrderedCourses({
    courseArguments: ["COSE211@01", "MATH161@02"],
    id: "student",
    pwd: "secret",
    fetchImpl,
    macroSolver: {
      solveMacroChallenge(bytes) {
        assert.deepEqual(bytes, gif);
        return { answer: "A7H1", diagnostics: {} };
      },
    },
    writeLine: () => {},
  });

  assert.deepEqual(addCourses, [
    ...Array(111).fill("COSE211@01"),
    "MATH161@02",
  ]);
  assert.deepEqual(macroRequiredAt, Array.from({ length: 10 }, (_, index) => (index + 1) * 11));
  assert.equal(macroCheckCount, 10);
  assert.deepEqual(
    result.transitions.map(({ action }) => action),
    ["dequeued", "dequeued"],
  );
  assert.equal(result.rejectionRetries, 100);
  assert.deepEqual(result.remaining, []);
  assert.equal(result.complete, true);
});

test("exhausted session recovery returns an incomplete stopped pass", async () => {
  const fetchImpl = async (url) => {
    switch (url.pathname) {
      case "/":
        return new Response("home");
      case "/d/l/loginCheck":
        return Response.json({ code: "200" });
      case "/p/s/sugangMain":
        return new Response(entryProof());
      case "/d/s/add":
        return Response.json({ code: "999", message: "Session expired" });
      case "/p/l/logOut":
        return new Response("bye");
      default:
        return new Response("missing", { status: 404 });
    }
  };

  const result = await enterOrderedCourses({
    courseArguments: ["COSE211@01", "MATH161@02"],
    id: "student",
    pwd: "secret",
    fetchImpl,
    macroSolver: { solveMacroChallenge() {} },
    writeLine: () => {},
  });

  assert.equal(result.complete, false);
  assert.equal(result.stoppedReason, "session_expired");
  assert.deepEqual(
    result.remaining.map(({ course, disposition }) => [course.params, disposition]),
    [
      ["COSE211@01", "session_expired"],
      ["MATH161@02", "pending"],
    ],
  );
});

test("default solver dependencies are preflighted before network activity", async () => {
  let requests = 0;
  await assert.rejects(
    enterOrderedCourses({
      courseArguments: ["COSE211@01"],
      id: "student",
      pwd: "secret",
      fetchImpl: async () => {
        requests += 1;
        return new Response("unexpected");
      },
      env: { LMS_CAPTCHA_FONT: "/definitely/missing/sugang-font.ttf" },
    }),
    /Font not found/,
  );
  assert.equal(requests, 0);
});

test("an external abort stops requests and still reaches local cleanup", async () => {
  const abortController = new AbortController();
  let markRequestStarted;
  const requestStarted = new Promise((resolve) => {
    markRequestStarted = resolve;
  });
  const fetchImpl = async (_url, init) => {
    markRequestStarted();
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    });
  };
  const run = enterOrderedCourses({
    courseArguments: ["COSE211@01"],
    id: "student",
    pwd: "secret",
    fetchImpl,
    macroSolver: { solveMacroChallenge() {} },
    signal: abortController.signal,
    writeLine: () => {},
  });
  await requestStarted;
  abortController.abort(new Error("Interrupted by SIGINT"));

  await assert.rejects(run, /Interrupted by SIGINT/);
});
