use std::cmp::Ordering;
use std::ffi::c_char;
use std::slice;
use std::sync::Mutex;

const ABI_VERSION: u32 = 1;
const MAX_ANSWER_LENGTH: usize = 8;
const MAX_MASK_WIDTH_PX: usize = 512;
const MAX_MASK_HEIGHT_PX: usize = 128;
const MAX_ANSWER_ALPHABET_LEN: usize = 64;
const MAX_CANDIDATE_LIMIT: usize = 100;

const OK: i32 = 0;
const INVALID_ARGUMENT: i32 = 1;
const ABI_MISMATCH: i32 = 2;
const INVALID_TEMPLATES: i32 = 3;
const INVALID_OBSERVED_MASK: i32 = 4;
const OUTPUT_TOO_SMALL: i32 = 5;

#[repr(C)]
pub struct CaptchaTemplatesV1 {
    abi_version: u32,
    struct_size: u32,
    mask_width_px: u32,
    mask_height_px: u32,
    answer_alphabet_len: u32,
    answer_length: u32,
    glyph_template_anchor_x_px: u32,
    first_glyph_origin_x_min_px: u32,
    first_glyph_origin_x_max_px: u32,
    glyph_advance_tolerance_px: u32,
    answer_alphabet_ascii: *const u8,
    answer_alphabet_bytes: u32,
    glyph_masks: *const u8,
    glyph_mask_bytes: u32,
    glyph_advances_px_le: *const u8,
    glyph_advance_bytes: u32,
}

#[repr(C)]
#[derive(Clone, Copy, Default, Debug, PartialEq, Eq)]
pub struct CaptchaAlignmentCandidateV1 {
    answer: [u8; MAX_ANSWER_LENGTH],
    glyph_origins_x_px: [u16; MAX_ANSWER_LENGTH],
    mismatched_pixel_count: u32,
}

#[derive(Clone, Copy)]
struct GlyphColumnBits {
    low: u64,
    high: u64,
}

impl GlyphColumnBits {
    const EMPTY: Self = Self { low: 0, high: 0 };

    #[inline(always)]
    fn mismatch_count(self, observed: Self) -> u32 {
        (self.low ^ observed.low).count_ones() + (self.high ^ observed.high).count_ones()
    }
}

#[derive(Clone, Copy)]
struct PartialAnswerAlignment {
    answer_code: u64,
    glyph_origins_x_px: [u16; MAX_ANSWER_LENGTH],
    mismatched_pixel_count: u32,
}

struct RecognitionWorkspace {
    observed_columns: Vec<GlyphColumnBits>,
    mismatch_prefixes: Vec<u32>,
    alignments_by_glyph_origin_x: Vec<Vec<PartialAnswerAlignment>>,
    next_alignments_by_glyph_origin_x: Vec<Vec<PartialAnswerAlignment>>,
    answer_candidates: Vec<PartialAnswerAlignment>,
}

impl RecognitionWorkspace {
    fn new(mask_width_px: usize, last_glyph_origin_x_px: usize, prefix_len: usize) -> Self {
        Self {
            observed_columns: vec![GlyphColumnBits::EMPTY; mask_width_px],
            mismatch_prefixes: vec![0; prefix_len],
            alignments_by_glyph_origin_x: (0..=last_glyph_origin_x_px)
                .map(|_| Vec::new())
                .collect(),
            next_alignments_by_glyph_origin_x: (0..=last_glyph_origin_x_px)
                .map(|_| Vec::new())
                .collect(),
            answer_candidates: Vec::new(),
        }
    }
}

#[repr(C)]
pub struct CaptchaRecognizer {
    mask_width_px: usize,
    mask_height_px: usize,
    answer_alphabet_ascii: Vec<u8>,
    answer_length: usize,
    glyph_template_anchor_x_px: usize,
    first_glyph_origin_x_min_px: usize,
    first_glyph_origin_x_max_px: usize,
    glyph_advance_tolerance_px: usize,
    glyph_advances_px: Vec<usize>,
    glyph_columns: Vec<GlyphColumnBits>,
    possible_glyph_origin_x_min_px: usize,
    possible_glyph_origin_x_max_px: usize,
    workspace: Mutex<RecognitionWorkspace>,
}

