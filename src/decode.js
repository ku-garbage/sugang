#!/usr/bin/env node

import { existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  SugangCaptchaTemplateConfig,
  createSugangCaptchaTemplates,
} from "./captcha/templates.js";
import {
  createSugangCaptchaRecognizer,
  formatSugangCaptchaRecognition,
} from "./captcha/recognizer.js";

function parseArgs(argv) {
  const options = { candidateLimit: 3, json: false, paths: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--json") options.json = true;
    else if (argument === "--candidate-limit") {
      options.candidateLimit = Number(argv[++index]);
    } else if (argument.startsWith("--")) {
      throw new Error(`Unknown argument: ${argument}`);
    } else {
      options.paths.push(resolve(argument));
    }
  }
  if (!options.help && options.paths.length === 0) {
    throw new Error("Provide at least one Sugang CAPTCHA image path");
  }
  if (
    !Number.isInteger(options.candidateLimit) ||
    options.candidateLimit < 2 ||
    options.candidateLimit > 100
  ) {
    throw new Error("--candidate-limit must be from 2 to 100");
  }
  return options;
}

function usage() {
  return `Usage:
  npm run decode -- [--candidate-limit n] [--json] <image.gif> [more-images...]

Ranks exact Sugang CAPTCHA answer alignments with the native Rust recognizer.`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  for (const path of options.paths) {
    if (!existsSync(path)) throw new Error(`Image not found: ${path}`);
  }
  const templates = createSugangCaptchaTemplates(new SugangCaptchaTemplateConfig());
  const recognizer = createSugangCaptchaRecognizer(templates);
  try {
    const images = options.paths.map((path) =>
      recognizer.rankCaptchaImage(path, { candidateLimit: options.candidateLimit }),
    );
    if (options.json) {
      console.log(JSON.stringify({ templates: templates.provenance, images }, null, 2));
      return;
    }
    for (const image of images) console.log(formatSugangCaptchaRecognition(image));
  } finally {
    recognizer.close();
  }
}

try {
  main();
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
}
