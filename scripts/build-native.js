#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const crate = resolve(root, "native/sugang-captcha-recognizer-core/Cargo.toml");
const target = resolve(root, "native/sugang-captcha-recognizer-core/target/release");
const outputDirectory = resolve(root, "build");
const output = resolve(outputDirectory, "sugang_captcha_recognizer.node");
const require = createRequire(import.meta.url);
const buildInputs = [
  resolve(root, "scripts/build-native.js"),
  resolve(root, "native/addon.cc"),
  resolve(root, "native/sugang-captcha-recognizer-core/Cargo.toml"),
  resolve(root, "native/sugang-captcha-recognizer-core/Cargo.lock"),
  resolve(root, "native/sugang-captcha-recognizer-core/include/sugang_captcha_recognizer.h"),
  resolve(root, "native/sugang-captcha-recognizer-core/src/lib.rs"),
];
let currentAddonLoads = false;
if (existsSync(output)) {
  try {
    currentAddonLoads = require(output).abiVersion === 1;
  } catch {
    currentAddonLoads = false;
  }
}
if (
  currentAddonLoads &&
  buildInputs.every((input) => statSync(input).mtimeMs <= statSync(output).mtimeMs)
) {
  console.log(`Native CAPTCHA recognizer is up to date: ${output}`);
  process.exit(0);
}
const nodePrefix = process.config.variables.node_prefix;
const includeCandidates = [
  nodePrefix && resolve(nodePrefix, "include/node"),
  resolve(dirname(process.execPath), "../include/node"),
].filter(Boolean);
const nodeInclude = includeCandidates.find((candidate) =>
  existsSync(resolve(candidate, "node_api.h")),
);
if (!nodeInclude) throw new Error("Could not find the Node.js N-API headers");

execFileSync("cargo", ["build", "--release", "--manifest-path", crate], {
  cwd: root,
  stdio: "inherit",
});
mkdirSync(outputDirectory, { recursive: true });

const library = resolve(target, "libsugang_captcha_recognizer_core.a");
const common = [
  "-std=c++17",
  "-O3",
  `-I${nodeInclude}`,
  `-I${resolve(root, "native/sugang-captcha-recognizer-core/include")}`,
  resolve(root, "native/addon.cc"),
  library,
  "-o",
  output,
];
const platformArgs =
  process.platform === "darwin"
    ? ["-bundle", "-undefined", "dynamic_lookup"]
    : ["-shared", "-fPIC"];
execFileSync(process.env.CXX || "c++", [...common, ...platformArgs], {
  cwd: root,
  stdio: "inherit",
});
console.log(`Built ${output}`);