fn read_abi_bytes<'a>(pointer: *const u8, length: u32) -> Result<&'a [u8], i32> {
    if pointer.is_null() && length != 0 {
        return Err(INVALID_ARGUMENT);
    }
    Ok(if length == 0 {
        &[]
    } else {
        // SAFETY: ABI callers guarantee this many readable bytes for the call.
        unsafe { slice::from_raw_parts(pointer, length as usize) }
    })
}

fn create_recognizer(templates: &CaptchaTemplatesV1) -> Result<Box<CaptchaRecognizer>, i32> {
    if templates.abi_version != ABI_VERSION
        || templates.struct_size < std::mem::size_of::<CaptchaTemplatesV1>() as u32
    {
        return Err(ABI_MISMATCH);
    }

    let mask_width_px = templates.mask_width_px as usize;
    let mask_height_px = templates.mask_height_px as usize;
    let answer_alphabet_len = templates.answer_alphabet_len as usize;
    let answer_length = templates.answer_length as usize;
    let glyph_template_anchor_x_px = templates.glyph_template_anchor_x_px as usize;
    let first_glyph_origin_x_min_px = templates.first_glyph_origin_x_min_px as usize;
    let first_glyph_origin_x_max_px = templates.first_glyph_origin_x_max_px as usize;
    let glyph_advance_tolerance_px = templates.glyph_advance_tolerance_px as usize;
    if mask_width_px == 0
        || mask_width_px > MAX_MASK_WIDTH_PX
        || mask_height_px == 0
        || mask_height_px > MAX_MASK_HEIGHT_PX
        || answer_alphabet_len < 2
        || answer_alphabet_len > MAX_ANSWER_ALPHABET_LEN
        || answer_length < 2
        || answer_length > MAX_ANSWER_LENGTH
        || glyph_template_anchor_x_px >= mask_width_px
        || first_glyph_origin_x_min_px > first_glyph_origin_x_max_px
        || first_glyph_origin_x_max_px >= mask_width_px
        || glyph_advance_tolerance_px > 10
    {
        return Err(INVALID_TEMPLATES);
    }

    let expected_glyph_mask_bytes = answer_alphabet_len
        .checked_mul(mask_width_px)
        .and_then(|value| value.checked_mul(mask_height_px))
        .ok_or(INVALID_TEMPLATES)?;
    if templates.answer_alphabet_bytes as usize != answer_alphabet_len
        || templates.glyph_mask_bytes as usize != expected_glyph_mask_bytes
        || templates.glyph_advance_bytes as usize != answer_alphabet_len * 2
    {
        return Err(INVALID_TEMPLATES);
    }

    let answer_alphabet_ascii = read_abi_bytes(
        templates.answer_alphabet_ascii,
        templates.answer_alphabet_bytes,
    )?
    .to_vec();
    let glyph_masks = read_abi_bytes(templates.glyph_masks, templates.glyph_mask_bytes)?;
    let glyph_advances_px_le = read_abi_bytes(
        templates.glyph_advances_px_le,
        templates.glyph_advance_bytes,
    )?;
    if answer_alphabet_ascii
        .iter()
        .any(|byte| !byte.is_ascii_uppercase() && !byte.is_ascii_digit())
        || glyph_masks.iter().any(|pixel| *pixel > 1)
    {
        return Err(INVALID_TEMPLATES);
    }
    let mut unique_alphabet_bytes = [false; 128];
    for byte in &answer_alphabet_ascii {
        if unique_alphabet_bytes[*byte as usize] {
            return Err(INVALID_TEMPLATES);
        }
        unique_alphabet_bytes[*byte as usize] = true;
    }

    let mut glyph_advances_px = Vec::with_capacity(answer_alphabet_len);
    for bytes in glyph_advances_px_le.chunks_exact(2) {
        let glyph_advance_px = u16::from_le_bytes([bytes[0], bytes[1]]) as usize;
        if glyph_advance_px == 0 || glyph_advance_px > mask_width_px {
            return Err(INVALID_TEMPLATES);
        }
        glyph_advances_px.push(glyph_advance_px);
    }
    let largest_glyph_advance_px = *glyph_advances_px.iter().max().ok_or(INVALID_TEMPLATES)?;
    let possible_glyph_origin_x_max_px = (first_glyph_origin_x_max_px
        + (answer_length - 1) * (largest_glyph_advance_px + glyph_advance_tolerance_px))
        .min(mask_width_px - 1);
    let possible_glyph_origin_x_min_px = first_glyph_origin_x_min_px;

    let mut glyph_columns = vec![GlyphColumnBits::EMPTY; answer_alphabet_len * mask_width_px];
    for glyph_index in 0..answer_alphabet_len {
        let glyph_mask_offset = glyph_index * mask_width_px * mask_height_px;
        for x in 0..mask_width_px {
            let mut glyph_column = GlyphColumnBits::EMPTY;
            for y in 0..mask_height_px {
                if glyph_masks[glyph_mask_offset + y * mask_width_px + x] != 0 {
                    if y < 64 {
                        glyph_column.low |= 1u64 << y;
                    } else {
                        glyph_column.high |= 1u64 << (y - 64);
                    }
                }
            }
            glyph_columns[glyph_index * mask_width_px + x] = glyph_column;
        }
    }

    let possible_glyph_origin_count =
        possible_glyph_origin_x_max_px - possible_glyph_origin_x_min_px + 1;
    let mismatch_prefix_len =
        answer_alphabet_len * possible_glyph_origin_count * (mask_width_px + 1);
    Ok(Box::new(CaptchaRecognizer {
        mask_width_px,
        mask_height_px,
        answer_alphabet_ascii,
        answer_length,
        glyph_template_anchor_x_px,
        first_glyph_origin_x_min_px,
        first_glyph_origin_x_max_px,
        glyph_advance_tolerance_px,
        glyph_advances_px,
        glyph_columns,
        possible_glyph_origin_x_min_px,
        possible_glyph_origin_x_max_px,
        workspace: Mutex::new(RecognitionWorkspace::new(
            mask_width_px,
            possible_glyph_origin_x_max_px,
            mismatch_prefix_len,
        )),
    }))
}

