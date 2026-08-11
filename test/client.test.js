import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  SugangSessionCookies,
  SugangClient,
  SugangClientState,
  fetchMacroSample,
  parseArgs,
  streamMacroSamples,
  validateMacroGif,
} from "../src/client.js";

const gif = await readFile(new URL("../samples/live-one.gif", import.meta.url));

function fakeMacroSolver(answer = "A7H1", onSolve = () => {}) {
  return {
    solveMacroChallenge(bytes) {
      onSolve(bytes);
      return {
        answer,
        diagnostics: {
          mismatchedPixelCount: 4,
          runnerUpMismatchGap: 24,
          glyphOriginsX: [20, 37, 49, 66],
        },
      };
    },
  };
}

test("parseArgs uses environment credentials and rejects password arguments", () => {
  assert.deepEqual(parseArgs(["--id", "student", "--out", "x.gif"], { LMS_PWD: "secret" }), {
    id: "student",
    pwd: "secret",
    out: "x.gif",
    outDir: undefined,
    count: 1,
    delayMs: 250,
    help: false,
  });
  assert.throws(() => parseArgs(["--id", "student", "--pwd", "secret"], {}), /not supported/);
  assert.throws(() => parseArgs([], {}), /Missing --id/);
  assert.equal(
    parseArgs(["--count", "50", "--out-dir", "batch"], {
      LMS_ID: "student",
      LMS_PWD: "secret",
    }).count,
    50,
  );
});

test("SugangSessionCookies retains the observed root session cookies", () => {
  const cookies = new SugangSessionCookies();
  const headers = new Headers();
  headers.append("Set-Cookie", "WMONID=one; Path=/; HttpOnly");
  headers.append("Set-Cookie", "KORU_REG=two; Path=/; Secure");
  cookies.absorb(headers);
  assert.equal(cookies.header(), "WMONID=one; KORU_REG=two");
});

test("validateMacroGif rejects fake headers, truncation, and wrong dimensions", () => {
  assert.deepEqual(validateMacroGif(gif), { width: 100, height: 100, frames: 1 });
  assert.throws(() => validateMacroGif(Buffer.from("GIF89a-example")), /truncated|Expected/);
  assert.throws(() => validateMacroGif(gif.subarray(0, gif.length - 1)), /trailer|terminated|truncated/);
  const wrongDimensions = Buffer.from(gif);
  wrongDimensions.writeUInt16LE(99, 6);
  assert.throws(() => validateMacroGif(wrongDimensions), /Expected a 100x100 GIF/);
});

function successfulFetch({ reloadOnce = false, failSecondImage = false } = {}) {
  const calls = [];
  const responses = [];
  let initCount = 0;
  let imageCount = 0;

  async function fetchImpl(url, init) {
    calls.push({ url: url.toString(), init });
    const path = url.pathname;
    let response;
    if (path === "/") {
      response = new Response("home", {
        headers: [
          ["Set-Cookie", "WMONID=one; Path=/"],
          ["Set-Cookie", "KORU_REG=two; Path=/"],
        ],
      });
    } else if (path === "/d/l/loginCheck") {
      response = Response.json({ code: "200", message: "OK" });
    } else if (path === "/p/m/macroMain") {
      response = new Response("<html></html>");
    } else if (path === "/d/m/macroInit") {
      initCount += 1;
      response = Response.json({ code: reloadOnce && initCount === 1 ? "reload" : "200", failCnt: 10 });
    } else if (path === "/d/m/macroImg") {
      imageCount += 1;
      response = failSecondImage && imageCount === 2
        ? new Response("failed", { status: 503 })
        : new Response(gif, { headers: { "Content-Type": "image/gif;charset=UTF-8" } });
    } else if (path === "/p/l/logOut") {
      response = new Response("logged out");
    } else {
      response = new Response("not found", { status: 404 });
    }
    responses.push({ path, response });
    return response;
  }
  return { calls, responses, fetchImpl };
}

test("fetchMacroSample validates one image, consumes responses, and logs out", async () => {
  const server = successfulFetch();
  const result = await fetchMacroSample({ id: "student", pwd: "secret", fetchImpl: server.fetchImpl });

  assert.deepEqual(result.bytes, gif);
  assert.deepEqual(
    server.calls.map((call) => new URL(call.url).pathname),
    ["/", "/d/l/loginCheck", "/p/m/macroMain", "/d/m/macroInit", "/d/m/macroImg", "/p/l/logOut"],
  );
  assert.match(server.calls[1].init.headers.get("cookie"), /WMONID=one/);
  assert.ok(server.responses.every(({ response }) => response.bodyUsed));
});

