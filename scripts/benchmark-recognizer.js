#!/usr/bin/env node

import { performance } from "node:perf_hooks";
import { resolve } from "node:path";

import {
  createSugangCaptchaTemplates,
  readSugangCaptchaMask,
} from "../src/captcha/templates.js";
import { createSugangCaptchaRecognizer } from "../src/captcha/recognizer.js";

function percentile(sortedValues, fraction) {
  return sortedValues[Math.min(sortedValues.length - 1, Math.floor(sortedValues.length * fraction))];
}

const imagePath = resolve(process.argv[2] ?? "samples/test-50-20260811/001.gif");
const iterationCount = Number(process.argv[3] ?? 5_000);
if (!Number.isInteger(iterationCount) || iterationCount < 1) {
  throw new Error("Iteration count must be a positive integer");
}

const templateStart = performance.now();
const templates = createSugangCaptchaTemplates();
const templateLoadMs = performance.now() - templateStart;
const observedMask = readSugangCaptchaMask(imagePath, templates.profile);
const recognizer = createSugangCaptchaRecognizer(templates);
try {
  for (let index = 0; index < 100; index += 1) {
    recognizer.rankCaptchaAnswers(observedMask, { candidateLimit: 3 });
  }
  const samples = [];
  for (let index = 0; index < iterationCount; index += 1) {
    const started = performance.now();
    recognizer.rankCaptchaAnswers(observedMask, { candidateLimit: 3 });
    samples.push(performance.now() - started);
  }
  samples.sort((left, right) => left - right);
  console.log(
    JSON.stringify(
      {
        templateLoadMs,
        iterations: iterationCount,
        medianMs: percentile(samples, 0.5),
        p95Ms: percentile(samples, 0.95),
        p99Ms: percentile(samples, 0.99),
        minMs: samples[0],
        maxMs: samples.at(-1),
      },
      null,
      2,
    ),
  );
} finally {
  recognizer.close();
}