#[inline(always)]
fn mismatch_prefix_offset(
    recognizer: &CaptchaRecognizer,
    glyph_index: usize,
    glyph_origin_x_px: usize,
) -> usize {
    let possible_origin_count =
        recognizer.possible_glyph_origin_x_max_px - recognizer.possible_glyph_origin_x_min_px + 1;
    (glyph_index * possible_origin_count + glyph_origin_x_px
        - recognizer.possible_glyph_origin_x_min_px)
        * (recognizer.mask_width_px + 1)
}

#[inline(always)]
fn glyph_segment_mismatch_count(
    recognizer: &CaptchaRecognizer,
    mismatch_prefixes: &[u32],
    glyph_index: usize,
    glyph_origin_x_px: usize,
    segment_left_x_px: usize,
    segment_right_x_px: usize,
) -> u32 {
    let offset = mismatch_prefix_offset(recognizer, glyph_index, glyph_origin_x_px);
    mismatch_prefixes[offset + segment_right_x_px] - mismatch_prefixes[offset + segment_left_x_px]
}

#[inline]
fn retain_best_answer_alignments(
    bucket: &mut Vec<PartialAnswerAlignment>,
    candidate: PartialAnswerAlignment,
    candidate_limit: usize,
) {
    if let Some(index) = bucket
        .iter()
        .position(|entry| entry.answer_code == candidate.answer_code)
    {
        if bucket[index].mismatched_pixel_count <= candidate.mismatched_pixel_count {
            return;
        }
        bucket.remove(index);
    }
    let index = bucket
        .binary_search_by(|entry| {
            match entry
                .mismatched_pixel_count
                .cmp(&candidate.mismatched_pixel_count)
            {
                Ordering::Equal => entry.answer_code.cmp(&candidate.answer_code),
                ordering => ordering,
            }
        })
        .unwrap_or_else(|index| index);
    bucket.insert(index, candidate);
    if bucket.len() > candidate_limit {
        bucket.pop();
    }
}

