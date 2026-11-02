#include "event-wire.h"

static void clear_event(struct bc_user_event *out)
{
    unsigned char *bytes = (unsigned char *)out;
    for (size_t i = 0; i < sizeof(*out); ++i) bytes[i] = 0;
}

static void copy_text(char *out, const char *text)
{
    while (*text) *out++ = *text++;
    *out = 0;
}

static bool exact(const char *field, size_t capacity, const char *expected)
{
    for (size_t i = 0; i < capacity; ++i) {
        if (field[i] != expected[i]) return false;
        if (!expected[i]) return true;
    }
    return false;
}

static bool nonce_valid(const char *nonce)
{
    if (!nonce) return false;
    for (size_t i = 0; i < BC_EVENT_NONCE_CHARS; ++i) {
        unsigned char c = (unsigned char)nonce[i];
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
    }
    return nonce[BC_EVENT_NONCE_CHARS] == 0;
}

bool bc_event_ping(const char *nonce, struct bc_user_event *out)
{
    const char prefix[] = "{\"v\":1,\"op\":\"ping\",\"n\":\"";
    if (!out || !nonce_valid(nonce)) return false;
    clear_event(out);
    copy_text(out->name, BC_EVENT_REQUEST);
    copy_text(out->package, BC_EVENT_APP);
    copy_text(out->permissions, BC_EVENT_APP);
    copy_text(out->params, prefix);
    for (size_t i = 0; i < BC_EVENT_NONCE_CHARS; ++i) out->params[sizeof(prefix)-1+i] = nonce[i];
    copy_text(out->params + sizeof(prefix)-1 + BC_EVENT_NONCE_CHARS, "\"}");
    return true;
}

bool bc_event_reply(const struct bc_user_event *request, struct bc_user_event *out)
{
    const char prefix[] = "{\"v\":1,\"op\":\"ping\",\"n\":\"";
    char nonce[BC_EVENT_NONCE_CHARS + 1];
    struct bc_user_event canonical;
    if (!request || !out || !exact(request->name, sizeof(request->name), BC_EVENT_REQUEST) ||
        !exact(request->package, sizeof(request->package), BC_EVENT_APP) ||
        !exact(request->permissions, sizeof(request->permissions), BC_EVENT_APP)) return false;
    for (size_t i = 0; i < BC_EVENT_NONCE_CHARS; ++i) nonce[i] = request->params[sizeof(prefix)-1+i];
    nonce[BC_EVENT_NONCE_CHARS] = 0;
    if (!bc_event_ping(nonce, &canonical) || !exact(request->params, sizeof(request->params), canonical.params)) return false;
    clear_event(out);
    copy_text(out->name, BC_EVENT_RESPONSE);
    copy_text(out->package, BC_EVENT_NATIVE);
    copy_text(out->permissions, BC_EVENT_APP);
    copy_text(out->params, canonical.params);
    /* Replace the same-length operation string; retain the authenticated nonce. */
    const size_t op = sizeof("{\"v\":1,\"op\":\"") - 1;
    out->params[op] = 'p'; out->params[op+1] = 'o'; out->params[op+2] = 'n'; out->params[op+3] = 'g';
    return true;
}

void bc_event_ready(struct bc_user_event *out, bool received)
{
    clear_event(out);
    copy_text(out->name, BC_EVENT_RESPONSE);
    copy_text(out->package, BC_EVENT_NATIVE);
    copy_text(out->permissions, BC_EVENT_APP);
    copy_text(out->params, received ?
        "{\"v\":1,\"op\":\"ready\",\"rx\":true,\"audio\":false}" :
        "{\"v\":1,\"op\":\"ready\",\"rx\":false,\"audio\":false}");
}
