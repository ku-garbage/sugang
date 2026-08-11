#include <node_api.h>

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

#include "sugang_captcha_recognizer.h"

static_assert(sizeof(uint32_t) == 4);
static_assert(sizeof(uint16_t) == 2);
static_assert(offsetof(sugang_captcha_templates_v1, answer_alphabet_ascii) == 40);
static_assert(offsetof(sugang_captcha_templates_v1, glyph_masks) ==
              (sizeof(void *) == 8 ? 56 : 48));
static_assert(offsetof(sugang_captcha_templates_v1, glyph_advances_px_le) ==
              (sizeof(void *) == 8 ? 72 : 56));
static_assert(sizeof(sugang_captcha_templates_v1) ==
              (sizeof(void *) == 8 ? 88 : 64));
static_assert(alignof(sugang_captcha_templates_v1) == alignof(void *));
static_assert(offsetof(sugang_captcha_alignment_candidate_v1,
                       glyph_origins_x_px) == 8);
static_assert(offsetof(sugang_captcha_alignment_candidate_v1,
                       mismatched_pixel_count) == 24);
static_assert(sizeof(sugang_captcha_alignment_candidate_v1) == 28);
static_assert(alignof(sugang_captcha_alignment_candidate_v1) == 4);

namespace {

const napi_type_tag kSugangCaptchaRecognizerTag = {
    0x753918cab2a54f11ULL,
    0x98a9d923038bc441ULL,
};

struct SugangCaptchaRecognizerHandle {
  sugang_captcha_recognizer *core;
  uint32_t answer_length;
};

bool NapiOk(napi_env env, napi_status status, const char *operation) {
  if (status == napi_ok) return true;
  const napi_extended_error_info *info = nullptr;
  napi_get_last_error_info(env, &info);
  std::string message(operation);
  if (info && info->error_message) {
    message += ": ";
    message += info->error_message;
  }
  napi_throw_error(env, nullptr, message.c_str());
  return false;
}

bool GetNamedUint32(napi_env env, napi_value object, const char *name,
                    uint32_t *out) {
  napi_value value;
  return NapiOk(env, napi_get_named_property(env, object, name, &value), name) &&
         NapiOk(env, napi_get_value_uint32(env, value, out), name);
}

bool GetNamedBuffer(napi_env env, napi_value object, const char *name,
                    const uint8_t **data, size_t *length) {
  napi_value value;
  bool is_buffer = false;
  void *raw = nullptr;
  if (!NapiOk(env, napi_get_named_property(env, object, name, &value), name) ||
      !NapiOk(env, napi_is_buffer(env, value, &is_buffer), name)) {
    return false;
  }
  if (!is_buffer) {
    std::string message(name);
    message += " must be a Buffer";
    napi_throw_type_error(env, nullptr, message.c_str());
    return false;
  }
  if (!NapiOk(env, napi_get_buffer_info(env, value, &raw, length), name)) {
    return false;
  }
  *data = static_cast<const uint8_t *>(raw);
  return true;
}

napi_value ThrowCoreStatus(napi_env env, int32_t status,
                           const char *operation) {
  std::string message(operation);
  message += ": ";
  message += sugang_captcha_status_message_v1(status);
  napi_throw_error(env, nullptr, message.c_str());
  return nullptr;
}

void FinalizeRecognizer(napi_env, void *data, void *) {
  auto *recognizer = static_cast<SugangCaptchaRecognizerHandle *>(data);
  if (recognizer) {
    if (recognizer->core) {
      sugang_captcha_recognizer_destroy_v1(recognizer->core);
    }
    delete recognizer;
  }
}

SugangCaptchaRecognizerHandle *GetRecognizer(napi_env env, napi_value value,
                                             bool require_open) {
  bool has_expected_type = false;
  if (!NapiOk(env,
              napi_check_object_type_tag(env, value,
                                         &kSugangCaptchaRecognizerTag,
                                         &has_expected_type),
              "Sugang CAPTCHA recognizer type") ||
      !has_expected_type) {
    if (!has_expected_type) {
      napi_throw_type_error(env, nullptr,
                            "Expected a Sugang CAPTCHA recognizer handle");
    }
    return nullptr;
  }
  SugangCaptchaRecognizerHandle *recognizer = nullptr;
  if (!NapiOk(env,
              napi_get_value_external(
                  env, value, reinterpret_cast<void **>(&recognizer)),
              "Sugang CAPTCHA recognizer handle")) {
    return nullptr;
  }
  if (!recognizer || (require_open && !recognizer->core)) {
    napi_throw_error(env, nullptr, "Sugang CAPTCHA recognizer is closed");
    return nullptr;
  }
  return recognizer;
}

napi_value CreateRecognizer(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (!NapiOk(env, napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr),
              "createRecognizer arguments")) {
    return nullptr;
  }
  if (argc != 1) {
    napi_throw_type_error(env, nullptr,
                          "createRecognizer expects one templates object");
    return nullptr;
  }

