#include "command-builder.h"
#include <string.h>

bool bc_build_media_command(const struct bc_command *command,
    const struct bc_command_addresses *addresses, struct candidate_media_command_layout *out) {
    static const char options[] = "format=opusraw:sample_rate=16000:ch_layout=mono:b=32000:vbr=0:compression_level=1";
    _Static_assert(sizeof(options) <= sizeof(out->options), "capture options fit");
    if (!command || !addresses || !out || !addresses->owner || !command->generation) return false;
    uint8_t code;
    switch (command->kind) {
    case BC_OPEN:
        if (command->handle || !addresses->capture_stream || !addresses->source_tag ||
                !(addresses->callback & 1)) return false;
        code = CANDIDATE_RECORDER_BEGIN; break;
    case BC_READ:
        if (!command->handle) return false;
        code = CANDIDATE_RECORDER_READ; break;
    case BC_CLOSE:
        if (!command->handle) return false;
        code = CANDIDATE_RECORDER_CLOSE; break;
    default: return false;
    }
    memset(out, 0, sizeof(*out));
    out->owner_word = addresses->owner; out->session_handle = command->handle;
    out->command = code;
    if (command->kind == BC_OPEN) {
        out->stream_address = addresses->capture_stream; out->source_tag_address = addresses->source_tag;
        out->callback_address = addresses->callback;
        memcpy(out->options, options, sizeof(options));
    }
    return true;
}
