#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, open, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { normalizeSugangCourse } from "./sugang-course.js";

const DEFAULT_BASE_URL = "https://sugang.korea.ac.kr";
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

export class SugangSessionCookies {
  #cookies = new Map();

  clear() {
    this.#cookies.clear();
  }

  absorb(headers) {
    const setCookies =
      typeof headers.getSetCookie === "function"
        ? headers.getSetCookie()
        : headers.get("set-cookie")
          ? [headers.get("set-cookie")]
          : [];

    for (const setCookie of setCookies) {
      const pair = setCookie.split(";", 1)[0];
      const separator = pair.indexOf("=");
      if (separator <= 0) continue;

      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (value) this.#cookies.set(name, value);
      else this.#cookies.delete(name);
    }
  }

  header() {
    return [...this.#cookies]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }
}

function validateCollectionOptions({ id, pwd, count = 1, delayMs = 250 }) {
  if (typeof id !== "string" || !id.trim()) throw new Error("A student ID is required");
  if (typeof pwd !== "string" || !pwd) throw new Error("A password is required");
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    throw new Error("count must be an integer from 1 to 100");
  }
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 10_000) {
    throw new Error("delayMs must be an integer from 0 to 10000");
  }
}

export function parseArgs(argv, env = process.env) {
  const options = {
    id: env.LMS_ID,
    pwd: env.LMS_PWD,
    out: undefined,
    outDir: undefined,
    count: 1,
    delayMs: 250,
    help: false,
  };
  const names = new Set(["--id", "--out", "--out-dir", "--count", "--delay-ms"]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--pwd") {
      throw new Error("--pwd is not supported; use the hidden prompt or LMS_PWD");
    }
    if (!names.has(argument)) throw new Error(`Unknown argument: ${argument}`);

    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}`);
    const name = argument
      .slice(2)
      .replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    options[name] = value;
    index += 1;
  }

  options.count = Number(options.count);
  options.delayMs = Number(options.delayMs);
  if (!Number.isInteger(options.count) || options.count < 1 || options.count > 100) {
    throw new Error("--count must be an integer from 1 to 100");
  }
  if (!Number.isInteger(options.delayMs) || options.delayMs < 0 || options.delayMs > 10_000) {
    throw new Error("--delay-ms must be an integer from 0 to 10000");
  }
  if (options.count > 1 && options.out) {
    throw new Error("Use --out-dir instead of --out when --count is greater than 1");
  }
  if (!options.help && !options.id) throw new Error("Missing --id or LMS_ID");
  return options;
}

function fingerprintHeader() {
  const offset = new Date().getTimezoneOffset();
  return Buffer.from(`null|false|0-0|${offset}|0|0|0|0|false|`).toString("base64");
}

async function consume(response) {
  try {
    await response.arrayBuffer();
  } catch {
    try {
      await response.body?.cancel();
    } catch {
      // The body is already unusable; there is nothing else to release.
    }
  }
}

async function parseJson(response, operation) {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    await consume(response);
    throw new Error(`${operation} returned ${contentType || "an unknown content type"}`);
  }
  try {
    return await response.json();
  } catch (error) {
    throw new Error(`${operation} returned invalid JSON`, { cause: error });
  }
}

function readSubBlocks(bytes, start) {
  let cursor = start;
  while (cursor < bytes.length) {
    const size = bytes[cursor];
    cursor += 1;
    if (size === 0) return cursor;
    if (cursor + size > bytes.length) throw new Error("GIF contains a truncated data block");
    cursor += size;
  }
  throw new Error("GIF data blocks are not terminated");
}

export function validateMacroGif(bytes, expectedWidth = 100, expectedHeight = 100) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 14) throw new Error("GIF is truncated");
  const signature = bytes.subarray(0, 6).toString("ascii");
  if (!/^GIF8[79]a$/.test(signature)) throw new Error("GIF signature is invalid");

  const width = bytes.readUInt16LE(6);
  const height = bytes.readUInt16LE(8);
  if (width !== expectedWidth || height !== expectedHeight) {
    throw new Error(`Expected a ${expectedWidth}x${expectedHeight} GIF, received ${width}x${height}`);
  }

  const globalColorTable = (bytes[10] & 0x80) !== 0;
  const globalColorTableBytes = globalColorTable ? 3 * 2 ** ((bytes[10] & 0x07) + 1) : 0;
  let cursor = 13 + globalColorTableBytes;
  let imageCount = 0;

  while (cursor < bytes.length) {
    const marker = bytes[cursor];
    cursor += 1;
    if (marker === 0x3b) {
      if (imageCount === 0) throw new Error("GIF has no image frame");
      if (cursor !== bytes.length) throw new Error("GIF contains trailing data after its trailer");
      return { width, height, frames: imageCount };
    }
    if (marker === 0x21) {
      if (cursor >= bytes.length) throw new Error("GIF extension is truncated");
      cursor += 1;
      cursor = readSubBlocks(bytes, cursor);
      continue;
    }
    if (marker !== 0x2c) throw new Error(`GIF contains unknown block marker 0x${marker.toString(16)}`);
    if (cursor + 9 > bytes.length) throw new Error("GIF image descriptor is truncated");

    const frameWidth = bytes.readUInt16LE(cursor + 4);
    const frameHeight = bytes.readUInt16LE(cursor + 6);
    if (frameWidth === 0 || frameHeight === 0) throw new Error("GIF frame has zero dimensions");
    const packed = bytes[cursor + 8];
    cursor += 9;
    if ((packed & 0x80) !== 0) cursor += 3 * 2 ** ((packed & 0x07) + 1);
    if (cursor >= bytes.length) throw new Error("GIF image data is truncated");
    cursor += 1; // LZW minimum code size.
    cursor = readSubBlocks(bytes, cursor);
    imageCount += 1;
  }
  throw new Error("GIF trailer is missing");
}

export const SugangClientState = Object.freeze({
  NEW: "new",
  READY: "ready",
  MACRO_REQUIRED: "macro_required",
  EXPIRED: "expired",
  CLOSED: "closed",
});

export const SugangRegistrationResultKind = Object.freeze({
  REGISTERED: "registered",
  FULL: "full",
  REJECTED: "rejected",
  MACRO_REQUIRED: "macro_required",
  CAPTCHA_EXHAUSTED: "captcha_exhausted",
  SESSION_EXPIRED: "session_expired",
});

class SugangSessionExpiredError extends Error {
  constructor(operation, message = "Session expired") {
    super(`${operation} reported an invalid session`);
    this.result = {
      kind: SugangRegistrationResultKind.SESSION_EXPIRED,
      state: SugangClientState.EXPIRED,
      code: "999",
      message,
    };
  }
}

function normalizeCourse(course) {
  if (course === undefined || course === null) return null;
  return normalizeSugangCourse(course);
}

function decodePageProof(html) {
  const divider = html.match(/<[^>]*\bid=["']divider["'][^>]*>/i)?.[0];
  if (!divider) throw new Error("Sugang course page is missing its request proof");
  const readAttribute = (name) =>
    divider.match(new RegExp(`\\b${name}=["']([^"']+)["']`, "i"))?.[1];
  const headerName = Buffer.from(readAttribute("data-rn") ?? "", "base64").toString("utf8");
  const headerValue = Buffer.from(readAttribute("data-rv") ?? "", "base64").toString("utf8");
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(headerName) || !headerValue) {
    throw new Error("Sugang course page returned an invalid request proof");
  }
  return Object.freeze({ headerName, headerValue });
}

export class SugangClient {
  #state = SugangClientState.NEW;
  #cookies = new SugangSessionCookies();
  #credentials = null;
  #course;
  #coursePageProof = null;
  #macroPageLoaded = false;
  #macroSolver;
  #maxMacroAttempts;
  #signal;

  constructor({
    course,
    baseUrl = DEFAULT_BASE_URL,
    fetchImpl = fetch,
    timeoutMs = 15_000,
    macroSolver = null,
    maxMacroAttempts = 3,
    signal = null,
  } = {}) {
    if (!Number.isInteger(maxMacroAttempts) || maxMacroAttempts < 1 || maxMacroAttempts > 9) {
      throw new Error("maxMacroAttempts must be from 1 to 9");
    }
    if (macroSolver !== null && typeof macroSolver?.solveMacroChallenge !== "function") {
      throw new Error("macroSolver must provide solveMacroChallenge(gifBytes)");
    }
    if (signal !== null && !(signal instanceof AbortSignal)) {
      throw new Error("signal must be an AbortSignal");
    }
    this.#course = normalizeCourse(course);
    this.#macroSolver = macroSolver;
    this.#maxMacroAttempts = maxMacroAttempts;
    this.#signal = signal;
    this.origin = new URL(baseUrl).origin;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  get state() {
    return this.#state;
  }

  get course() {
    return this.#course;
  }

  async selectCourse(course) {
    if (![SugangClientState.NEW, SugangClientState.READY].includes(this.#state)) {
      throw new Error(`Cannot select a course from ${this.#state} state`);
    }
    this.#course = normalizeCourse(course);
    if (this.#state === SugangClientState.READY && !this.#coursePageProof) {
      await this.#loadCoursePageProof();
    }
    return this.#course;
  }

  async #request(path, { operation, accept = "*/*", headers: inputHeaders, ...requestInit }) {
    const headers = new Headers(inputHeaders);
    headers.set("Accept", accept);
    headers.set("Referer", `${this.origin}/`);
    headers.set("User-Agent", DEFAULT_USER_AGENT);
    const cookie = this.#cookies.header();
    if (cookie) headers.set("Cookie", cookie);

    let response;
    try {
      const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
      const signal = this.#signal
        ? AbortSignal.any([timeoutSignal, this.#signal])
        : timeoutSignal;
      response = await this.fetchImpl(new URL(path, this.origin), {
        ...requestInit,
        headers,
        signal,
      });
    } catch (error) {
      throw new Error(`${operation} failed: ${error.message}`, { cause: error });
    }
    this.#cookies.absorb(response.headers);
    if (!response.ok) {
      await consume(response);
      throw new Error(`${operation} failed with HTTP ${response.status}`);
    }
    return response;
  }

  async open({ id, pwd }) {
    if (this.#state !== SugangClientState.NEW) {
      throw new Error(`Cannot open Sugang client from ${this.#state} state`);
    }
    validateCollectionOptions({ id, pwd, count: 1, delayMs: 0 });
    this.#credentials = Object.freeze({ id: id.trim(), pwd });
    try {
      await this.#login();
    } catch (error) {
      this.#forgetSession();
      this.#state = SugangClientState.NEW;
      throw error;
    }
  }

  async #login() {
    const credentials = this.#credentials;
    if (!credentials) throw new Error("Sugang client has no credentials for login");

    this.#cookies.clear();
    this.#coursePageProof = null;
    this.#macroPageLoaded = false;
    const home = await this.#request("/", { operation: "Session initialization" });
    await consume(home);

    const loginBody = new URLSearchParams({
      txtUserID: credentials.id,
      txtPwd: credentials.pwd,
      pTerm: "",
      lang: "ko",
    });
    const loginResponse = await this.#request(`/d/l/loginCheck?fake=${Date.now()}`, {
      method: "POST",
      body: loginBody,
      accept: "application/json, text/javascript, */*; q=0.01",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        "sg-path": "/",
        "ss_fp": fingerprintHeader(),
      },
      operation: "Login",
    });
    const login = await parseJson(loginResponse, "Login");
    if (login.code !== "200" && login.code !== "201") {
      throw new Error(`Login rejected (code ${login.code ?? "unknown"}): ${login.message || "no message"}`);
    }
    if (this.#course) await this.#loadCoursePageProof();
    this.#state = SugangClientState.READY;
  }

  async #relogin(recovery) {
    if (recovery.remaining === 0) return false;
    recovery.remaining -= 1;
    recovery.renewed = true;
    this.#state = SugangClientState.EXPIRED;
    try {
      await this.#login();
    } catch (error) {
      this.#forgetSession();
      this.#state = SugangClientState.EXPIRED;
      throw error;
    }
    return true;
  }

  async #withSessionRecovery(action) {
    const recovery = { remaining: 1, renewed: false };
    let result;
    try {
      result = await action(recovery);
    } catch (error) {
      if (!(error instanceof SugangSessionExpiredError)) throw error;
      result = error.result;
    }
    return recovery.renewed ? { ...result, sessionRenewed: true } : result;
  }

  async #loadCoursePageProof() {
    const response = await this.#request(`/p/s/sugangMain?fake=${Date.now()}`, {
      method: "POST",
      operation: "Sugang course page initialization",
    });
    let html;
    try {
      html = await response.text();
    } catch (error) {
      throw new Error(`Reading Sugang course page failed: ${error.message}`, { cause: error });
    }
    this.#coursePageProof = decodePageProof(html);
  }

  async #loadMacroPage(recovery) {
    if (this.#macroPageLoaded) return;
    const response = await this.#request(`/p/m/macroMain?fake=${Date.now()}`, {
      method: "POST",
      operation: "Macro page initialization",
    });
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.toLowerCase().includes("application/json")) {
      const result = await parseJson(response, "Macro page initialization");
      if (result.code === "999") {
        this.#state = SugangClientState.EXPIRED;
        if (await this.#relogin(recovery)) return this.#loadMacroPage(recovery);
        throw new SugangSessionExpiredError("Macro page initialization", result.message);
      }
      throw new Error(
        `Macro page initialization rejected (code ${result.code ?? "unknown"}): ${result.message || "no message"}`,
      );
    }
    await consume(response);
    this.#macroPageLoaded = true;
  }

  async #newMacroChallenge(
    operation = "Macro initialization",
    maxReloads = 3,
    recovery,
  ) {
    await this.#loadMacroPage(recovery);
    let macroInit;
    for (let attempt = 0; attempt <= maxReloads; attempt += 1) {
      const response = await this.#request(`/d/m/macroInit?fake=${Date.now()}`, {
        method: "POST",
        accept: "application/json, text/javascript, */*; q=0.01",
        headers: { "X-Requested-With": "XMLHttpRequest" },
        operation,
      });
      macroInit = await parseJson(response, operation);
      if (macroInit.code === "200") break;
      if (macroInit.code === "reload" && attempt < maxReloads) continue;
      if (macroInit.code === "999") {
        this.#state = SugangClientState.EXPIRED;
        if (await this.#relogin(recovery)) {
          return this.#newMacroChallenge(operation, maxReloads, recovery);
        }
        throw new SugangSessionExpiredError(operation, macroInit.message);
      }
      throw new Error(
        `${operation} rejected (code ${macroInit.code ?? "unknown"}): ${macroInit.message || "no message"}`,
      );
    }

    const imageOperation = `${operation} image query`;
    const imageResponse = await this.#request(`/d/m/macroImg?fake=${Date.now()}`, {
      accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      operation: imageOperation,
    });
    const contentType = imageResponse.headers.get("content-type") ?? "";
    if (contentType.toLowerCase().includes("application/json")) {
      const result = await parseJson(imageResponse, imageOperation);
      if (result.code === "999") {
        this.#state = SugangClientState.EXPIRED;
        if (await this.#relogin(recovery)) {
          return this.#newMacroChallenge(operation, maxReloads, recovery);
        }
        throw new SugangSessionExpiredError(imageOperation, result.message);
      }
      throw new Error(
        `${imageOperation} rejected (code ${result.code ?? "unknown"}): ${result.message || "no message"}`,
      );
    }
    let bytes;
    try {
      bytes = Buffer.from(await imageResponse.arrayBuffer());
    } catch (error) {
      throw new Error(`${imageOperation} body failed: ${error.message}`, { cause: error });
    }
    if (!contentType.toLowerCase().includes("image/gif")) {
      throw new Error(`${imageOperation} returned ${contentType || "an unknown content type"}`);
    }
    const image = validateMacroGif(bytes);
    this.#state = SugangClientState.MACRO_REQUIRED;
    return {
      bytes,
      contentType,
      image,
      macroInit,
      fetchedAt: new Date().toISOString(),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }

  async registerCourse({ autoMacro = true } = {}) {
    return this.#withSessionRecovery((recovery) => this.#registerCourse(autoMacro, recovery));
  }

  async #registerCourse(autoMacro, recovery) {
    if (this.#state !== SugangClientState.READY) {
      throw new Error(`Cannot register a course from ${this.#state} state`);
    }
    if (!this.#course) throw new Error("Sugang client has no selected course");
    if (!this.#coursePageProof) await this.#loadCoursePageProof();

    const { headerName, headerValue } = this.#coursePageProof;
    const body = new URLSearchParams({
      params: this.#course.params,
      hp: createHash("sha256")
        .update(`${this.#course.params}@${headerValue}`)
        .digest("hex"),
    });
    const response = await this.#request(`/d/s/add?fake=${Date.now()}`, {
      method: "POST",
      body,
      accept: "application/json, text/javascript, */*; q=0.01",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        [headerName]: headerValue,
      },
      operation: "Course registration",
    });
    const result = await parseJson(response, "Course registration");
    if (result.code === "999") {
      this.#state = SugangClientState.EXPIRED;
      if (await this.#relogin(recovery)) {
        return this.#registerCourse(autoMacro, recovery);
      }
      return {
        kind: SugangRegistrationResultKind.SESSION_EXPIRED,
        state: this.#state,
        code: result.code,
        message: result.message ?? "",
      };
    }
    if (result.code === "118") {
      this.#state = SugangClientState.MACRO_REQUIRED;
      const challenge = await this.#newMacroChallenge("Macro initialization", 3, recovery);
      const required = {
        kind: SugangRegistrationResultKind.MACRO_REQUIRED,
        state: this.#state,
        code: result.code,
        message: result.message ?? "",
        course: this.#course,
        challenge,
      };
      return autoMacro
        ? this.#solveMacroChallenges(challenge, this.#maxMacroAttempts, recovery)
        : required;
    }
    const resultKind = {
      "200": SugangRegistrationResultKind.REGISTERED,
      "500": SugangRegistrationResultKind.REJECTED,
      "501": SugangRegistrationResultKind.FULL,
    }[result.code];
    if (!resultKind) {
      throw new Error(
        `Course registration returned unsupported code ${result.code ?? "unknown"}: ${
          result.message || "no message"
        }`,
      );
    }
    return {
      kind: resultKind,
      state: this.#state,
      outcome: result.code === "200" ? "registered" : "rejected",
      code: result.code,
      message: result.message ?? "",
      course: this.#course,
    };
  }

  #solver() {
    if (!this.#macroSolver) {
      throw new Error("Automatic CAPTCHA handling requires a macroSolver");
    }
    return this.#macroSolver;
  }

  async #solveMacroChallenges(initialChallenge, maxAttempts, recovery) {
    let challenge = initialChallenge;
    const macroAttempts = [];
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const solved = this.#solver().solveMacroChallenge(challenge.bytes);
      const checked = await this.#submitMacroAnswer(solved.answer, false, recovery, {
        initializeRetry: attempt < maxAttempts,
      });
      macroAttempts.push({
        answer: solved.answer,
        ...solved.diagnostics,
        code: checked.macroCheck?.code ?? checked.code,
        failCnt: checked.macroCheck?.failCnt ?? checked.failCnt,
      });
      if (checked.state !== SugangClientState.MACRO_REQUIRED) {
        return { ...checked, macroAttempts };
      }
      challenge = checked.challenge;
    }
    throw new Error("Automatic CAPTCHA handling ended without a result");
  }

  async submitMacroAnswer(answer, { autoMacro = true } = {}) {
    return this.#withSessionRecovery((recovery) =>
      this.#submitMacroAnswer(answer, autoMacro, recovery),
    );
  }

  async #submitMacroAnswer(
    answer,
    autoMacro,
    recovery,
    { initializeRetry = true } = {},
  ) {
    if (this.#state !== SugangClientState.MACRO_REQUIRED) {
      throw new Error(`Cannot submit a macro answer from ${this.#state} state`);
    }
    const secNumber = String(answer ?? "").trim().toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(secNumber)) {
      throw new Error("Macro answer must contain exactly four letters or digits");
    }
    const response = await this.#request(`/d/m/macroCheck?fake=${Date.now()}`, {
      method: "POST",
      body: new URLSearchParams({ secNumber }),
      accept: "application/json, text/javascript, */*; q=0.01",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
      },
      operation: "Macro answer check",
    });
    const result = await parseJson(response, "Macro answer check");
    if (result.code === "200") {
      this.#state = SugangClientState.READY;
      const courseResult = await this.#registerCourse(autoMacro, recovery);
      return {
        ...courseResult,
        macroCheck: { code: result.code, failCnt: result.failCnt },
      };
    }
    if (result.code === "999") {
      this.#state = SugangClientState.EXPIRED;
      if (await this.#relogin(recovery)) {
        if (this.#course) {
          return {
            ...(await this.#registerCourse(autoMacro, recovery)),
            macroCheck: { code: result.code, failCnt: result.failCnt },
          };
        }
        return {
          kind: SugangRegistrationResultKind.MACRO_REQUIRED,
          state: SugangClientState.MACRO_REQUIRED,
          code: "118",
          message: "Session renewed; the previous macro challenge expired",
          challenge: await this.#newMacroChallenge("Macro renewal initialization", 3, recovery),
        };
      }
      return {
        kind: SugangRegistrationResultKind.SESSION_EXPIRED,
        state: this.#state,
        code: result.code,
        message: result.message ?? "",
      };
    }
    if (result.code !== "500") {
      throw new Error(
        `Macro answer check rejected (code ${result.code ?? "unknown"}): ${
          result.message || "no message"
        }`,
      );
    }
    const serverAttemptsRemaining =
      typeof result.failCnt === "number" && Number.isInteger(result.failCnt)
        ? result.failCnt
        : typeof result.failCnt === "string" && /^\d+$/.test(result.failCnt)
          ? Number(result.failCnt)
          : null;
    const serverAllowsRetry =
      serverAttemptsRemaining === null || serverAttemptsRemaining > 0;
    if (!initializeRetry || !serverAllowsRetry) {
      this.#state = SugangClientState.READY;
      return {
        kind: SugangRegistrationResultKind.CAPTCHA_EXHAUSTED,
        state: this.#state,
        outcome: "captcha_exhausted",
        code: result.code,
        message: result.message ?? "CAPTCHA attempts exhausted",
        failCnt: result.failCnt,
        course: this.#course,
      };
    }
    const challenge = await this.#newMacroChallenge("Macro retry initialization", 3, recovery);
    const retry = {
      kind: SugangRegistrationResultKind.MACRO_REQUIRED,
      state: this.#state,
      code: result.code,
      message: result.message ?? "",
      failCnt: result.failCnt,
      course: this.#course,
      challenge,
    };
    return autoMacro
      ? this.#solveMacroChallenges(challenge, this.#maxMacroAttempts, recovery)
      : retry;
  }

  async fetchSample(index, count, maxReloads = 3) {
    if (this.#course) {
      throw new Error("Cannot collect macro samples from a course-registration client");
    }
    if (![SugangClientState.READY, SugangClientState.MACRO_REQUIRED].includes(this.#state)) {
      throw new Error(`Cannot fetch a macro sample from ${this.#state} state`);
    }
    if (!Number.isInteger(maxReloads) || maxReloads < 0 || maxReloads > 9) {
      throw new Error("maxReloads must be an integer from 0 to 9");
    }
    return this.#withSessionRecovery((recovery) =>
      this.#newMacroChallenge(`Macro initialization ${index}/${count}`, maxReloads, recovery),
    );
  }

  #forgetSession() {
    this.#credentials = null;
    this.#cookies.clear();
    this.#coursePageProof = null;
    this.#macroPageLoaded = false;
  }

  dispose() {
    this.#state = SugangClientState.CLOSED;
    this.#forgetSession();
    this.#macroSolver = null;
    this.#signal = null;
  }

  async close() {
    if ([SugangClientState.NEW, SugangClientState.CLOSED].includes(this.#state)) {
      this.dispose();
      return Object.freeze({ loggedOut: false, error: null });
    }
    let error = null;
    try {
      const response = await this.#request(
        `/p/l/logOut?sgPath=${encodeURIComponent("/")}&fake=${Date.now()}`,
        { operation: "Logout" },
      );
      await consume(response);
    } catch (closeError) {
      error = closeError;
    } finally {
      this.dispose();
    }
    return Object.freeze({ loggedOut: error === null, error });
  }
}

