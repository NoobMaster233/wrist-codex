/* Candidate 32-bit Feature layouts recovered from .043's system.file binding.
 * Current openVela headers corroborate this shape; they are not a replacement
 * for the firmware ABI. Addresses below are encoded words, never callable.
 */
#ifndef BAND_CODEX_FEATURE_LAYOUT_H
#define BAND_CODEX_FEATURE_LAYOUT_H
#include <stddef.h>
#include <stdint.h>
struct bc_feature_description_layout {
    uint32_t version, name_address, description_address, flags;
    uint32_t callbacks_address, member_count, members_address;
};
struct bc_feature_callbacks_layout {
    uint32_t on_register, on_create, on_required, on_detached, on_destroy, on_unregister;
};
struct bc_feature_member_layout { uint32_t type, name_address, definition_address; };
struct bc_feature_method_layout {
    uint32_t stub_address, parameters_address, return_type, alignment_0c;
    uint64_t append_data;
};
_Static_assert(sizeof(struct bc_feature_description_layout) == 28, "Feature description");
_Static_assert(offsetof(struct bc_feature_description_layout, callbacks_address) == 16, "native callbacks");
_Static_assert(sizeof(struct bc_feature_callbacks_layout) == 24, "six lifecycle callbacks");
_Static_assert(sizeof(struct bc_feature_member_layout) == 12, "member stride");
_Static_assert(sizeof(struct bc_feature_method_layout) == 24, "method plus 64-bit AppendData");
_Static_assert(offsetof(struct bc_feature_method_layout, append_data) == 16, "AppendData alignment");
#endif
