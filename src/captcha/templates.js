import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const DEFAULT_FONT_PATH =
  "/System/Library/Fonts/Supplemental/Times New Roman Bold.ttf";
const DEFAULT_ANSWER_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const CACHE_MAGIC = Buffer.from("SGATLS2\n", "ascii");

function defaultCacheDirectory(env = process.env, platform = process.platform) {
  if (platform === "darwin") {
    return join(homedir(), "Library", "Caches", "sugang-client", "captcha-templates");
  }
  if (platform === "win32") {
    const base = env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    return join(base, "sugang-client", "captcha-templates");
  }
  return join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "sugang-client", "captcha-templates");
}

const DEFAULT_CACHE_DIRECTORY = defaultCacheDirectory();

export class SugangCaptchaTemplateConfig {
  constructor({
    maskWidthPx = 100,
    maskHeightPx = 100,
    glyphTemplateAnchorXPx = 10,
    fontPath = DEFAULT_FONT_PATH,
    fontPointSize = 24,
    textBaselineYPx = 60,
    answerAlphabet = DEFAULT_ANSWER_ALPHABET,
    answerLength = 4,
    firstGlyphOriginXMinPx = 18,
    firstGlyphOriginXMaxPx = 22,
    glyphAdvanceTolerancePx = 2,
    imageMagickCommand = "magick",
  } = {}) {
    const positiveIntegers = {
      maskWidthPx,
      maskHeightPx,
      fontPointSize,
      answerLength,
    };
    for (const [name, value] of Object.entries(positiveIntegers)) {
      if (!Number.isInteger(value) || value < 1) {
        throw new Error(`${name} must be a positive integer`);
      }
    }
    if (maskWidthPx > 512) throw new Error("maskWidthPx must not exceed 512");
    if (maskHeightPx > 128) throw new Error("maskHeightPx must not exceed 128");
    if (answerLength < 2 || answerLength > 8) {
      throw new Error("answerLength must be from 2 to 8");
    }
    if (
      !Number.isInteger(glyphTemplateAnchorXPx) ||
      glyphTemplateAnchorXPx < 0 ||
      glyphTemplateAnchorXPx >= maskWidthPx
    ) {
      throw new Error("glyphTemplateAnchorXPx must be inside the mask");
    }
    if (
      !Number.isInteger(textBaselineYPx) ||
      textBaselineYPx < 0 ||
      textBaselineYPx >= maskHeightPx
    ) {
      throw new Error("textBaselineYPx must be inside the mask");
    }
    if (
      !Number.isInteger(firstGlyphOriginXMinPx) ||
      !Number.isInteger(firstGlyphOriginXMaxPx) ||
      firstGlyphOriginXMinPx > firstGlyphOriginXMaxPx ||
      firstGlyphOriginXMinPx < 0 ||
      firstGlyphOriginXMaxPx >= maskWidthPx
    ) {
      throw new Error("first glyph origin range must be inside the mask");
    }
    if (
      !Number.isInteger(glyphAdvanceTolerancePx) ||
      glyphAdvanceTolerancePx < 0 ||
      glyphAdvanceTolerancePx > 10
    ) {
      throw new Error("glyphAdvanceTolerancePx must be from 0 to 10");
    }
    if (
      !/^[A-Z0-9]+$/.test(answerAlphabet) ||
      answerAlphabet.length < 2 ||
      answerAlphabet.length > 64 ||
      new Set(answerAlphabet).size !== answerAlphabet.length
    ) {
      throw new Error("answerAlphabet must contain 2..64 unique uppercase letters and digits");
    }
    if (typeof fontPath !== "string" || !fontPath) throw new Error("fontPath is required");
    if (typeof imageMagickCommand !== "string" || !imageMagickCommand) {
      throw new Error("imageMagickCommand is required");
    }
    Object.assign(this, {
      maskWidthPx,
      maskHeightPx,
      glyphTemplateAnchorXPx,
      fontPath,
      fontPointSize,
      textBaselineYPx,
      answerAlphabet,
      answerLength,
      firstGlyphOriginXMinPx,
      firstGlyphOriginXMaxPx,
      glyphAdvanceTolerancePx,
      imageMagickCommand,
    });
    Object.freeze(this);
  }
}

function runImageMagick(command, args, operation, options = {}) {
  try {
    return execFileSync(command, args, { maxBuffer: 2 * 1024 * 1024, ...options });
  } catch (error) {
    throw new Error(`${operation} failed: ${error.message}`, { cause: error });
  }
}