export async function* streamMacroSamples(options) {
  const { id, pwd, count = 1, delayMs = 250 } = options;
  validateCollectionOptions({ id, pwd, count, delayMs });
  if (options.course !== undefined && options.course !== null) {
    throw new Error("Macro sample collection cannot own a registration course");
  }
  const session = new SugangClient(options);
  try {
    await session.open({ id, pwd });
    for (let index = 1; index <= count; index += 1) {
      if (index > 1 && delayMs > 0) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
      }
      const sample = await session.fetchSample(index, count);
      if (sample.state === SugangClientState.EXPIRED) {
        throw new SugangSessionExpiredError("Macro sample collection", sample.message);
      }
      yield sample;
    }
  } finally {
    await session.close();
  }
}

export async function fetchMacroSample(options) {
  for await (const sample of streamMacroSamples({ ...options, count: 1, delayMs: 0 })) {
    return sample;
  }
  throw new Error("The server returned no macro sample");
}

async function hiddenPasswordPrompt(prompt = "Password: ") {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Missing LMS_PWD and no interactive terminal is available");
  }
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  return new Promise((resolvePassword, rejectPassword) => {
    let password = "";
    const finish = (error) => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      if (error) rejectPassword(error);
      else resolvePassword(password);
    };
    const onData = (input) => {
      for (const char of input) {
        if (char === "\r" || char === "\n") return finish();
        if (char === "\u0003") return finish(new Error("Password input cancelled"));
        if (char === "\u007f" || char === "\b") password = password.slice(0, -1);
        else if (char >= " ") password += char;
      }
    };
    process.stdin.on("data", onData);
  });
}