fn rank_captcha_answers(
    recognizer: &CaptchaRecognizer,
    observed_mask: &[u8],
    candidate_limit: usize,
    output: &mut [CaptchaAlignmentCandidateV1],
) -> Result<usize, i32> {
    if observed_mask.len() != recognizer.mask_width_px * recognizer.mask_height_px
        || observed_mask.iter().any(|pixel| *pixel > 1)
    {
        return Err(INVALID_OBSERVED_MASK);
    }
    if !(2..=MAX_CANDIDATE_LIMIT).contains(&candidate_limit) || output.len() < candidate_limit {
        return Err(OUTPUT_TOO_SMALL);
    }

    let mut workspace = recognizer.workspace.lock().map_err(|_| INVALID_TEMPLATES)?;
    workspace.observed_columns.fill(GlyphColumnBits::EMPTY);
    for y in 0..recognizer.mask_height_px {
        for x in 0..recognizer.mask_width_px {
            if observed_mask[y * recognizer.mask_width_px + x] != 0 {
                if y < 64 {
                    workspace.observed_columns[x].low |= 1u64 << y;
                } else {
                    workspace.observed_columns[x].high |= 1u64 << (y - 64);
                }
            }
        }
    }

    for glyph_index in 0..recognizer.answer_alphabet_ascii.len() {
        for glyph_origin_x_px in
            recognizer.possible_glyph_origin_x_min_px..=recognizer.possible_glyph_origin_x_max_px
        {
            let offset = mismatch_prefix_offset(recognizer, glyph_index, glyph_origin_x_px);
            workspace.mismatch_prefixes[offset] = 0;
            for x in 0..recognizer.mask_width_px {
                let glyph_template_x = x as isize - glyph_origin_x_px as isize
                    + recognizer.glyph_template_anchor_x_px as isize;
                let expected = if glyph_template_x >= 0
                    && glyph_template_x < recognizer.mask_width_px as isize
                {
                    recognizer.glyph_columns
                        [glyph_index * recognizer.mask_width_px + glyph_template_x as usize]
                } else {
                    GlyphColumnBits::EMPTY
                };
                workspace.mismatch_prefixes[offset + x + 1] = workspace.mismatch_prefixes
                    [offset + x]
                    + expected.mismatch_count(workspace.observed_columns[x]);
            }
        }
    }

    for bucket in &mut workspace.alignments_by_glyph_origin_x {
        bucket.clear();
    }
    for first_glyph_origin_x_px in
        recognizer.first_glyph_origin_x_min_px..=recognizer.first_glyph_origin_x_max_px
    {
        workspace.alignments_by_glyph_origin_x[first_glyph_origin_x_px].push(
            PartialAnswerAlignment {
                answer_code: 0,
                glyph_origins_x_px: [0; MAX_ANSWER_LENGTH],
                mismatched_pixel_count: 0,
            },
        );
    }

    for answer_position in 0..recognizer.answer_length - 1 {
        for bucket in &mut workspace.next_alignments_by_glyph_origin_x {
            bucket.clear();
        }
        for glyph_origin_x_px in
            recognizer.possible_glyph_origin_x_min_px..=recognizer.possible_glyph_origin_x_max_px
        {
            let partial_alignments =
                workspace.alignments_by_glyph_origin_x[glyph_origin_x_px].clone();
            for partial_alignment in partial_alignments {
                for glyph_index in 0..recognizer.answer_alphabet_ascii.len() {
                    let first_advance_px = recognizer.glyph_advances_px[glyph_index]
                        .saturating_sub(recognizer.glyph_advance_tolerance_px)
                        .max(1);
                    let last_advance_px = recognizer.glyph_advances_px[glyph_index]
                        + recognizer.glyph_advance_tolerance_px;
                    for glyph_advance_px in first_advance_px..=last_advance_px {
                        let next_glyph_origin_x_px = glyph_origin_x_px + glyph_advance_px;
                        if next_glyph_origin_x_px > recognizer.possible_glyph_origin_x_max_px {
                            continue;
                        }
                        let segment_left_x_px = if answer_position == 0 {
                            0
                        } else {
                            glyph_origin_x_px
                        };
                        let mut candidate = partial_alignment;
                        candidate.glyph_origins_x_px[answer_position] = glyph_origin_x_px as u16;
                        candidate.answer_code = partial_alignment.answer_code
                            * recognizer.answer_alphabet_ascii.len() as u64
                            + glyph_index as u64;
                        candidate.mismatched_pixel_count += glyph_segment_mismatch_count(
                            recognizer,
                            &workspace.mismatch_prefixes,
                            glyph_index,
                            glyph_origin_x_px,
                            segment_left_x_px,
                            next_glyph_origin_x_px,
                        );
                        retain_best_answer_alignments(
                            &mut workspace.next_alignments_by_glyph_origin_x
                                [next_glyph_origin_x_px],
                            candidate,
                            candidate_limit,
                        );
                    }
                }
            }
        }
        let workspace_ref = &mut *workspace;
        std::mem::swap(
            &mut workspace_ref.alignments_by_glyph_origin_x,
            &mut workspace_ref.next_alignments_by_glyph_origin_x,
        );
        if workspace
            .alignments_by_glyph_origin_x
            .iter()
            .all(Vec::is_empty)
        {
            return Err(INVALID_TEMPLATES);
        }
    }

    workspace.answer_candidates.clear();
    for glyph_origin_x_px in
        recognizer.possible_glyph_origin_x_min_px..=recognizer.possible_glyph_origin_x_max_px
    {
        let partial_alignments = workspace.alignments_by_glyph_origin_x[glyph_origin_x_px].clone();
        for partial_alignment in partial_alignments {
            for glyph_index in 0..recognizer.answer_alphabet_ascii.len() {
                let mut candidate = partial_alignment;
                candidate.glyph_origins_x_px[recognizer.answer_length - 1] =
                    glyph_origin_x_px as u16;
                candidate.answer_code = partial_alignment.answer_code
                    * recognizer.answer_alphabet_ascii.len() as u64
                    + glyph_index as u64;
                candidate.mismatched_pixel_count += glyph_segment_mismatch_count(
                    recognizer,
                    &workspace.mismatch_prefixes,
                    glyph_index,
                    glyph_origin_x_px,
                    glyph_origin_x_px,
                    recognizer.mask_width_px,
                );
                retain_best_answer_alignments(
                    &mut workspace.answer_candidates,
                    candidate,
                    candidate_limit,
                );
            }
        }
    }
    if workspace.answer_candidates.len() < 2 {
        return Err(INVALID_TEMPLATES);
    }

    let candidate_count = workspace.answer_candidates.len().min(candidate_limit);
    for (destination, candidate) in output
        .iter_mut()
        .zip(workspace.answer_candidates.iter())
        .take(candidate_count)
    {
        *destination = CaptchaAlignmentCandidateV1::default();
        let mut answer_code = candidate.answer_code;
        for index in (0..recognizer.answer_length).rev() {
            destination.answer[index] = recognizer.answer_alphabet_ascii
                [answer_code as usize % recognizer.answer_alphabet_ascii.len()];
            answer_code /= recognizer.answer_alphabet_ascii.len() as u64;
        }
        destination.glyph_origins_x_px = candidate.glyph_origins_x_px;
        destination.mismatched_pixel_count = candidate.mismatched_pixel_count;
    }
    Ok(candidate_count)
}

