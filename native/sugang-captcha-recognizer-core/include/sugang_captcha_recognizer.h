#ifndef SUGANG_CAPTCHA_RECOGNIZER_H
#define SUGANG_CAPTCHA_RECOGNIZER_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define SUGANG_CAPTCHA_RECOGNIZER_ABI_VERSION 1u
#define SUGANG_CAPTCHA_MAX_ANSWER_LENGTH 8u

typedef struct sugang_captcha_recognizer sugang_captcha_recognizer;

/*
 * ABI v1 wire and alignment contract:
 *
 * - Scalars are fixed-width integers. There are no ABI-visible bools, enums,
 *   size_t values, Rust slices, or Rust-owned strings.
 * - Pointer fields are naturally pointer-aligned. Every pointed-to value is a
 *   byte buffer and may have alignment 1.
 * - answer_alphabet_ascii contains unique A-Z/0-9 bytes.
 * - glyph_masks contains one 0/1 byte per pixel in
 *   [alphabet index][y][x] order.
 * - glyph_advances_px_le contains one little-endian u16 per alphabet byte.
 *   Do not cast this possibly unaligned buffer to uint16_t*.
 * - Construction copies every input buffer; input lifetimes end on return.
 */
typedef struct {
  uint32_t abi_version;
  uint32_t struct_size;
  uint32_t mask_width_px;
  uint32_t mask_height_px;
  uint32_t answer_alphabet_len;
  uint32_t answer_length;
  uint32_t glyph_template_anchor_x_px;
  uint32_t first_glyph_origin_x_min_px;
  uint32_t first_glyph_origin_x_max_px;
  uint32_t glyph_advance_tolerance_px;
  const uint8_t *answer_alphabet_ascii;
  uint32_t answer_alphabet_bytes;
  const uint8_t *glyph_masks;
  uint32_t glyph_mask_bytes;
  const uint8_t *glyph_advances_px_le;
  uint32_t glyph_advance_bytes;
} sugang_captcha_templates_v1;

/*
 * answer contains exactly answer_length non-NUL ASCII bytes followed by zero
 * padding. glyph_origins_x_px has answer_length meaningful entries followed by
 * zero padding. Candidates are unique and ordered by mismatched_pixel_count,
 * then by answer-alphabet order.
 */
typedef struct {
  uint8_t answer[SUGANG_CAPTCHA_MAX_ANSWER_LENGTH];
  uint16_t glyph_origins_x_px[SUGANG_CAPTCHA_MAX_ANSWER_LENGTH];
  uint32_t mismatched_pixel_count;
} sugang_captcha_alignment_candidate_v1;

enum {
  SUGANG_CAPTCHA_OK = 0,
  SUGANG_CAPTCHA_INVALID_ARGUMENT = 1,
  SUGANG_CAPTCHA_ABI_MISMATCH = 2,
  SUGANG_CAPTCHA_INVALID_TEMPLATES = 3,
  SUGANG_CAPTCHA_INVALID_OBSERVED_MASK = 4,
  SUGANG_CAPTCHA_OUTPUT_TOO_SMALL = 5,
  SUGANG_CAPTCHA_INTERNAL_ERROR = 255
};

uint32_t sugang_captcha_recognizer_abi_version(void);

int32_t sugang_captcha_recognizer_create_v1(
    const sugang_captcha_templates_v1 *templates,
    sugang_captcha_recognizer **out_recognizer);

/*
 * observed_mask is mask_width_px * mask_height_px binary bytes in [y][x]
 * order. candidate_limit is 2..100. Calls may run concurrently and serialize
 * within one recognizer.
 */
int32_t sugang_captcha_recognizer_rank_answers_v1(
    sugang_captcha_recognizer *recognizer,
    const uint8_t *observed_mask,
    uint32_t observed_mask_bytes,
    uint32_t candidate_limit,
    sugang_captcha_alignment_candidate_v1 *candidates,
    uint32_t candidate_capacity,
    uint32_t *out_candidate_count);

/* Destroy exactly once, only after every rank call has returned. */
void sugang_captcha_recognizer_destroy_v1(
    sugang_captcha_recognizer *recognizer);

const char *sugang_captcha_status_message_v1(int32_t status);

#ifdef __cplusplus
}
#endif

#endif
