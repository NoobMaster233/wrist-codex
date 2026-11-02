#include "capture-core.h"
#include <string.h>

static void finish(struct bc_capture *c) {
    if (!c->closed) return;
    if (c->count) { c->phase = BC_DRAINING; return; }
    c->phase = c->cancelled ? BC_CANCELLED : c->error != BC_OK ? BC_FAILED : BC_COMPLETE;
}

static void discard(struct bc_capture *c) {
    memset(c->slots, 0, sizeof(c->slots));
    c->head = c->count = c->in_flight = 0;
}

void bc_capture_init(struct bc_capture *c) {
    memset(c, 0, sizeof(*c)); c->phase = BC_IDLE; c->closed = true;
}

bool bc_capture_releasable(const struct bc_capture *c) {
    return c->closed && !c->count && !c->open_pending && !c->read_pending && !c->close_pending;
}

enum bc_error bc_capture_begin(struct bc_capture *c, uint64_t now_ms) {
    if (!bc_capture_releasable(c) || c->generation == UINT64_MAX) return BC_BAD_STATE;
    uint64_t generation = c->generation + 1;
    bc_capture_init(c); c->generation = generation;
    c->phase = BC_OPENING; c->closed = false; c->open_pending = true;
    c->deadline = now_ms + BC_AUDIO_OPEN_TIMEOUT_MS; c->next_sequence = 1;
    return BC_OK;
}

bool bc_capture_command(struct bc_capture *c, struct bc_command *out) {
    bool *pending;
    if (c->open_pending) { pending = &c->open_pending; out->kind = BC_OPEN; }
    else if (c->close_pending) {
        pending = &c->close_pending; out->kind = BC_CLOSE; c->close_issued = true;
    } else if (c->read_pending) { pending = &c->read_pending; out->kind = BC_READ; }
    else return false;
    *pending = false; out->generation = c->generation; out->handle = c->handle;
    return true;
}

void bc_capture_stop(struct bc_capture *c, bool cancel, uint64_t now_ms) {
    if (c->phase == BC_IDLE || (c->closed && !c->count)) return;
    c->cancelled |= cancel;
    if (cancel) discard(c);
    if (c->open_pending && !c->opened) {
        /* OPEN has never been handed to the adapter, so there is no native
         * request to drain and cancellation must not start the microphone. */
        c->open_pending = false; c->closed = true; c->stopping = true;
        finish(c); return;
    }
    if (!c->stopping) {
        c->stopping = true; c->deadline = now_ms + BC_AUDIO_CLOSE_TIMEOUT_MS;
    }
    c->read_pending = false;
    if (c->opened && !c->closed && !c->close_issued) c->close_pending = true;
    if (c->closed) finish(c);
    else if (c->phase != BC_QUARANTINED) c->phase = BC_STOPPING;
}

static void fail(struct bc_capture *c, enum bc_error error, uint64_t now_ms) {
    if (c->error == BC_OK) c->error = error;
    discard(c); bc_capture_stop(c, false, now_ms);
    if (c->closed) finish(c);
}

void bc_capture_opened(struct bc_capture *c, uint64_t generation,
                       int status, uint32_t handle, uint64_t now_ms) {
    if (generation != c->generation || c->opened || c->closed || c->open_pending) return;
    c->opened = true; c->handle = handle;
    if (!handle) {
        /* Adapter contract: a zero handle result proves no native session was
         * created and there will be no data callbacks for this request. */
        c->closed = true;
        if (!c->cancelled && c->error == BC_OK) c->error = BC_CAPTURE_ERROR;
        finish(c); return;
    }
    if (status) { fail(c, BC_CAPTURE_ERROR, now_ms); return; }
    if (c->stopping) { c->close_pending = true; return; }
    c->opened_at = now_ms; c->phase = BC_RECORDING; c->read_pending = true;
}