#[no_mangle]
pub extern "C" fn sugang_captcha_recognizer_abi_version() -> u32 {
    ABI_VERSION
}

#[no_mangle]
pub unsafe extern "C" fn sugang_captcha_recognizer_create_v1(
    templates: *const CaptchaTemplatesV1,
    out_recognizer: *mut *mut CaptchaRecognizer,
) -> i32 {
    if out_recognizer.is_null() {
        return INVALID_ARGUMENT;
    }
    unsafe { *out_recognizer = std::ptr::null_mut() };
    if templates.is_null() {
        return INVALID_ARGUMENT;
    }
    match create_recognizer(unsafe { &*templates }) {
        Ok(recognizer) => {
            unsafe { *out_recognizer = Box::into_raw(recognizer) };
            OK
        }
        Err(status) => status,
    }
}

#[no_mangle]
pub unsafe extern "C" fn sugang_captcha_recognizer_destroy_v1(recognizer: *mut CaptchaRecognizer) {
    if !recognizer.is_null() {
        drop(unsafe { Box::from_raw(recognizer) });
    }
}

#[no_mangle]
pub unsafe extern "C" fn sugang_captcha_recognizer_rank_answers_v1(
    recognizer: *mut CaptchaRecognizer,
    observed_mask: *const u8,
    observed_mask_bytes: u32,
    candidate_limit: u32,
    candidates: *mut CaptchaAlignmentCandidateV1,
    candidate_capacity: u32,
    out_candidate_count: *mut u32,
) -> i32 {
    if out_candidate_count.is_null() {
        return INVALID_ARGUMENT;
    }
    unsafe { *out_candidate_count = 0 };
    if recognizer.is_null() || observed_mask.is_null() || candidates.is_null() {
        return INVALID_ARGUMENT;
    }
    let observed_mask =
        unsafe { slice::from_raw_parts(observed_mask, observed_mask_bytes as usize) };
    let output = unsafe { slice::from_raw_parts_mut(candidates, candidate_capacity as usize) };
    match rank_captcha_answers(
        unsafe { &*recognizer },
        observed_mask,
        candidate_limit as usize,
        output,
    ) {
        Ok(candidate_count) => {
            unsafe { *out_candidate_count = candidate_count as u32 };
            OK
        }
        Err(status) => status,
    }
}