function parseAsciiPbm(buffer, profile) {
  const tokens = buffer
    .toString("ascii")
    .replace(/#[^\r\n]*/g, " ")
    .trim()
    .split(/\s+/);
  if (tokens[0] !== "P1") throw new Error("ImageMagick did not return an ASCII PBM mask");
  const width = Number(tokens[1]);
  const height = Number(tokens[2]);
  if (width !== profile.maskWidthPx || height !== profile.maskHeightPx) {
    throw new Error(
      `Expected a ${profile.maskWidthPx}x${profile.maskHeightPx} mask, received ${width}x${height}`,
    );
  }
  const pixels = Uint8Array.from(tokens.slice(3), Number);
  if (
    pixels.length !== width * height ||
    pixels.some((pixel) => pixel !== 0 && pixel !== 1)
  ) {
    throw new Error("PBM mask contains invalid pixels");
  }
  return pixels;
}

function renderGlyphMask(answerByte, profile) {
  return parseAsciiPbm(
    runImageMagick(
      profile.imageMagickCommand,
      [
        "-size",
        `${profile.maskWidthPx}x${profile.maskHeightPx}`,
        "xc:white",
        "-font",
        profile.fontPath,
        "-pointsize",
        String(profile.fontPointSize),
        "+antialias",
        "-fill",
        "black",
        "-draw",
        `text ${profile.glyphTemplateAnchorXPx},${profile.textBaselineYPx} '${answerByte}'`,
        "-compress",
        "none",
        "pbm:-",
      ],
      `Rendering Sugang glyph ${answerByte}`,
    ),
    profile,
  );
}

function measureGlyphAdvancePx(answerByte, profile) {
  const result = spawnSync(
    profile.imageMagickCommand,
    [
      "-debug",
      "annotate",
      "-font",
      profile.fontPath,
      "-pointsize",
      String(profile.fontPointSize),
      "xc:white",
      "-annotate",
      "+0+0",
      answerByte,
      "null:",
    ],
    { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 },
  );
  if (result.error) {
    throw new Error(`Measuring Sugang glyph ${answerByte} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`Measuring Sugang glyph ${answerByte} failed with status ${result.status}`);
  }
  const match = `${result.stdout}\n${result.stderr}`.match(/origin:\s*([+-]?[0-9.]+),/);
  if (!match) throw new Error(`Could not read glyph advance for ${answerByte}`);
  const glyphAdvancePx = Math.round(Number(match[1]));
  if (!Number.isInteger(glyphAdvancePx) || glyphAdvancePx < 1 || glyphAdvancePx > 0xffff) {
    throw new Error(`Glyph ${answerByte} has an invalid advance`);
  }
  return glyphAdvancePx;
}

function imageMagickVersion(profile) {
  return runImageMagick(
    profile.imageMagickCommand,
    ["-version"],
    "Reading ImageMagick version",
  )
    .toString("utf8")
    .split(/\r?\n/, 1)[0];
}

export class SugangCaptchaTemplates {
  #glyphMasks;
  #glyphAdvancesPx;

  constructor(profile, provenance, glyphMasks, glyphAdvancesPx) {
    this.profile = profile;
    this.provenance = Object.freeze(provenance);
    this.#glyphMasks = glyphMasks.map((mask) => Uint8Array.from(mask));
    this.#glyphAdvancesPx = Uint16Array.from(glyphAdvancesPx);
    Object.freeze(this);
  }

  glyphMask(answerByte) {
    const glyphIndex = this.profile.answerAlphabet.indexOf(answerByte);
    if (glyphIndex < 0) throw new Error(`CAPTCHA templates do not contain ${answerByte}`);
    return this.#glyphMasks[glyphIndex].slice();
  }

  glyphAdvancePx(answerByte) {
    const glyphIndex = this.profile.answerAlphabet.indexOf(answerByte);
    if (glyphIndex < 0) throw new Error(`CAPTCHA templates do not contain ${answerByte}`);
    return this.#glyphAdvancesPx[glyphIndex];
  }
}

function captchaTemplatePayloadSha256(glyphMasks, glyphAdvancesPx) {
  const advances = Buffer.alloc(glyphAdvancesPx.length * 2);
  for (let index = 0; index < glyphAdvancesPx.length; index += 1) {
    advances.writeUInt16LE(glyphAdvancesPx[index], index * 2);
  }
  const digest = createHash("sha256").update(advances);
  for (const mask of glyphMasks) {
    digest.update(Buffer.from(mask.buffer, mask.byteOffset, mask.byteLength));
  }
  return digest.digest("hex");
}

function serializeCaptchaTemplates(cacheKey, provenance, glyphMasks, glyphAdvancesPx) {
  const metadata = Buffer.from(
    JSON.stringify({
      cacheKey,
      provenance,
      glyphAdvancesPx: [...glyphAdvancesPx],
      payloadSha256: captchaTemplatePayloadSha256(glyphMasks, glyphAdvancesPx),
    }),
    "utf8",
  );
  const metadataLength = Buffer.alloc(4);
  metadataLength.writeUInt32LE(metadata.length);
  return Buffer.concat([
    CACHE_MAGIC,
    metadataLength,
    metadata,
    ...glyphMasks.map((mask) => Buffer.from(mask.buffer, mask.byteOffset, mask.byteLength)),
  ]);
}

function readCachedCaptchaTemplates(path, cacheKey, profile) {
  try {
    const bytes = readFileSync(path);
    if (!bytes.subarray(0, CACHE_MAGIC.length).equals(CACHE_MAGIC)) return null;
    const metadataLength = bytes.readUInt32LE(CACHE_MAGIC.length);
    const maskOffset = CACHE_MAGIC.length + 4 + metadataLength;
    const metadata = JSON.parse(
      bytes.subarray(CACHE_MAGIC.length + 4, maskOffset).toString("utf8"),
    );
    const pixelsPerGlyph = profile.maskWidthPx * profile.maskHeightPx;
    if (
      metadata.cacheKey !== cacheKey ||
      metadata.glyphAdvancesPx?.length !== profile.answerAlphabet.length ||
      bytes.length !== maskOffset + pixelsPerGlyph * profile.answerAlphabet.length
    ) {
      return null;
    }
    const glyphMasks = [];
    for (let index = 0; index < profile.answerAlphabet.length; index += 1) {
      const start = maskOffset + index * pixelsPerGlyph;
      glyphMasks.push(Uint8Array.from(bytes.subarray(start, start + pixelsPerGlyph)));
    }
    if (
      !/^[a-f0-9]{64}$/.test(metadata.payloadSha256) ||
      metadata.payloadSha256 !== captchaTemplatePayloadSha256(
        glyphMasks,
        metadata.glyphAdvancesPx,
      )
    ) {
      return null;
    }
    return new SugangCaptchaTemplates(
      profile,
      metadata.provenance,
      glyphMasks,
      metadata.glyphAdvancesPx,
    );
  } catch {
    return null;
  }
}

export function createSugangCaptchaTemplates(options = {}) {
  const profile =
    options instanceof SugangCaptchaTemplateConfig
      ? options
      : new SugangCaptchaTemplateConfig(options);
  if (!existsSync(profile.fontPath)) throw new Error(`Font not found: ${profile.fontPath}`);
  const fontSha256 = createHash("sha256").update(readFileSync(profile.fontPath)).digest("hex");
  const renderer = imageMagickVersion(profile);
  const profileProvenance = {
    maskWidthPx: profile.maskWidthPx,
    maskHeightPx: profile.maskHeightPx,
    glyphTemplateAnchorXPx: profile.glyphTemplateAnchorXPx,
    fontPointSize: profile.fontPointSize,
    textBaselineYPx: profile.textBaselineYPx,
    answerAlphabet: profile.answerAlphabet,
    answerLength: profile.answerLength,
    firstGlyphOriginXMinPx: profile.firstGlyphOriginXMinPx,
    firstGlyphOriginXMaxPx: profile.firstGlyphOriginXMaxPx,
    glyphAdvanceTolerancePx: profile.glyphAdvanceTolerancePx,
  };
  const provenance = {
    fontPath: profile.fontPath,
    fontSha256,
    renderer,
    profile: profileProvenance,
  };
  const cacheKey = createHash("sha256")
    .update(JSON.stringify(provenance))
    .digest("hex");
  const cacheDirectory =
    options instanceof SugangCaptchaTemplateConfig
      ? DEFAULT_CACHE_DIRECTORY
      : options.cacheDirectory === undefined
        ? DEFAULT_CACHE_DIRECTORY
        : options.cacheDirectory;
  const cachePath = cacheDirectory && resolve(cacheDirectory, `${cacheKey}.bin`);
  if (cachePath) {
    const cached = readCachedCaptchaTemplates(cachePath, cacheKey, profile);
    if (cached) return cached;
  }

  const glyphMasks = [];
  const glyphAdvancesPx = [];
  for (const answerByte of profile.answerAlphabet) {
    glyphMasks.push(renderGlyphMask(answerByte, profile));
    glyphAdvancesPx.push(measureGlyphAdvancePx(answerByte, profile));
  }
  const templates = new SugangCaptchaTemplates(
    profile,
    provenance,
    glyphMasks,
    glyphAdvancesPx,
  );
  if (cachePath) {
    const temporaryPath = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      mkdirSync(cacheDirectory, { recursive: true });
      writeFileSync(
        temporaryPath,
        serializeCaptchaTemplates(cacheKey, provenance, glyphMasks, glyphAdvancesPx),
        { flag: "wx", mode: 0o600 },
      );
      renameSync(temporaryPath, cachePath);
    } catch {
      rmSync(temporaryPath, { force: true });
    }
  }
  return templates;
}

export function readSugangCaptchaMask(imagePath, profile) {
  return parseAsciiPbm(
    runImageMagick(
      profile.imageMagickCommand,
      [
        imagePath,
        "-alpha",
        "off",
        "-fill",
        "white",
        "+opaque",
        "black",
        "-compress",
        "none",
        "pbm:-",
      ],
      "Reading Sugang CAPTCHA image",
    ),
    profile,
  );
}

export function readSugangCaptchaMaskBytes(gifBytes, profile) {
  if (!(gifBytes instanceof Uint8Array) || gifBytes.length === 0) {
    throw new Error("Sugang CAPTCHA GIF bytes are required");
  }
  return parseAsciiPbm(
    runImageMagick(
      profile.imageMagickCommand,
      [
        "gif:-",
        "-alpha",
        "off",
        "-fill",
        "white",
        "+opaque",
        "black",
        "-compress",
        "none",
        "pbm:-",
      ],
      "Reading Sugang CAPTCHA GIF",
      { input: gifBytes },
    ),
    profile,
  );
}
