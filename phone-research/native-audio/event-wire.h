/* Private user-event protocol. Pure byte handling, no firmware calls. */
#ifndef BAND_CODEX_EVENT_WIRE_H
#define BAND_CODEX_EVENT_WIRE_H
#include <stdbool.h>
#include <stddef.h>

#define BC_EVENT_REQUEST "bc.capture.req"
#define BC_EVENT_RESPONSE "bc.capture.evt"
#define BC_EVENT_APP "dev.bandcodex.remote"
#define BC_EVENT_NATIVE "dev.bandcodex.native"
#define BC_EVENT_NONCE_CHARS 32u

/* .043 publish copies these exact fields into user_event_meta (256 bytes). */
struct bc_user_event {
    char name[32];
    char package[32];
    char params[128];
    char permissions[64];
};
_Static_assert(sizeof(struct bc_user_event) == 256, "user event size");
_Static_assert(offsetof(struct bc_user_event, params) == 0x40, "params offset");
_Static_assert(offsetof(struct bc_user_event, permissions) == 0xc0, "permissions offset");

/* Canonical JSON only: {"v":1,"op":"ping","n":"<32 lowercase hex>"}.
 * No recording or other operation is accepted by this diagnostic protocol. */
bool bc_event_ping(const char *nonce, struct bc_user_event *out);
bool bc_event_reply(const struct bc_user_event *request, struct bc_user_event *out);
void bc_event_ready(struct bc_user_event *out, bool received);
#endif