test("streamMacroSamples retries reload and yields completed samples before a later failure", async () => {
  const server = successfulFetch({ reloadOnce: true, failSecondImage: true });
  const received = [];

  await assert.rejects(async () => {
    for await (const sample of streamMacroSamples({
      id: "student",
      pwd: "secret",
      count: 3,
      delayMs: 0,
      fetchImpl: server.fetchImpl,
    })) {
      received.push(sample);
    }
  }, /Macro initialization 2\/3 image query failed with HTTP 503/);

  assert.equal(received.length, 1);
  assert.equal(server.calls.filter((call) => new URL(call.url).pathname === "/d/m/macroInit").length, 3);
  assert.equal(new URL(server.calls.at(-1).url).pathname, "/p/l/logOut");
});

test("programmatic collection validates invariants before any request", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response("unexpected");
  };
  await assert.rejects(async () => {
    for await (const _sample of streamMacroSamples({
      id: "student",
      pwd: "secret",
      count: 0,
      fetchImpl,
    })) {
      // No sample is expected.
    }
  }, /count must be an integer/);
  assert.equal(calls, 0);
});

function courseStateMachineFetch({
  wrongMacroOnce = false,
  wrongMacroAlways = false,
  macroFailCnt = 9,
  macroFailureCode = "500",
  expireMacroCheckOnce = false,
  logoutFails = false,
} = {}) {
  const calls = [];
  let addCount = 0;
  let macroCheckCount = 0;
  let loginCount = 0;
  const proofHeaderName = "x-sugang-proof";
  const proofHeaderValue = "page-proof-value";
  const divider =
    `<div id="divider" data-rn="${Buffer.from(proofHeaderName).toString("base64")}" ` +
    `data-rv="${Buffer.from(proofHeaderValue).toString("base64")}"></div>`;

  async function fetchImpl(url, init) {
    calls.push({ url: url.toString(), init });
    switch (url.pathname) {
      case "/":
        return new Response("home", { headers: { "Set-Cookie": "WMONID=one; Path=/" } });
      case "/d/l/loginCheck":
        loginCount += 1;
        return Response.json({ code: "200", message: "OK" });
      case "/p/s/sugangMain":
        return new Response(divider, { headers: { "Content-Type": "text/html" } });
      case "/d/s/add":
        addCount += 1;
        return Response.json(
          addCount === 1
            ? { code: "118", message: "Macro required" }
            : { code: "200", message: "Registered" },
        );
      case "/p/m/macroMain":
        return new Response("<html></html>");
      case "/d/m/macroInit":
        return Response.json({ code: "200", failCnt: wrongMacroOnce ? 9 : 10 });
      case "/d/m/macroImg":
        return new Response(gif, { headers: { "Content-Type": "image/gif" } });
      case "/d/m/macroCheck":
        macroCheckCount += 1;
        return Response.json(
          expireMacroCheckOnce && macroCheckCount === 1
            ? { code: "999", message: "Session expired" }
            : wrongMacroAlways || (wrongMacroOnce && macroCheckCount === 1)
              ? {
                  code: macroFailureCode,
                  message: "Wrong answer",
                  failCnt: macroFailCnt,
                }
              : { code: "200", message: "" },
        );
      case "/p/l/logOut":
        if (logoutFails) throw new Error("logout transport failed");
        return new Response("logged out");
      default:
        return new Response("not found", { status: 404 });
    }
  }
  return { calls, fetchImpl, proofHeaderName, proofHeaderValue, get loginCount() { return loginCount; } };
}