enum bc_error bc_capture_frame(struct bc_capture *c, uint64_t generation,
    uint32_t handle, int status, const void *bytes, size_t length, uint64_t now_ms) {
    if (generation != c->generation || !handle || handle != c->handle || c->closed) return BC_STALE;
    if (c->phase != BC_RECORDING || c->stopping) return BC_BAD_STATE;
    if (now_ms - c->opened_at >= BC_AUDIO_DURATION_MS) {
        bc_capture_stop(c, false, now_ms); return BC_BAD_STATE;
    }
    if (status || !bytes || !length) { fail(c, BC_CAPTURE_ERROR, now_ms); return BC_CAPTURE_ERROR; }
    if (length > BC_AUDIO_FRAME_MAX) { fail(c, BC_FRAME_TOO_LARGE, now_ms); return BC_FRAME_TOO_LARGE; }
    if (length > BC_AUDIO_TOTAL_MAX - c->total_bytes) { fail(c, BC_BYTE_LIMIT, now_ms); return BC_BYTE_LIMIT; }
    if (c->count == BC_AUDIO_SLOTS) { fail(c, BC_OVERFLOW, now_ms); return BC_OVERFLOW; }
    struct bc_slot *s = &c->slots[(c->head + c->count) % BC_AUDIO_SLOTS];
    s->sequence = c->next_sequence++; s->length = length; s->sent = false;
    memcpy(s->bytes, bytes, length); /* Copy before the firmware event is freed. */
    ++c->count; c->total_bytes += length;
    return BC_OK;
}

bool bc_capture_quiesced(struct bc_capture *c, uint64_t generation, uint32_t handle,
                         uint64_t now_ms) {
    if (generation != c->generation || !handle || handle != c->handle ||
            !c->close_issued || !c->stopping || c->closed) return false;
    c->closed = true; c->handle = 0; c->close_pending = c->read_pending = false;
    c->deadline = now_ms + BC_AUDIO_DRAIN_TIMEOUT_MS;
    finish(c); return true;
}

void bc_capture_tick(struct bc_capture *c, uint64_t now_ms) {
    if (c->phase == BC_RECORDING && now_ms - c->opened_at >= BC_AUDIO_DURATION_MS)
        bc_capture_stop(c, false, now_ms);
    if (!c->closed && (!c->opened || c->stopping) && now_ms >= c->deadline) {
        fail(c, c->stopping ? BC_CLOSE_TIMEOUT : BC_OPEN_TIMEOUT, now_ms);
        if (!c->closed) c->phase = BC_QUARANTINED;
    } else if (c->phase == BC_DRAINING && now_ms >= c->deadline) {
        fail(c, BC_DRAIN_TIMEOUT, now_ms);
    }
}

static enum bc_error copy_slot(struct bc_capture *c, struct bc_slot *s, void *out,
                               size_t capacity, struct bc_frame_info *info) {
    if (!out || !info || capacity < s->length) return BC_BUFFER_SMALL;
    memcpy(out, s->bytes, s->length);
    *info = (struct bc_frame_info){ c->generation, s->sequence, s->length };
    return BC_OK;
}

enum bc_error bc_capture_copy_next(struct bc_capture *c, void *out, size_t capacity,
                                   struct bc_frame_info *info) {
    if (c->in_flight >= BC_AUDIO_WINDOW) return BC_BAD_STATE;
    for (size_t i = 0; i < c->count; ++i) {
        struct bc_slot *s = &c->slots[(c->head + i) % BC_AUDIO_SLOTS];
        if (s->sent) continue;
        enum bc_error error = copy_slot(c, s, out, capacity, info);
        if (error != BC_OK) return error;
        s->sent = true; ++c->in_flight; c->last_sent = s->sequence; return BC_OK;
    }
    return BC_BAD_STATE;
}

enum bc_error bc_capture_copy_retry(struct bc_capture *c, uint32_t sequence,
    void *out, size_t capacity, struct bc_frame_info *info) {
    for (size_t i = 0; i < c->count; ++i) {
        struct bc_slot *s = &c->slots[(c->head + i) % BC_AUDIO_SLOTS];
        if (s->sequence == sequence && s->sent) return copy_slot(c, s, out, capacity, info);
    }
    return BC_BAD_ACK;
}

enum bc_error bc_capture_ack(struct bc_capture *c, uint64_t generation, uint32_t sequence) {
    if (generation != c->generation) return BC_STALE;
    if (sequence <= c->acknowledged) return BC_OK;
    if (sequence > c->last_sent || !c->count) return BC_BAD_ACK;
    while (c->count && c->slots[c->head].sequence <= sequence) {
        struct bc_slot *s = &c->slots[c->head];
        if (!s->sent) return BC_BAD_ACK;
        memset(s, 0, sizeof(*s)); c->head = (c->head + 1) % BC_AUDIO_SLOTS;
        --c->count; --c->in_flight;
    }
    c->acknowledged = sequence;
    if (c->closed) finish(c);
    return BC_OK;
}
