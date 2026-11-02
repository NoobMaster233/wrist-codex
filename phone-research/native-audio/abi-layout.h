/* Static analysis layout for p67cn 3.101.043, not a recording implementation.
 * No function addresses, target entry point, module constructor, or device I/O.
 * Field names express analyst inferences; offsets are checked against assembly.
 */
#ifndef BAND_CODEX_ANALYSIS_AUDIO_LAYOUT_H
#define BAND_CODEX_ANALYSIS_AUDIO_LAYOUT_H

#include <stddef.h>
#include <stdint.h>

enum candidate_media_command_code {
    CANDIDATE_RECORDER_CLOSE = 0x24,
    CANDIDATE_RECORDER_READ = 0x25,
    CANDIDATE_RECORDER_BEGIN = 0x26
};

enum candidate_media_event_code {
    CANDIDATE_EVENT_36 = 0x36,
    CANDIDATE_RECORDER_BEGIN_RESULT = 0x3e,
    CANDIDATE_RECORDER_READ_RESULT = 0x3f
};

/* All address-like words are encoded as uint32_t so this can be checked on a
 * 64-bit analysis host without accidentally adopting its pointer layout. */
struct candidate_media_command_layout {
    uint32_t owner_word;
    uint32_t session_handle;
    uint8_t command;
    uint8_t reserved_09[3];
    uint32_t stream_address;
    uint32_t source_tag_address;
    uint8_t mode_byte;
    uint8_t path_or_scratch[0x400];
    uint8_t options[0x80];
    uint8_t alignment_495[3];
    uint32_t callback_address;
    uint32_t reserved_49c;
};

/* Prefix view only. Some event allocations are substantially larger. */
struct candidate_media_event_prefix {
    uint32_t owner_word;
    uint32_t session_handle;
    uint8_t event;
    uint8_t reserved_09[3];
    int32_t status;
    uint32_t data_address;
    uint32_t data_length;
};

#if defined(__cplusplus)
#define BAND_ABI_ASSERT static_assert
#else
#define BAND_ABI_ASSERT _Static_assert
#endif
BAND_ABI_ASSERT(sizeof(struct candidate_media_command_layout) == 0x4a0, "command copy size");
BAND_ABI_ASSERT(offsetof(struct candidate_media_command_layout, command) == 8, "command offset");
BAND_ABI_ASSERT(offsetof(struct candidate_media_command_layout, path_or_scratch) == 0x15, "scratch offset");
BAND_ABI_ASSERT(offsetof(struct candidate_media_command_layout, options) == 0x415, "options offset");
BAND_ABI_ASSERT(offsetof(struct candidate_media_command_layout, callback_address) == 0x498, "callback offset");
BAND_ABI_ASSERT(sizeof(struct candidate_media_event_prefix) == 0x18, "prefix view size");
BAND_ABI_ASSERT(offsetof(struct candidate_media_event_prefix, data_address) == 0x10, "audio pointer offset");
BAND_ABI_ASSERT(offsetof(struct candidate_media_event_prefix, data_length) == 0x14, "audio length offset");
#undef BAND_ABI_ASSERT
#endif