test("SugangClient carries course proof through macro verification and retries the same add", async () => {
  const server = courseStateMachineFetch();
  const macroSolver = fakeMacroSolver("A7H1", (bytes) => assert.deepEqual(bytes, gif));
  const client = new SugangClient({
    course: { courseCode: "ABCD123", section: "01" },
    fetchImpl: server.fetchImpl,
    macroSolver,
  });
  try {
    await client.open({ id: "student", pwd: "secret" });
    assert.equal(client.state, SugangClientState.READY);
    assert.deepEqual(client.course, {
      courseCode: "ABCD123",
      section: "01",
      params: "ABCD123@01",
    });

    const completed = await client.registerCourse();
    assert.equal(completed.state, SugangClientState.READY);
    assert.equal(completed.outcome, "registered");
    assert.equal(completed.code, "200");
    assert.deepEqual(completed.macroAttempts, [
      {
        answer: "A7H1",
        mismatchedPixelCount: 4,
        runnerUpMismatchGap: 24,
        glyphOriginsX: [20, 37, 49, 66],
        code: "200",
        failCnt: undefined,
      },
    ]);

    const addCalls = server.calls.filter((call) => new URL(call.url).pathname === "/d/s/add");
    assert.equal(addCalls.length, 2);
    for (const call of addCalls) {
      const body = new URLSearchParams(call.init.body);
      assert.equal(body.get("params"), "ABCD123@01");
      assert.equal(
        body.get("hp"),
        createHash("sha256").update("ABCD123@01@page-proof-value").digest("hex"),
      );
      assert.equal(call.init.headers.get(server.proofHeaderName), server.proofHeaderValue);
    }
    const macroCheck = server.calls.find(
      (call) => new URL(call.url).pathname === "/d/m/macroCheck",
    );
    assert.equal(new URLSearchParams(macroCheck.init.body).get("secNumber"), "A7H1");
    assert.equal(server.calls.some((call) => new URL(call.url).host.includes("netfunnel")), false);
  } finally {
    await client.close();
  }
  assert.equal(client.state, SugangClientState.CLOSED);
});

test("automatic macro flow uses failCnt and retries a replacement challenge", async () => {
  const server = courseStateMachineFetch({ wrongMacroOnce: true });
  const macroSolver = fakeMacroSolver("AAAA");
  const client = new SugangClient({
    course: { courseCode: "ABCD123", section: "01" },
    fetchImpl: server.fetchImpl,
    macroSolver,
  });
  try {
    await client.open({ id: "student", pwd: "secret" });
    const completed = await client.registerCourse();
    assert.equal(completed.outcome, "registered");
    assert.equal(completed.macroAttempts.length, 2);
    assert.equal(completed.macroAttempts[0].code, "500");
    assert.equal(completed.macroAttempts[0].failCnt, 9);
    assert.equal(completed.macroAttempts[1].code, "200");
  } finally {
    await client.close();
  }
});

test("automatic macro exhaustion does not fetch an unused replacement challenge", async () => {
  const server = courseStateMachineFetch({ wrongMacroAlways: true });
  const client = new SugangClient({
    course: { courseCode: "ABCD123", section: "01" },
    fetchImpl: server.fetchImpl,
    macroSolver: fakeMacroSolver("AAAA"),
    maxMacroAttempts: 3,
  });
  try {
    await client.open({ id: "student", pwd: "secret" });
    const exhausted = await client.registerCourse();

    assert.equal(exhausted.kind, "captcha_exhausted");
    assert.equal(exhausted.state, SugangClientState.READY);
    assert.equal(exhausted.macroAttempts.length, 3);
    const paths = server.calls.map((call) => new URL(call.url).pathname);
    assert.equal(paths.filter((path) => path === "/d/m/macroCheck").length, 3);
    assert.equal(paths.filter((path) => path === "/d/m/macroInit").length, 3);
    assert.equal(paths.filter((path) => path === "/d/m/macroImg").length, 3);
  } finally {
    await client.close();
  }
});

test("server failCnt exhaustion stops automatic retries immediately", async () => {
  const server = courseStateMachineFetch({ wrongMacroAlways: true, macroFailCnt: 0 });
  const client = new SugangClient({
    course: { courseCode: "ABCD123", section: "01" },
    fetchImpl: server.fetchImpl,
    macroSolver: fakeMacroSolver("AAAA"),
  });
  try {
    await client.open({ id: "student", pwd: "secret" });
    const exhausted = await client.registerCourse();
    assert.equal(exhausted.kind, "captcha_exhausted");
    assert.equal(exhausted.macroAttempts.length, 1);
    assert.equal(
      server.calls.filter((call) => new URL(call.url).pathname === "/d/m/macroInit").length,
      1,
    );
  } finally {
    await client.close();
  }
});

test("unknown macro rejection codes are not treated as wrong-answer retries", async () => {
  const server = courseStateMachineFetch({
    wrongMacroAlways: true,
    macroFailureCode: "418",
  });
  const client = new SugangClient({
    course: { courseCode: "ABCD123", section: "01" },
    fetchImpl: server.fetchImpl,
    macroSolver: fakeMacroSolver("AAAA"),
  });
  try {
    await client.open({ id: "student", pwd: "secret" });
    await assert.rejects(client.registerCourse(), /rejected \(code 418\)/);
    assert.equal(
      server.calls.filter((call) => new URL(call.url).pathname === "/d/m/macroInit").length,
      1,
    );
  } finally {
    await client.close();
  }
});