static OK_MESSAGE: &[u8] = b"ok\0";
static INVALID_ARGUMENT_MESSAGE: &[u8] = b"invalid argument\0";
static ABI_MISMATCH_MESSAGE: &[u8] = b"ABI version or struct size mismatch\0";
static INVALID_TEMPLATES_MESSAGE: &[u8] = b"invalid Sugang CAPTCHA templates\0";
static INVALID_OBSERVED_MASK_MESSAGE: &[u8] = b"invalid Sugang CAPTCHA binary mask\0";
static OUTPUT_TOO_SMALL_MESSAGE: &[u8] = b"invalid candidate limit or output capacity\0";
static INTERNAL_ERROR_MESSAGE: &[u8] = b"internal error\0";

#[no_mangle]
pub extern "C" fn sugang_captcha_status_message_v1(status: i32) -> *const c_char {
    let message = match status {
        OK => OK_MESSAGE,
        INVALID_ARGUMENT => INVALID_ARGUMENT_MESSAGE,
        ABI_MISMATCH => ABI_MISMATCH_MESSAGE,
        INVALID_TEMPLATES => INVALID_TEMPLATES_MESSAGE,
        INVALID_OBSERVED_MASK => INVALID_OBSERVED_MASK_MESSAGE,
        OUTPUT_TOO_SMALL => OUTPUT_TOO_SMALL_MESSAGE,
        _ => INTERNAL_ERROR_MESSAGE,
    };
    message.as_ptr().cast()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn abi_layout_is_stable_on_64_bit_targets() {
        if cfg!(target_pointer_width = "64") {
            assert_eq!(std::mem::size_of::<CaptchaTemplatesV1>(), 88);
            assert_eq!(std::mem::align_of::<CaptchaTemplatesV1>(), 8);
        }
        assert_eq!(std::mem::size_of::<CaptchaAlignmentCandidateV1>(), 28);
        assert_eq!(std::mem::align_of::<CaptchaAlignmentCandidateV1>(), 4);
    }

    #[test]
    fn duplicate_answer_alphabet_bytes_are_rejected() {
        let alphabet = *b"AA";
        let masks = [0u8; 8];
        let advances = [1u8, 0, 1, 0];
        let templates = CaptchaTemplatesV1 {
            abi_version: ABI_VERSION,
            struct_size: std::mem::size_of::<CaptchaTemplatesV1>() as u32,
            mask_width_px: 2,
            mask_height_px: 2,
            answer_alphabet_len: 2,
            answer_length: 2,
            glyph_template_anchor_x_px: 0,
            first_glyph_origin_x_min_px: 0,
            first_glyph_origin_x_max_px: 0,
            glyph_advance_tolerance_px: 0,
            answer_alphabet_ascii: alphabet.as_ptr(),
            answer_alphabet_bytes: alphabet.len() as u32,
            glyph_masks: masks.as_ptr(),
            glyph_mask_bytes: masks.len() as u32,
            glyph_advances_px_le: advances.as_ptr(),
            glyph_advance_bytes: advances.len() as u32,
        };
        assert!(matches!(
            create_recognizer(&templates),
            Err(INVALID_TEMPLATES)
        ));
    }
}
