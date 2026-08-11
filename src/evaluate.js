#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createSugangCaptchaTemplates } from "./captcha/templates.js";
import { createSugangCaptchaRecognizer } from "./captcha/recognizer.js";

export async function readLabelManifest(path) {
  const text = await readFile(path, "utf8");
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSON on manifest line ${index + 1}`, { cause: error });
      }
      if (!/^\d{3}\.gif$/.test(entry.filename)) throw new Error(`Invalid filename on line ${index + 1}`);
      if (!/^[A-Z0-9]{4}$/.test(entry.label)) throw new Error(`Invalid label on line ${index + 1}`);
      if (!/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error(`Invalid SHA-256 on line ${index + 1}`);
      if (!entry.labelSource) throw new Error(`Missing labelSource on line ${index + 1}`);
      return entry;
    });
}

function addResult(summary, source, correct) {
  const group = summary[source] ?? { correct: 0, total: 0 };
  group.total += 1;
  if (correct) group.correct += 1;
  summary[source] = group;
}

export async function evaluateManifest(manifestPath, recognizer) {
  const manifest = await readLabelManifest(manifestPath);
  const directory = dirname(manifestPath);
  const summary = {};
  const results = [];
  const unique = new Map();

  for (const entry of manifest) {
    const imagePath = resolve(directory, entry.filename);
    const bytes = await readFile(imagePath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== entry.sha256) throw new Error(`Hash mismatch for ${entry.filename}`);

    const recognition = recognizer.rankCaptchaImage(imagePath, { candidateLimit: 3 });
    const prediction = recognition.candidates[0].answer;
    const correct = prediction === entry.label;
    addResult(summary, "all_files", correct);
    addResult(summary, entry.labelSource, correct);
    if (!unique.has(sha256)) {
      unique.set(sha256, true);
      addResult(summary, "unique_images", correct);
    }
    results.push({
      ...entry,
      prediction,
      correct,
      mismatchedPixelCount: recognition.candidates[0].mismatchedPixelCount,
      runnerUpMismatchGap: recognition.runnerUpMismatchGap,
      glyphOriginsX: recognition.candidates[0].glyphOriginsX,
    });
  }
  return { templates: recognizer.provenance, summary, results };
}

async function main() {
  const args = process.argv.slice(2);
  const jsonIndex = args.indexOf("--json");
  const json = jsonIndex >= 0;
  if (json) args.splice(jsonIndex, 1);
  if (args.length > 1) throw new Error("Usage: node src/evaluate.js [manifest.jsonl] [--json]");
  const manifestPath = resolve(
    args[0] ?? fileURLToPath(new URL("../samples/test-50-20260811/labels.jsonl", import.meta.url)),
  );
  const recognizer = createSugangCaptchaRecognizer(createSugangCaptchaTemplates());
  let evaluation;
  try {
    evaluation = await evaluateManifest(manifestPath, recognizer);
  } finally {
    recognizer.close();
  }
  if (json) {
    console.log(JSON.stringify(evaluation, null, 2));
    return;
  }
  console.log(`Manifest: ${manifestPath}`);
  for (const [source, result] of Object.entries(evaluation.summary)) {
    const percentage = ((100 * result.correct) / result.total).toFixed(1);
    console.log(`${source}: ${result.correct}/${result.total} (${percentage}%)`);
  }
  const failures = evaluation.results.filter((result) => !result.correct);
  for (const failure of failures) {
    console.log(`${failure.filename}: expected=${failure.label} predicted=${failure.prediction}`);
  }
}

const isEntryPoint =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isEntryPoint) {
  main().catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
}