test("close preserves local disposal and reports remote logout failure", async () => {
  const server = courseStateMachineFetch({ logoutFails: true });
  const client = new SugangClient({
    course: { courseCode: "ABCD123", section: "01" },
    fetchImpl: server.fetchImpl,
  });
  await client.open({ id: "student", pwd: "secret" });

  const closed = await client.close();

  assert.equal(closed.loggedOut, false);
  assert.match(closed.error.message, /Logout failed: logout transport failed/);
  assert.equal(client.state, SugangClientState.CLOSED);
});

test("sample collection cannot replace a course registration challenge", async () => {
  const server = courseStateMachineFetch();
  const client = new SugangClient({
    course: { courseCode: "ABCD123", section: "01" },
    fetchImpl: server.fetchImpl,
  });
  try {
    await client.open({ id: "student", pwd: "secret" });
    const required = await client.registerCourse({ autoMacro: false });
    assert.equal(required.kind, "macro_required");
    await assert.rejects(client.fetchSample(1, 1), /course-registration client/);
    assert.equal(
      server.calls.filter((call) => new URL(call.url).pathname === "/d/m/macroInit").length,
      1,
    );
  } finally {
    await client.close();
  }
});

test("one carrier reuses one session for 100 COSE211 course actions", async () => {
  const calls = [];
  let addCount = 0;
  const proofName = "x-sugang-proof";
  const proofValue = "shared-session-proof";
  const divider =
    `<div id="divider" data-rn="${Buffer.from(proofName).toString("base64")}" ` +
    `data-rv="${Buffer.from(proofValue).toString("base64")}"></div>`;
  const fetchImpl = async (url, init) => {
    calls.push({ path: url.pathname, init });
    switch (url.pathname) {
      case "/":
        return new Response("home", { headers: { "Set-Cookie": "WMONID=shared; Path=/" } });
      case "/d/l/loginCheck":
        return Response.json({ code: "200", message: "OK" });
      case "/p/s/sugangMain":
        return new Response(divider);
      case "/d/s/add":
        addCount += 1;
        return Response.json(
          addCount % 2 === 1
            ? { code: "118", message: "Macro required" }
            : { code: "200", message: "Registered" },
        );
      case "/p/m/macroMain":
        return new Response("<html></html>");
      case "/d/m/macroInit":
        return Response.json({ code: "200", failCnt: 10 });
      case "/d/m/macroImg":
        return new Response(gif, { headers: { "Content-Type": "image/gif" } });
      case "/d/m/macroCheck":
        return Response.json({ code: "200", message: "" });
      case "/p/l/logOut":
        return new Response("logged out");
      default:
        return new Response("not found", { status: 404 });
    }
  };
  const macroSolver = fakeMacroSolver();
  const client = new SugangClient({
    course: { courseCode: "COSE211", section: "01" },
    fetchImpl,
    macroSolver,
  });
  try {
    await client.open({ id: "student", pwd: "secret" });
    for (let attempt = 1; attempt <= 100; attempt += 1) {
      const result = await client.registerCourse();
      assert.equal(result.outcome, "registered", `course action ${attempt}`);
    }
  } finally {
    await client.close();
  }

  assert.equal(calls.filter(({ path }) => path === "/").length, 1);
  assert.equal(calls.filter(({ path }) => path === "/d/l/loginCheck").length, 1);
  assert.equal(calls.filter(({ path }) => path === "/p/s/sugangMain").length, 1);
  assert.equal(calls.filter(({ path }) => path === "/p/m/macroMain").length, 1);
  assert.equal(calls.filter(({ path }) => path === "/d/s/add").length, 200);
  assert.equal(calls.filter(({ path }) => path === "/d/m/macroCheck").length, 100);
  assert.equal(calls.filter(({ path }) => path === "/p/l/logOut").length, 1);
});

test("expired macro answer logs in and restarts the stored course action", async () => {
  const server = courseStateMachineFetch({ expireMacroCheckOnce: true });
  const macroSolver = fakeMacroSolver();
  const client = new SugangClient({
    course: { courseCode: "ABCD123", section: "01" },
    fetchImpl: server.fetchImpl,
    macroSolver,
  });
  try {
    await client.open({ id: "student", pwd: "secret" });
    const completed = await client.registerCourse();
    assert.equal(completed.outcome, "registered");
    assert.equal(completed.sessionRenewed, true);
    assert.equal(completed.macroAttempts[0].code, "999");
    assert.equal(server.loginCount, 2);
    assert.equal(
      server.calls.filter((call) => new URL(call.url).pathname === "/d/s/add").length,
      2,
    );
  } finally {
    await client.close();
  }
});