  sugang_captcha_templates_v1 templates{};
  templates.abi_version = SUGANG_CAPTCHA_RECOGNIZER_ABI_VERSION;
  templates.struct_size = sizeof(templates);
  if (!GetNamedUint32(env, argv[0], "maskWidthPx",
                      &templates.mask_width_px) ||
      !GetNamedUint32(env, argv[0], "maskHeightPx",
                      &templates.mask_height_px) ||
      !GetNamedUint32(env, argv[0], "answerLength",
                      &templates.answer_length) ||
      !GetNamedUint32(env, argv[0], "glyphTemplateAnchorXPx",
                      &templates.glyph_template_anchor_x_px) ||
      !GetNamedUint32(env, argv[0], "firstGlyphOriginXMinPx",
                      &templates.first_glyph_origin_x_min_px) ||
      !GetNamedUint32(env, argv[0], "firstGlyphOriginXMaxPx",
                      &templates.first_glyph_origin_x_max_px) ||
      !GetNamedUint32(env, argv[0], "glyphAdvanceTolerancePx",
                      &templates.glyph_advance_tolerance_px)) {
    return nullptr;
  }

  size_t answer_alphabet_bytes = 0;
  size_t glyph_mask_bytes = 0;
  size_t glyph_advance_bytes = 0;
  if (!GetNamedBuffer(env, argv[0], "answerAlphabetAscii",
                      &templates.answer_alphabet_ascii,
                      &answer_alphabet_bytes) ||
      !GetNamedBuffer(env, argv[0], "glyphMasks", &templates.glyph_masks,
                      &glyph_mask_bytes) ||
      !GetNamedBuffer(env, argv[0], "glyphAdvancesPxLe",
                      &templates.glyph_advances_px_le,
                      &glyph_advance_bytes)) {
    return nullptr;
  }
  if (answer_alphabet_bytes > UINT32_MAX || glyph_mask_bytes > UINT32_MAX ||
      glyph_advance_bytes > UINT32_MAX) {
    napi_throw_range_error(env, nullptr, "Sugang CAPTCHA templates are too large");
    return nullptr;
  }
  templates.answer_alphabet_len =
      static_cast<uint32_t>(answer_alphabet_bytes);
  templates.answer_alphabet_bytes =
      static_cast<uint32_t>(answer_alphabet_bytes);
  templates.glyph_mask_bytes = static_cast<uint32_t>(glyph_mask_bytes);
  templates.glyph_advance_bytes =
      static_cast<uint32_t>(glyph_advance_bytes);

  auto *recognizer = new SugangCaptchaRecognizerHandle{
      nullptr, templates.answer_length};
  const int32_t status = sugang_captcha_recognizer_create_v1(
      &templates, &recognizer->core);
  if (status != SUGANG_CAPTCHA_OK) {
    delete recognizer;
    return ThrowCoreStatus(env, status, "creating Sugang CAPTCHA recognizer");
  }

  napi_value external;
  if (!NapiOk(env,
              napi_create_external(env, recognizer, FinalizeRecognizer, nullptr,
                                   &external),
              "create Sugang CAPTCHA recognizer handle")) {
    FinalizeRecognizer(env, recognizer, nullptr);
    return nullptr;
  }
  if (!NapiOk(env,
              napi_type_tag_object(env, external,
                                   &kSugangCaptchaRecognizerTag),
              "tag Sugang CAPTCHA recognizer handle")) {
    // The External already owns recognizer through FinalizeRecognizer. It is
    // now unreachable to JavaScript and GC performs the single cleanup.
    return nullptr;
  }
  return external;
}

