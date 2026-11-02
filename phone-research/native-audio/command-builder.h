/* Offline command serialization only; never invokes a firmware function. */
#ifndef BAND_CODEX_COMMAND_BUILDER_H
#define BAND_CODEX_COMMAND_BUILDER_H
#include "abi-layout.h"
#include "capture-core.h"
struct bc_command_addresses {
    uint32_t owner, capture_stream, source_tag, callback;
};
bool bc_build_media_command(const struct bc_command *command,
    const struct bc_command_addresses *addresses, struct candidate_media_command_layout *out);
#endif
