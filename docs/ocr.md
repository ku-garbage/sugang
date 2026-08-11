# OCR findings

## Minimal preprocessing

The tested pipeline is:

1. Decode the GIF without converting the entire image when possible.
2. Map palette entries whose RGB channels are all below 80 to black; map all
   other entries to white.
3. Compute the black-pixel bounding box and add a three-pixel margin.
4. Upscale by 8x with nearest-neighbor interpolation.
5. Recognize one text line with an uppercase/digit whitelist.

The equivalent Tesseract CLI settings are:

```bash
tesseract stdin stdout --psm 7 \
  -c tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789
```

Keeping the original aspect ratio matters. An earlier resize that distorted
the crop caused `7` to be confused with `T`.

## Benchmarks on the recovered sample

All timings were measured locally on this Mac.

### New Tesseract process per image

- Preprocessing median: 1.45 ms
- OCR median: 49.99 ms
- Total median: 51.53 ms
- Result: `VL7X`, 20/20 repeated runs

The cost is dominated by starting the Tesseract process.

### Persistent native libtesseract instance

Calling `/opt/homebrew/opt/tesseract/lib/libtesseract.dylib` through its C API
and keeping `TessBaseAPI` initialized reduced the cost substantially:

- Palette-based preprocessing median: 0.182 ms
- OCR median: 4.530 ms
- Total median: 4.713 ms
- Total p95: 5.086 ms
- Result: `VL7X`, 100/100 repeated runs

This is roughly 11x faster than launching the CLI for each image. Network and
server latency are already much larger than local OCR time.

## Later template-decoder evaluation

Later collection established a strong Times New Roman Bold 24 px fit and a
repeatable two-pixel range of proportional character advances. The offline
decoder now uses exact k-best cursor-state dynamic programming rather than
Tesseract for recognition.

The saved evaluation corpus contains 50 files (49 unique hashes): 14 difficult
cases were transcribed manually and 36 use agreement between Tesseract modes as
pseudo-labels. `npm run evaluate` reports those provenance groups separately.
The observed 50/50 hybrid-label result is reproducible, but it is not
server-provided ground-truth accuracy.