function expiringSampleFetch({ expireAt, alwaysExpired = false } = {}) {
  const calls = [];
  const counts = { macroPage: 0, macroInit: 0, macroImg: 0, login: 0 };
  const endpointNames = {
    "/p/m/macroMain": "macroPage",
    "/d/m/macroInit": "macroInit",
    "/d/m/macroImg": "macroImg",
  };

  async function fetchImpl(url, init) {
    calls.push({ url: url.toString(), init });
    if (url.pathname === "/") {
      return new Response("home", { headers: { "Set-Cookie": "WMONID=session; Path=/" } });
    }
    if (url.pathname === "/d/l/loginCheck") {
      counts.login += 1;
      return Response.json({ code: "200", message: "OK" });
    }
    if (url.pathname === "/p/l/logOut") return new Response("logged out");

    const endpoint = endpointNames[url.pathname];
    if (!endpoint) return new Response("not found", { status: 404 });
    counts[endpoint] += 1;
    if (expireAt === endpoint && (alwaysExpired || counts[endpoint] === 1)) {
      return Response.json({ code: "999", message: "Session expired" });
    }
    if (endpoint === "macroPage") return new Response("<html></html>");
    if (endpoint === "macroInit") return Response.json({ code: "200", failCnt: 10 });
    return new Response(gif, { headers: { "Content-Type": "image/gif" } });
  }

  return { calls, counts, fetchImpl };
}

for (const expireAt of ["macroPage", "macroInit", "macroImg"]) {
  test(`fetchSample renews once when ${expireAt} reports session expiry`, async () => {
    const server = expiringSampleFetch({ expireAt });
    const client = new SugangClient({ fetchImpl: server.fetchImpl });
    try {
      await client.open({ id: "student", pwd: "secret" });
      const sample = await client.fetchSample(1, 1);
      assert.deepEqual(sample.bytes, gif);
      assert.equal(sample.sessionRenewed, true);
      assert.equal(server.counts.login, 2);
      assert.equal(server.counts[expireAt], 2);
    } finally {
      await client.close();
    }
  });
}

test("repeated macro initialization expiry returns the common expired result", async () => {
  const server = expiringSampleFetch({ expireAt: "macroInit", alwaysExpired: true });
  const client = new SugangClient({ fetchImpl: server.fetchImpl });
  try {
    await client.open({ id: "student", pwd: "secret" });
    const expired = await client.fetchSample(1, 1);
    assert.deepEqual(expired, {
      kind: "session_expired",
      state: SugangClientState.EXPIRED,
      code: "999",
      message: "Session expired",
      sessionRenewed: true,
    });
    assert.equal(server.counts.login, 2);
    assert.equal(server.counts.macroInit, 2);
  } finally {
    await client.close();
  }
});

test("sample APIs reject exhausted session recovery before yielding a GIF", async () => {
  const streamServer = expiringSampleFetch({ expireAt: "macroInit", alwaysExpired: true });
  let yielded = 0;
  await assert.rejects(async () => {
    for await (const _sample of streamMacroSamples({
      id: "student",
      pwd: "secret",
      count: 2,
      delayMs: 0,
      fetchImpl: streamServer.fetchImpl,
    })) {
      yielded += 1;
    }
  }, /Macro sample collection reported an invalid session/);
  assert.equal(yielded, 0);

  const singleServer = expiringSampleFetch({ expireAt: "macroInit", alwaysExpired: true });
  await assert.rejects(
    fetchMacroSample({ id: "student", pwd: "secret", fetchImpl: singleServer.fetchImpl }),
    /Macro sample collection reported an invalid session/,
  );
});

test("fetchSample rejects unbounded macro reload counts", async () => {
  const server = successfulFetch();
  const client = new SugangClient({ fetchImpl: server.fetchImpl });
  try {
    await client.open({ id: "student", pwd: "secret" });
    for (const maxReloads of [-1, 10, Infinity, NaN]) {
      await assert.rejects(client.fetchSample(1, 1, maxReloads), /maxReloads/);
    }
  } finally {
    await client.close();
  }
});

