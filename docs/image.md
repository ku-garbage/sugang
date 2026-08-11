# Macro CAPTCHA image findings

## Capture and recovery

The HAR recorded the `/d/m/macroImg` request and response metadata but omitted
the response body:

- Status: HTTP 200
- Content type: `image/gif;charset=UTF-8`
- HAR `bodySize`: 1,893 bytes
- No `response.content.text` or Base64 body

The rendered GIF was recovered from the closed Chrome profile's disk cache. A
standalone PNG copy is stored at
[`samples/macro-vl7x.png`](../samples/macro-vl7x.png).

## Observed sample

- Dimensions: 100 x 100
- Format in the response: GIF89a
- Answer: `VL7X`
- Text bounding box: approximately `(20, 44)` through `(81, 60)`
- Black text pixels: 286

The decoded sample contains exactly three RGB colors:

| RGB | Pixel count | Role |
|---|---:|---|
| `(160, 160, 160)` | 5,428 | Gray background |
| `(75, 243, 9)` | 4,286 | Green noise |
| `(0, 0, 0)` | 286 | Character strokes |

This makes the observed sample unusually easy to segment: retain only dark
pixels and discard both background colors. More samples are required before
assuming that every generated image uses the same palette, font, placement,
or character overlap.
