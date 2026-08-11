import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let nativeBinding;
let nativeBindingError;
try {
  const candidate = require("../../build/sugang_captcha_recognizer.node");
  if (candidate.abiVersion !== 1) {
    throw new Error(`Expected Sugang CAPTCHA recognizer ABI v1, received v${candidate.abiVersion}`);
  }
  nativeBinding = candidate;
} catch (error) {
  nativeBindingError = error;
}

export function nativeSugangCaptchaRecognizerStatus() {
  return nativeBinding
    ? { available: true, abiVersion: nativeBinding.abiVersion }
    : {
        available: false,
        error: nativeBindingError?.message ?? "native recognizer is unavailable",
      };
}

export function createNativeSugangCaptchaRecognizer(templates) {
  if (!nativeBinding) {
    throw new Error(
      `Native Sugang CAPTCHA recognizer unavailable: ${nativeSugangCaptchaRecognizerStatus().error}. ` +
        "Run npm run build:native.",
    );
  }
  const { profile } = templates;
  const pixelsPerGlyph = profile.maskWidthPx * profile.maskHeightPx;
  const answerAlphabetAscii = Buffer.from(profile.answerAlphabet, "ascii");
  const glyphMasks = Buffer.allocUnsafe(answerAlphabetAscii.length * pixelsPerGlyph);
  const glyphAdvancesPxLe = Buffer.allocUnsafe(answerAlphabetAscii.length * 2);
  for (let glyphIndex = 0; glyphIndex < profile.answerAlphabet.length; glyphIndex += 1) {
    const answerByte = profile.answerAlphabet[glyphIndex];
    glyphMasks.set(templates.glyphMask(answerByte), glyphIndex * pixelsPerGlyph);
    glyphAdvancesPxLe.writeUInt16LE(
      templates.glyphAdvancePx(answerByte),
      glyphIndex * 2,
    );
  }
  return nativeBinding.createRecognizer({
    maskWidthPx: profile.maskWidthPx,
    maskHeightPx: profile.maskHeightPx,
    answerLength: profile.answerLength,
    glyphTemplateAnchorXPx: profile.glyphTemplateAnchorXPx,
    firstGlyphOriginXMinPx: profile.firstGlyphOriginXMinPx,
    firstGlyphOriginXMaxPx: profile.firstGlyphOriginXMaxPx,
    glyphAdvanceTolerancePx: profile.glyphAdvanceTolerancePx,
    answerAlphabetAscii,
    glyphMasks,
    glyphAdvancesPxLe,
  });
}

export function rankNativeSugangCaptchaAnswers(
  nativeRecognizer,
  observedMask,
  candidateLimit,
) {
  const maskBuffer = Buffer.from(
    observedMask.buffer,
    observedMask.byteOffset,
    observedMask.byteLength,
  );
  return nativeBinding.rankCaptchaAnswers(nativeRecognizer, maskBuffer, candidateLimit);
}

export function closeNativeSugangCaptchaRecognizer(nativeRecognizer) {
  nativeBinding.closeRecognizer(nativeRecognizer);
}