napi_value RankCaptchaAnswers(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  if (!NapiOk(env, napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr),
              "rankCaptchaAnswers arguments")) {
    return nullptr;
  }
  if (argc != 3) {
    napi_throw_type_error(
        env, nullptr,
        "rankCaptchaAnswers expects recognizer, observed mask, and candidate limit");
    return nullptr;
  }
  SugangCaptchaRecognizerHandle *recognizer = GetRecognizer(env, argv[0], true);
  if (!recognizer) return nullptr;

  bool is_buffer = false;
  void *observed_mask = nullptr;
  size_t observed_mask_bytes = 0;
  uint32_t candidate_limit = 0;
  if (!NapiOk(env, napi_is_buffer(env, argv[1], &is_buffer),
              "observed CAPTCHA mask") ||
      !is_buffer) {
    napi_throw_type_error(env, nullptr,
                          "observed CAPTCHA mask must be a Buffer");
    return nullptr;
  }
  if (!NapiOk(env,
              napi_get_buffer_info(env, argv[1], &observed_mask,
                                   &observed_mask_bytes),
              "observed CAPTCHA mask") ||
      !NapiOk(env, napi_get_value_uint32(env, argv[2], &candidate_limit),
              "candidate limit")) {
    return nullptr;
  }
  if (observed_mask_bytes > UINT32_MAX || candidate_limit > 100) {
    napi_throw_range_error(env, nullptr, "invalid CAPTCHA ranking size");
    return nullptr;
  }

  std::vector<sugang_captcha_alignment_candidate_v1> candidates(
      candidate_limit);
  uint32_t candidate_count = 0;
  const int32_t status = sugang_captcha_recognizer_rank_answers_v1(
      recognizer->core, static_cast<const uint8_t *>(observed_mask),
      static_cast<uint32_t>(observed_mask_bytes), candidate_limit,
      candidates.data(), candidate_limit, &candidate_count);
  if (status != SUGANG_CAPTCHA_OK) {
    return ThrowCoreStatus(env, status, "ranking Sugang CAPTCHA answers");
  }

  napi_value array;
  if (!NapiOk(env, napi_create_array_with_length(env, candidate_count, &array),
              "create candidate array")) {
    return nullptr;
  }
  for (uint32_t index = 0; index < candidate_count; ++index) {
    napi_value candidate;
    napi_value answer;
    napi_value mismatch_count;
    napi_value glyph_origins;
    if (!NapiOk(env, napi_create_object(env, &candidate),
                "create alignment candidate") ||
        !NapiOk(env,
                napi_create_string_latin1(
                    env, reinterpret_cast<const char *>(candidates[index].answer),
                    recognizer->answer_length, &answer),
                "create candidate answer") ||
        !NapiOk(env,
                napi_create_uint32(env,
                                   candidates[index].mismatched_pixel_count,
                                   &mismatch_count),
                "create mismatch count") ||
        !NapiOk(env,
                napi_create_array_with_length(env, recognizer->answer_length,
                                              &glyph_origins),
                "create glyph origins")) {
      return nullptr;
    }
    for (uint32_t glyph_index = 0; glyph_index < recognizer->answer_length;
         ++glyph_index) {
      napi_value glyph_origin;
      if (!NapiOk(env,
                  napi_create_uint32(
                      env, candidates[index].glyph_origins_x_px[glyph_index],
                      &glyph_origin),
                  "create glyph origin") ||
          !NapiOk(env,
                  napi_set_element(env, glyph_origins, glyph_index,
                                   glyph_origin),
                  "set glyph origin")) {
        return nullptr;
      }
    }
    if (!NapiOk(env, napi_set_named_property(env, candidate, "answer", answer),
                "set candidate answer") ||
        !NapiOk(env,
                napi_set_named_property(env, candidate,
                                        "mismatchedPixelCount",
                                        mismatch_count),
                "set mismatch count") ||
        !NapiOk(env,
                napi_set_named_property(env, candidate, "glyphOriginsX",
                                        glyph_origins),
                "set glyph origins") ||
        !NapiOk(env, napi_set_element(env, array, index, candidate),
                "set alignment candidate")) {
      return nullptr;
    }
  }
  return array;
}

napi_value CloseRecognizer(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (!NapiOk(env, napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr),
              "closeRecognizer arguments")) {
    return nullptr;
  }
  if (argc != 1) {
    napi_throw_type_error(env, nullptr,
                          "closeRecognizer expects one recognizer handle");
    return nullptr;
  }
  SugangCaptchaRecognizerHandle *recognizer = GetRecognizer(env, argv[0], false);
  if (!recognizer) return nullptr;
  if (recognizer->core) {
    sugang_captcha_recognizer_destroy_v1(recognizer->core);
    recognizer->core = nullptr;
  }
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"createRecognizer", nullptr, CreateRecognizer, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"rankCaptchaAnswers", nullptr, RankCaptchaAnswers, nullptr, nullptr,
       nullptr, napi_default, nullptr},
      {"closeRecognizer", nullptr, CloseRecognizer, nullptr, nullptr, nullptr,
       napi_default, nullptr},
  };
  if (!NapiOk(env,
              napi_define_properties(env, exports,
                                     sizeof(properties) / sizeof(properties[0]),
                                     properties),
              "define native exports")) {
    return nullptr;
  }
  napi_value abi_version;
  if (!NapiOk(env,
              napi_create_uint32(env,
                                 sugang_captcha_recognizer_abi_version(),
                                 &abi_version),
              "create ABI version") ||
      !NapiOk(env,
              napi_set_named_property(env, exports, "abiVersion", abi_version),
              "set ABI version")) {
    return nullptr;
  }
  return exports;
}

}  // namespace

NAPI_MODULE(sugang_captcha_recognizer, Init)
