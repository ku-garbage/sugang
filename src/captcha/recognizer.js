import { basename } from "node:path";

import {
  closeNativeSugangCaptchaRecognizer,
  createNativeSugangCaptchaRecognizer,
  nativeSugangCaptchaRecognizerStatus,
  rankNativeSugangCaptchaAnswers,
} from "./native.js";
import { readSugangCaptchaMask, readSugangCaptchaMaskBytes } from "./templates.js";

export { nativeSugangCaptchaRecognizerStatus };

export class SugangCaptchaRecognizer {
  #templates;
  #nativeRecognizer;

  constructor(templates) {
    if (!templates?.profile || typeof templates.glyphMask !== "function") {
      throw new Error("Sugang CAPTCHA templates are required");
    }
    this.#templates = templates;
    this.#nativeRecognizer = createNativeSugangCaptchaRecognizer(templates);
  }

  get provenance() {
    return this.#templates.provenance;
  }

  rankCaptchaAnswers(observedMask, { candidateLimit = 3 } = {}) {
    if (!this.#nativeRecognizer) throw new Error("Sugang CAPTCHA recognizer is closed");
    const { maskWidthPx, maskHeightPx } = this.#templates.profile;
    if (
      !(observedMask instanceof Uint8Array) ||
      observedMask.length !== maskWidthPx * maskHeightPx
    ) {
      throw new Error(
        `Observed CAPTCHA mask must contain ${maskWidthPx * maskHeightPx} binary pixels`,
      );
    }
    if (observedMask.some((pixel) => pixel !== 0 && pixel !== 1)) {
      throw new Error("Observed CAPTCHA mask must be binary");
    }
    if (!Number.isInteger(candidateLimit) || candidateLimit < 2 || candidateLimit > 100) {
      throw new Error("candidateLimit must be from 2 to 100");
    }
    return rankNativeSugangCaptchaAnswers(
      this.#nativeRecognizer,
      observedMask,
      candidateLimit,
    );
  }

  rankCaptchaImage(imagePath, options = {}) {
    const candidates = this.rankCaptchaAnswers(
      readSugangCaptchaMask(imagePath, this.#templates.profile),
      options,
    );
    return {
      imagePath,
      candidates,
      runnerUpMismatchGap:
        candidates[1].mismatchedPixelCount - candidates[0].mismatchedPixelCount,
    };
  }

  rankCaptchaGif(gifBytes, options = {}) {
    const candidates = this.rankCaptchaAnswers(
      readSugangCaptchaMaskBytes(gifBytes, this.#templates.profile),
      options,
    );
    return {
      candidates,
      runnerUpMismatchGap:
        candidates[1].mismatchedPixelCount - candidates[0].mismatchedPixelCount,
    };
  }

  solveMacroChallenge(gifBytes) {
    const recognition = this.rankCaptchaGif(gifBytes, { candidateLimit: 3 });
    const best = recognition.candidates[0];
    return Object.freeze({
      answer: best.answer,
      diagnostics: Object.freeze({
        mismatchedPixelCount: best.mismatchedPixelCount,
        runnerUpMismatchGap: recognition.runnerUpMismatchGap,
        glyphOriginsX: Object.freeze([...best.glyphOriginsX]),
      }),
    });
  }

  close() {
    if (!this.#nativeRecognizer) return;
    closeNativeSugangCaptchaRecognizer(this.#nativeRecognizer);
    this.#nativeRecognizer = null;
  }

  [Symbol.dispose]() {
    this.close();
  }
}

export function createSugangCaptchaRecognizer(templates) {
  return new SugangCaptchaRecognizer(templates);
}

export function formatSugangCaptchaRecognition(recognition) {
  const best = recognition.candidates[0];
  return (
    `${basename(recognition.imagePath)}\t${best.answer}` +
    `\tmismatches=${best.mismatchedPixelCount}` +
    `\trunner-up-gap=${recognition.runnerUpMismatchGap}` +
    `\tglyph-origins-x=${best.glyphOriginsX.join(",")}`
  );
}
