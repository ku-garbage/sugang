import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  SugangCaptchaTemplateConfig,
  SugangCaptchaTemplates,
  createSugangCaptchaTemplates,
} from "../src/captcha/templates.js";
import {
  createSugangCaptchaRecognizer,
  nativeSugangCaptchaRecognizerStatus,
} from "../src/captcha/recognizer.js";

function toyTemplates({ glyphAdvanceTolerancePx = 0 } = {}) {
  const profile = new SugangCaptchaTemplateConfig({
    maskWidthPx: 8,
    maskHeightPx: 3,
    glyphTemplateAnchorXPx: 0,
    fontPath: "unused.ttf",
    fontPointSize: 1,
    textBaselineYPx: 1,
    answerAlphabet: "AB",
    answerLength: 2,
    firstGlyphOriginXMinPx: 1,
    firstGlyphOriginXMaxPx: 1,
    glyphAdvanceTolerancePx,
    imageMagickCommand: "unused",
  });
  const a = new Uint8Array(24);
  a[1 * 8] = 1;
  a[1 * 8 + 1] = 1;
  const b = new Uint8Array(24);
  b[1 * 8] = 1;
  b[2 * 8 + 1] = 1;
  return new SugangCaptchaTemplates(profile, {}, [a, b], [3, 3]);
}

function place(mask, glyphMask, profile, glyphOriginX) {
  for (let y = 0; y < profile.maskHeightPx; y += 1) {
    for (let x = 0; x < profile.maskWidthPx; x += 1) {
      const templateX = x - glyphOriginX + profile.glyphTemplateAnchorXPx;
      if (
        templateX >= 0 &&
        templateX < profile.maskWidthPx &&
        glyphMask[y * profile.maskWidthPx + templateX]
      ) {
        mask[y * profile.maskWidthPx + x] = 1;
      }
    }
  }
}

test("native recognizer gives a perfect aligned mask zero mismatch", () => {
  const templates = toyTemplates();
  const observed = new Uint8Array(24);
  place(observed, templates.glyphMask("A"), templates.profile, 1);
  place(observed, templates.glyphMask("B"), templates.profile, 4);

  const recognizer = createSugangCaptchaRecognizer(templates);
  try {
    const candidates = recognizer.rankCaptchaAnswers(observed, { candidateLimit: 2 });
    assert.deepEqual(candidates[0], {
      answer: "AB",
      glyphOriginsX: [1, 4],
      mismatchedPixelCount: 0,
    });
    assert.ok(candidates[1].mismatchedPixelCount > 0);
  } finally {
    recognizer.close();
  }
});

test("advance slop includes values below the charset minimum advance", () => {
  const templates = toyTemplates({ glyphAdvanceTolerancePx: 2 });
  const observed = new Uint8Array(24);
  place(observed, templates.glyphMask("A"), templates.profile, 1);
  place(observed, templates.glyphMask("B"), templates.profile, 2);

  const recognizer = createSugangCaptchaRecognizer(templates);
  try {
    const candidates = recognizer.rankCaptchaAnswers(observed, { candidateLimit: 2 });
    assert.equal(candidates[0].answer, "AB");
    assert.deepEqual(candidates[0].glyphOriginsX, [1, 2]);
    assert.equal(candidates[0].mismatchedPixelCount, 0);
  } finally {
    recognizer.close();
  }
});

test("template and candidate settings reject invalid ranges", () => {
  assert.throws(
    () =>
      new SugangCaptchaTemplateConfig({
        firstGlyphOriginXMinPx: 30,
        firstGlyphOriginXMaxPx: 20,
      }),
    /origin range/,
  );
  const recognizer = createSugangCaptchaRecognizer(toyTemplates());
  try {
    assert.throws(
      () => recognizer.rankCaptchaAnswers(new Uint8Array(24), { candidateLimit: 0 }),
      /candidateLimit/,
    );
  } finally {
    recognizer.close();
  }
});

test("native ABI is mandatory and close is deterministic", () => {
  assert.deepEqual(nativeSugangCaptchaRecognizerStatus(), { available: true, abiVersion: 1 });
  const recognizer = createSugangCaptchaRecognizer(toyTemplates());
  recognizer.close();
  recognizer.close();
  assert.throws(() => recognizer.rankCaptchaAnswers(new Uint8Array(24)), /closed/);
});

const font = "/System/Library/Fonts/Supplemental/Times New Roman Bold.ttf";
const sample = new URL("../samples/macro-vl7x.png", import.meta.url).pathname;
const gifSample = new URL("../samples/test-50-20260811/001.gif", import.meta.url).pathname;
const hasMagick = spawnSync("magick", ["-version"], { stdio: "ignore" }).status === 0;
const hasFixtureDependencies = existsSync(font) && hasMagick;
let cachedTemplates;