test("failed session initialization rolls the carrier back to new", async () => {
  let loginCount = 0;
  const fetchImpl = async (url) => {
    if (url.pathname === "/") {
      return new Response("home", { headers: { "Set-Cookie": "WMONID=partial; Path=/" } });
    }
    if (url.pathname === "/d/l/loginCheck") {
      loginCount += 1;
      return Response.json({ code: loginCount === 1 ? "500" : "200", message: "Rejected" });
    }
    return new Response("logged out");
  };
  const client = new SugangClient({ fetchImpl });
  await assert.rejects(client.open({ id: "student", pwd: "wrong" }), /Login rejected/);
  assert.equal(client.state, SugangClientState.NEW);
  await client.open({ id: "student", pwd: "correct" });
  assert.equal(client.state, SugangClientState.READY);
  await client.close();
});

function expiringCourseFetch({ alwaysExpired = false } = {}) {
  const calls = [];
  let homeCount = 0;
  let addCount = 0;

  async function fetchImpl(url, init) {
    calls.push({ url: url.toString(), init });
    switch (url.pathname) {
      case "/": {
        homeCount += 1;
        const headers = new Headers();
        headers.append("Set-Cookie", `WMONID=session-${homeCount}; Path=/`);
        if (homeCount === 1) headers.append("Set-Cookie", "KORU_REG=stale; Path=/");
        return new Response("home", { headers });
      }
      case "/d/l/loginCheck":
        return Response.json({ code: "200", message: "OK" });
      case "/p/s/sugangMain": {
        const headerName = "x-sugang-proof";
        const headerValue = `proof-${homeCount}`;
        return new Response(
          `<div id="divider" data-rn="${Buffer.from(headerName).toString("base64")}" ` +
            `data-rv="${Buffer.from(headerValue).toString("base64")}"></div>`,
        );
      }
      case "/d/s/add":
        addCount += 1;
        return Response.json(
          alwaysExpired || addCount === 1
            ? { code: "999", message: "Session expired" }
            : { code: "200", message: "Registered" },
        );
      case "/p/l/logOut":
        return new Response("logged out");
      default:
        return new Response("not found", { status: 404 });
    }
  }

  return { calls, fetchImpl };
}

test("expired course session logs in once and replays with fresh cookies and proof", async () => {
  const server = expiringCourseFetch();
  const client = new SugangClient({
    course: { courseCode: "ABCD123", section: "01" },
    fetchImpl: server.fetchImpl,
  });
  try {
    await client.open({ id: "student", pwd: "secret" });
    const completed = await client.registerCourse();

    assert.equal(completed.outcome, "registered");
    assert.equal(completed.sessionRenewed, true);
    const paths = server.calls.map((call) => new URL(call.url).pathname);
    assert.deepEqual(paths, [
      "/",
      "/d/l/loginCheck",
      "/p/s/sugangMain",
      "/d/s/add",
      "/",
      "/d/l/loginCheck",
      "/p/s/sugangMain",
      "/d/s/add",
    ]);

    const loginCalls = server.calls.filter(
      (call) => new URL(call.url).pathname === "/d/l/loginCheck",
    );
    assert.match(loginCalls[1].init.headers.get("cookie"), /WMONID=session-2/);
    assert.doesNotMatch(loginCalls[1].init.headers.get("cookie"), /KORU_REG=stale/);

    const replay = server.calls.filter(
      (call) => new URL(call.url).pathname === "/d/s/add",
    )[1];
    assert.equal(replay.init.headers.get("x-sugang-proof"), "proof-2");
    assert.equal(
      new URLSearchParams(replay.init.body).get("hp"),
      createHash("sha256").update("ABCD123@01@proof-2").digest("hex"),
    );
  } finally {
    await client.close();
  }
});

test("automatic session recovery is bounded to one login per action", async () => {
  const server = expiringCourseFetch({ alwaysExpired: true });
  const client = new SugangClient({
    course: { courseCode: "ABCD123", section: "01" },
    fetchImpl: server.fetchImpl,
  });
  try {
    await client.open({ id: "student", pwd: "secret" });
    const expired = await client.registerCourse();
    assert.equal(expired.state, SugangClientState.EXPIRED);
    assert.equal(expired.code, "999");
    assert.equal(
      server.calls.filter((call) => new URL(call.url).pathname === "/d/l/loginCheck").length,
      2,
    );
    assert.equal(
      server.calls.filter((call) => new URL(call.url).pathname === "/d/s/add").length,
      2,
    );
  } finally {
    await client.close();
  }
});
