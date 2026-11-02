/* Portable, host-tested prototype. No firmware calls, device entry or loader.
 * All calls must be serialized by a future platform adapter. The adapter must
 * copy callbacks onto that executor before the firmware frees their buffers.
 */
#ifndef BAND_CODEX_CAPTURE_CORE_H
#define BAND_CODEX_CAPTURE_CORE_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define BC_AUDIO_SLOTS 8u
#define BC_AUDIO_FRAME_MAX 4096u
#define BC_AUDIO_WINDOW 4u
#define BC_AUDIO_TOTAL_MAX (128u * 1024u)
#define BC_AUDIO_DURATION_MS 24000u
#define BC_AUDIO_OPEN_TIMEOUT_MS 5000u
/* The recovered Opus close path contains a 6000 ms wait. A timeout here is
 * an error report, never evidence that the native worker has stopped. */
#define BC_AUDIO_CLOSE_TIMEOUT_MS 10000u
#define BC_AUDIO_DRAIN_TIMEOUT_MS 15000u

enum bc_phase { BC_IDLE, BC_OPENING, BC_RECORDING, BC_STOPPING,
    BC_DRAINING, BC_COMPLETE, BC_CANCELLED, BC_FAILED, BC_QUARANTINED };
enum bc_error { BC_OK, BC_BAD_STATE, BC_STALE, BC_BAD_ACK, BC_BUFFER_SMALL,
    BC_OVERFLOW, BC_FRAME_TOO_LARGE, BC_CAPTURE_ERROR, BC_OPEN_TIMEOUT,
    BC_CLOSE_TIMEOUT, BC_DRAIN_TIMEOUT, BC_BYTE_LIMIT };
enum bc_command_kind { BC_OPEN, BC_READ, BC_CLOSE };
struct bc_command { enum bc_command_kind kind; uint64_t generation; uint32_t handle; };
struct bc_frame_info { uint64_t generation; uint32_t sequence; size_t length; };
struct bc_slot { uint32_t sequence; size_t length; bool sent; uint8_t bytes[BC_AUDIO_FRAME_MAX]; };
/* Allocate this context outside the small device callback stack. */
struct bc_capture {
    enum bc_phase phase;
    enum bc_error error;
    uint64_t generation, opened_at, deadline;
    uint32_t handle, next_sequence, acknowledged, last_sent;
    size_t total_bytes, head, count, in_flight;
    bool opened, closed, stopping, cancelled, close_issued;
    bool open_pending, read_pending, close_pending;
    struct bc_slot slots[BC_AUDIO_SLOTS];
};

/* Initialize once before any native request. Reinitialization is never a
 * substitute for stopping/quiescing a live session. Use begin() to reuse. */
void bc_capture_init(struct bc_capture *c);
enum bc_error bc_capture_begin(struct bc_capture *c, uint64_t now_ms);
bool bc_capture_command(struct bc_capture *c, struct bc_command *out);
void bc_capture_opened(struct bc_capture *c, uint64_t generation,
                       int status, uint32_t handle, uint64_t now_ms);
enum bc_error bc_capture_frame(struct bc_capture *c, uint64_t generation,
    uint32_t handle, int status, const void *bytes, size_t length, uint64_t now_ms);
void bc_capture_stop(struct bc_capture *c, bool cancel, uint64_t now_ms);
/* Call ONLY after a verified worker/queue barrier guarantees no future
 * callbacks for this generation. CLOSE submission/return is insufficient.
 * There is currently no implementation of that barrier on firmware .043. */
bool bc_capture_quiesced(struct bc_capture *c, uint64_t generation, uint32_t handle,
                         uint64_t now_ms);
void bc_capture_tick(struct bc_capture *c, uint64_t now_ms);
enum bc_error bc_capture_copy_next(struct bc_capture *c, void *out, size_t capacity,
                                   struct bc_frame_info *info);
enum bc_error bc_capture_copy_retry(struct bc_capture *c, uint32_t sequence,
    void *out, size_t capacity, struct bc_frame_info *info);
enum bc_error bc_capture_ack(struct bc_capture *c, uint64_t generation, uint32_t sequence);
bool bc_capture_releasable(const struct bc_capture *c);
#endif