function fixtureTemplates() {
  cachedTemplates ??= createSugangCaptchaTemplates({
    fontPath: font,
    imageMagickCommand: "magick",
  });
  return cachedTemplates;
}

test(
  "exact decoder recovers the labeled VL7X fixture with recorded provenance",
  { skip: !hasFixtureDependencies },
  () => {
    const templates = fixtureTemplates();
    const recognizer = createSugangCaptchaRecognizer(templates);
    try {
      const recognition = recognizer.rankCaptchaImage(sample, { candidateLimit: 3 });
      assert.equal(recognition.candidates[0].answer, "VL7X");
      assert.ok(recognition.candidates[0].mismatchedPixelCount <= 10);
      assert.ok(recognition.runnerUpMismatchGap >= 20);
      assert.equal(recognition.candidates[0].glyphOriginsX.length, 4);
      assert.match(templates.provenance.fontSha256, /^[a-f0-9]{64}$/);
      assert.match(templates.provenance.renderer, /^Version: ImageMagick/);
    } finally {
      recognizer.close();
    }
  },
);

test(
  "perfect nominal AAAA composition has zero scoring error",
  { skip: !hasFixtureDependencies },
  () => {
    const source = fixtureTemplates();
    const observed = new Uint8Array(
      source.profile.maskWidthPx * source.profile.maskHeightPx,
    );
    let glyphOriginX = 20;
    for (const char of "AAAA") {
      place(observed, source.glyphMask(char), source.profile, glyphOriginX);
      glyphOriginX += source.glyphAdvancePx(char);
    }
    const config = new SugangCaptchaTemplateConfig({
      ...source.profile,
      answerAlphabet: "AB",
      firstGlyphOriginXMinPx: 20,
      firstGlyphOriginXMaxPx: 20,
      glyphAdvanceTolerancePx: 0,
    });
    const templates = new SugangCaptchaTemplates(
      config,
      source.provenance,
      [source.glyphMask("A"), source.glyphMask("B")],
      [source.glyphAdvancePx("A"), source.glyphAdvancePx("B")],
    );
    const recognizer = createSugangCaptchaRecognizer(templates);
    try {
      const candidates = recognizer.rankCaptchaAnswers(observed, { candidateLimit: 2 });
      assert.equal(candidates[0].answer, "AAAA");
      assert.equal(candidates[0].mismatchedPixelCount, 0);
    } finally {
      recognizer.close();
    }
  },
);

test(
  "recognizer accepts the GIF bytes returned by the Sugang client",
  { skip: !hasFixtureDependencies },
  () => {
    const recognizer = createSugangCaptchaRecognizer(fixtureTemplates());
    try {
      const recognition = recognizer.rankCaptchaGif(readFileSync(gifSample), {
        candidateLimit: 3,
      });
      assert.equal(recognition.candidates[0].answer, "A7HT");
      assert.equal(recognition.candidates[0].mismatchedPixelCount, 4);
      assert.deepEqual(recognizer.solveMacroChallenge(readFileSync(gifSample)), {
        answer: "A7HT",
        diagnostics: {
          mismatchedPixelCount: 4,
          runnerUpMismatchGap: recognition.runnerUpMismatchGap,
          glyphOriginsX: recognition.candidates[0].glyphOriginsX,
        },
      });
    } finally {
      recognizer.close();
    }
  },
);

test(
  "template cache rejects and repairs a corrupted mask payload",
  { skip: !hasFixtureDependencies },
  () => {
    const cacheDirectory = mkdtempSync(join(tmpdir(), "sugang-template-cache-"));
    try {
      const options = {
        fontPath: font,
        imageMagickCommand: "magick",
        cacheDirectory,
      };
      const originalTemplates = createSugangCaptchaTemplates(options);
      const cachePath = join(cacheDirectory, readdirSync(cacheDirectory)[0]);
      const originalCache = readFileSync(cachePath);
      const corruptedCache = Buffer.from(originalCache);
      corruptedCache[corruptedCache.length - 1] ^= 1;
      writeFileSync(cachePath, corruptedCache);

      const repairedTemplates = createSugangCaptchaTemplates(options);

      assert.deepEqual(
        repairedTemplates.glyphMask("9"),
        originalTemplates.glyphMask("9"),
      );
      assert.deepEqual(readFileSync(cachePath), originalCache);
    } finally {
      rmSync(cacheDirectory, { recursive: true, force: true });
    }
  },
);