async function prepareOutput(options) {
  const timestamp = new Date().toISOString().replaceAll(":", "-").replace(".", "-");
  if (options.count === 1 && !options.outDir) {
    const path = resolve(options.out ?? `samples/macro-${timestamp}.gif`);
    await mkdir(dirname(path), { recursive: true });
    const handle = await open(path, "wx", 0o600);
    let written = false;
    return {
      path,
      async write(_index, sample) {
        await handle.writeFile(sample.bytes);
        written = true;
      },
      async finish() {
        await handle.close();
      },
      async fail() {
        await handle.close().catch(() => {});
        if (!written) await unlink(path).catch(() => {});
      },
    };
  }

  const directory = resolve(options.outDir ?? `samples/macro-${timestamp}`);
  await mkdir(dirname(directory), { recursive: true });
  await mkdir(directory, { mode: 0o700 });
  const manifestPath = resolve(directory, "manifest.jsonl");
  const manifest = await open(manifestPath, "wx", 0o600);
  await manifest.appendFile(
    `${JSON.stringify({ type: "batch", status: "started", requested: options.count, at: new Date().toISOString() })}\n`,
  );

  return {
    path: directory,
    async write(index, sample) {
      const filename = `${String(index).padStart(3, "0")}.gif`;
      const file = await open(resolve(directory, filename), "wx", 0o600);
      try {
        await file.writeFile(sample.bytes);
      } finally {
        await file.close();
      }
      await manifest.appendFile(
        `${JSON.stringify({
          type: "sample",
          index,
          filename,
          sha256: sample.sha256,
          bytes: sample.bytes.length,
          width: sample.image.width,
          height: sample.image.height,
          fetchedAt: sample.fetchedAt,
          failCnt: sample.macroInit.failCnt,
        })}\n`,
      );
    },
    async finish(saved) {
      await manifest.appendFile(
        `${JSON.stringify({ type: "batch", status: "complete", saved, at: new Date().toISOString() })}\n`,
      );
      await manifest.close();
    },
    async fail(error, saved) {
      await manifest.appendFile(
        `${JSON.stringify({ type: "batch", status: "failed", saved, error: error.message, at: new Date().toISOString() })}\n`,
      ).catch(() => {});
      await manifest.close().catch(() => {});
    },
  };
}

function usage() {
  return `Usage:
  node src/client.js --id <student-id> [--out <file.gif>]
  node src/client.js --id <student-id> --count <n> --out-dir <new-directory>

The password is read from LMS_PWD or requested through a hidden terminal prompt.

Options:
  --count <n>       Number of GIFs, from 1 to 100 (default: 1)
  --delay-ms <ms>   Delay between GIF requests (default: 250)
  --out <file>      Output file when count is 1
  --out-dir <dir>   New output directory for a batch

Each sample is validated and persisted immediately. No answer is submitted.`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  options.pwd ??= await hiddenPasswordPrompt();
  validateCollectionOptions(options);

  const output = await prepareOutput(options);
  let saved = 0;
  try {
    for await (const sample of streamMacroSamples(options)) {
      const index = saved + 1;
      await output.write(index, sample);
      saved = index;
    }
    await output.finish(saved);
  } catch (error) {
    await output.fail(error, saved);
    throw error;
  }
  console.log(`Saved ${saved} macro sample${saved === 1 ? "" : "s"} to ${output.path}`);
}

const isEntryPoint =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isEntryPoint) {
  main().catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
}
