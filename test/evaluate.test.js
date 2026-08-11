import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import test from "node:test";

import { evaluateManifest, readLabelManifest } from "../src/evaluate.js";
import { createSugangCaptchaTemplates } from "../src/captcha/templates.js";
import { createSugangCaptchaRecognizer } from "../src/captcha/recognizer.js";

const manifestPath = new URL("../samples/test-50-20260811/labels.jsonl", import.meta.url).pathname;

test("labeled corpus records label provenance and one duplicate explicitly", async () => {
  const manifest = await readLabelManifest(manifestPath);
  assert.equal(manifest.length, 50);
  assert.equal(manifest.filter((entry) => entry.labelSource === "manual_edge_review").length, 14);
  assert.equal(manifest.filter((entry) => entry.labelSource === "tesseract_consensus").length, 36);
  assert.equal(new Set(manifest.map((entry) => entry.sha256)).size, 49);
});

const font = "/System/Library/Fonts/Supplemental/Times New Roman Bold.ttf";
const hasMagick = spawnSync("magick", ["-version"], { stdio: "ignore" }).status === 0;

test(
  "exact decoder reproduces the hybrid-labeled corpus result",
  { skip: !existsSync(font) || !hasMagick },
  async () => {
    const recognizer = createSugangCaptchaRecognizer(
      createSugangCaptchaTemplates({ fontPath: font, imageMagickCommand: "magick" }),
    );
    try {
      const evaluation = await evaluateManifest(manifestPath, recognizer);
      assert.deepEqual(evaluation.summary.all_files, { correct: 50, total: 50 });
      assert.deepEqual(evaluation.summary.unique_images, { correct: 49, total: 49 });
      assert.deepEqual(evaluation.summary.manual_edge_review, { correct: 14, total: 14 });
      assert.deepEqual(evaluation.summary.tesseract_consensus, { correct: 36, total: 36 });
    } finally {
      recognizer.close();
    }
  },
);
