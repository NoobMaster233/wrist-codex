#include "capture-core.h"
#include "abi-layout.h"
#include "command-builder.h"
#include "feature-layout.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static struct bc_capture capture;
static uint8_t input[BC_AUDIO_FRAME_MAX + 1], output[BC_AUDIO_FRAME_MAX];
static struct bc_frame_info info;

static void command(enum bc_command_kind kind) {
    struct bc_command cmd;
    assert(bc_capture_command(&capture, &cmd));
    assert(cmd.kind == kind && cmd.generation == capture.generation);
    assert(cmd.handle == (kind == BC_OPEN ? 0 : 77));
}
static void no_command(void) {
    struct bc_command cmd; assert(!bc_capture_command(&capture, &cmd));
}
static void opening(void) {
    bc_capture_init(&capture); assert(bc_capture_releasable(&capture));
    assert(bc_capture_begin(&capture, 0) == BC_OK); command(BC_OPEN);
}
static void recording(void) {
    opening(); bc_capture_opened(&capture, capture.generation, 0, 77, 10);
    command(BC_READ); assert(capture.phase == BC_RECORDING); no_command();
}
static void frame(size_t n) {
    assert(bc_capture_frame(&capture, capture.generation, 77, 0, input, n, 20) == BC_OK);
}
static void quiesce(void) {
    assert(bc_capture_quiesced(&capture, capture.generation, 77, 100));
}
static void normal_and_copy_lifetime(void) {
    recording(); memset(input, 0x42, 80); frame(80); memset(input, 0, 80);
    assert(bc_capture_copy_next(&capture, output, sizeof(output), &info) == BC_OK);
    assert(info.sequence == 1 && info.length == 80 && output[0] == 0x42 && output[79] == 0x42);
    assert(!bc_capture_quiesced(&capture, capture.generation, 77, 21));
    bc_capture_stop(&capture, false, 30); command(BC_CLOSE); no_command();
    assert(!bc_capture_releasable(&capture)); quiesce();
    assert(capture.phase == BC_DRAINING);
    assert(bc_capture_ack(&capture, capture.generation, 1) == BC_OK);
    assert(capture.phase == BC_COMPLETE && bc_capture_releasable(&capture));
}
static void credits_retry_and_ack(void) {
    recording(); for (size_t i = 0; i < BC_AUDIO_SLOTS; ++i) frame(80);
    assert(bc_capture_copy_next(&capture, output, 1, &info) == BC_BUFFER_SMALL);
    assert(capture.in_flight == 0);
    for (size_t i = 0; i < BC_AUDIO_WINDOW; ++i)
        assert(bc_capture_copy_next(&capture, output, sizeof(output), &info) == BC_OK);
    assert(bc_capture_copy_next(&capture, output, sizeof(output), &info) == BC_BAD_STATE);
    assert(bc_capture_ack(&capture, capture.generation, 5) == BC_BAD_ACK);
    assert(capture.count == BC_AUDIO_SLOTS);
    assert(bc_capture_ack(&capture, capture.generation, 2) == BC_OK);
    assert(capture.in_flight == 2 && capture.count == BC_AUDIO_SLOTS - 2);
    assert(bc_capture_copy_retry(&capture, 3, output, sizeof(output), &info) == BC_OK);
    assert(info.sequence == 3 && capture.in_flight == 2);
    assert(bc_capture_copy_retry(&capture, 1, output, sizeof(output), &info) == BC_BAD_ACK);
    assert(bc_capture_ack(&capture, capture.generation, 1) == BC_OK);
    assert(capture.in_flight == 2);
}
static void cancel_before_open_result(void) {
    opening(); bc_capture_stop(&capture, true, 20); no_command();
    assert(!bc_capture_releasable(&capture));
    bc_capture_opened(&capture, capture.generation, 0, 77, 30);
    command(BC_CLOSE); no_command(); quiesce();
    assert(capture.phase == BC_CANCELLED && bc_capture_releasable(&capture));
}
static void failed_open(void) {
    opening(); bc_capture_opened(&capture, capture.generation, -1, 0, 10);
    assert(capture.phase == BC_FAILED && capture.error == BC_CAPTURE_ERROR);
    assert(bc_capture_releasable(&capture)); no_command();
}
static void cancel_before_open_is_submitted(void) {
    bc_capture_init(&capture); assert(bc_capture_begin(&capture, 0) == BC_OK);
    bc_capture_stop(&capture, true, 1); no_command();
    assert(capture.phase == BC_CANCELLED && bc_capture_releasable(&capture));
}
static void late_open_after_timeout(void) {
    opening(); bc_capture_tick(&capture, BC_AUDIO_OPEN_TIMEOUT_MS);
    assert(capture.phase == BC_QUARANTINED && capture.error == BC_OPEN_TIMEOUT);
    assert(bc_capture_begin(&capture, 6000) == BC_BAD_STATE);
    bc_capture_opened(&capture, capture.generation, 0, 77, 7000);
    command(BC_CLOSE); no_command(); quiesce();
    assert(capture.phase == BC_FAILED && bc_capture_releasable(&capture));
}
static void close_timeout_is_not_cleanup(void) {
    recording(); bc_capture_stop(&capture, false, 30); command(BC_CLOSE);
    bc_capture_tick(&capture, 30 + BC_AUDIO_CLOSE_TIMEOUT_MS);
    assert(capture.phase == BC_QUARANTINED && !bc_capture_releasable(&capture));
    assert(bc_capture_begin(&capture, 20000) == BC_BAD_STATE);
    assert(!bc_capture_quiesced(&capture, capture.generation, 78, 20000));
    quiesce(); assert(capture.phase == BC_FAILED);
}
static void queue_overflow_stops_instead_of_corrupting_audio(void) {
    recording(); for (size_t i = 0; i < BC_AUDIO_SLOTS; ++i) frame(80);
    assert(bc_capture_frame(&capture, capture.generation, 77, 0, input, 80, 20) == BC_OVERFLOW);
    assert(capture.error == BC_OVERFLOW && capture.count == 0); command(BC_CLOSE);
    assert(bc_capture_frame(&capture, capture.generation, 77, 0, input, 80, 20) == BC_BAD_STATE);
    quiesce(); assert(capture.phase == BC_FAILED);
}
static void duration_and_normal_clock_ticks(void) {
    recording(); bc_capture_tick(&capture, 10000);
    assert(capture.phase == BC_RECORDING && capture.error == BC_OK);
    bc_capture_tick(&capture, 10 + BC_AUDIO_DURATION_MS); command(BC_CLOSE);
    assert(capture.phase == BC_STOPPING); quiesce(); assert(capture.phase == BC_COMPLETE);
    recording();
    assert(bc_capture_frame(&capture, capture.generation, 77, 0, input, 80,
        10 + BC_AUDIO_DURATION_MS) == BC_BAD_STATE);
    command(BC_CLOSE);
}
static void byte_limit(void) {
    recording();
    for (size_t n = 0; n < BC_AUDIO_TOTAL_MAX / BC_AUDIO_FRAME_MAX; ++n) {
        frame(BC_AUDIO_FRAME_MAX);
        assert(bc_capture_copy_next(&capture, output, sizeof(output), &info) == BC_OK);
        assert(bc_capture_ack(&capture, info.generation, info.sequence) == BC_OK);
    }
    assert(bc_capture_frame(&capture, capture.generation, 77, 0, input, 1, 20) == BC_BYTE_LIMIT);
    command(BC_CLOSE); quiesce(); assert(capture.phase == BC_FAILED);
}
static void oversize_and_native_errors(void) {
    recording();
    assert(bc_capture_frame(&capture, capture.generation, 77, 0, input, sizeof(input), 20) == BC_FRAME_TOO_LARGE);
    command(BC_CLOSE); quiesce();
    recording();
    assert(bc_capture_frame(&capture, capture.generation, 77, -1, NULL, 0, 20) == BC_CAPTURE_ERROR);
    command(BC_CLOSE); quiesce();
}
static void stale_generation_cannot_affect_next_capture(void) {
    recording(); uint64_t old = capture.generation;
    bc_capture_stop(&capture, true, 20); command(BC_CLOSE); quiesce();
    assert(bc_capture_begin(&capture, 200) == BC_OK); command(BC_OPEN);
    assert(capture.generation != old);
    bc_capture_opened(&capture, old, 0, 77, 201); assert(!capture.opened);
    bc_capture_opened(&capture, capture.generation, 0, 77, 201); command(BC_READ);
    assert(bc_capture_frame(&capture, old, 77, 0, input, 80, 202) == BC_STALE);
    assert(bc_capture_ack(&capture, old, 1) == BC_STALE && capture.count == 0);
}
static void drain_timeout_and_disconnect(void) {
    recording(); frame(80); bc_capture_stop(&capture, false, 30); command(BC_CLOSE); quiesce();
    bc_capture_tick(&capture, 100 + BC_AUDIO_DRAIN_TIMEOUT_MS);
    assert(capture.phase == BC_FAILED && capture.error == BC_DRAIN_TIMEOUT);
    assert(bc_capture_releasable(&capture));
    recording(); frame(80); bc_capture_stop(&capture, true, 30); command(BC_CLOSE);
    assert(capture.count == 0 && !bc_capture_releasable(&capture)); quiesce();
    assert(capture.phase == BC_CANCELLED);
}
static void commands_do_not_reuse_vas_storage_or_close_zero_handle(void) {
    /* Dummy encoded addresses, not dereferenced or used on a device. */
    const struct bc_command_addresses addresses = { 0x100, 0x200, 0x300, 0x401 };
    struct bc_command cmd = { BC_OPEN, 1, 0 };
    struct candidate_media_command_layout encoded;
    assert(bc_build_media_command(&cmd, &addresses, &encoded));
    assert(encoded.command == 0x26 && encoded.owner_word == 0x100 && encoded.session_handle == 0);
    assert(encoded.callback_address == 0x401 && encoded.path_or_scratch[0] == 0);
    assert(strstr((char *)encoded.options, "format=opusraw:") == (char *)encoded.options);
    assert(strstr((char *)encoded.options, "b=32000:vbr=0:") != NULL);
    cmd.kind = BC_CLOSE; assert(!bc_build_media_command(&cmd, &addresses, &encoded));
    cmd.handle = 77; assert(bc_build_media_command(&cmd, &addresses, &encoded));
    assert(encoded.command == 0x24 && encoded.session_handle == 77 && encoded.callback_address == 0);
    for (size_t n = 0; n < sizeof(encoded.options); ++n) assert(encoded.options[n] == 0);
    cmd.kind = BC_READ; assert(bc_build_media_command(&cmd, &addresses, &encoded));
    assert(encoded.command == 0x25);
}
#define RUN(fn) do { fn(); puts(#fn); } while (0)
int main(void) {
    RUN(normal_and_copy_lifetime); RUN(credits_retry_and_ack); RUN(cancel_before_open_result);
    RUN(failed_open); RUN(cancel_before_open_is_submitted);
    RUN(late_open_after_timeout); RUN(close_timeout_is_not_cleanup);
    RUN(queue_overflow_stops_instead_of_corrupting_audio); RUN(duration_and_normal_clock_ticks);
    RUN(byte_limit); RUN(oversize_and_native_errors);
    RUN(stale_generation_cannot_affect_next_capture); RUN(drain_timeout_and_disconnect);
    RUN(commands_do_not_reuse_vas_storage_or_close_zero_handle);
    return 0;
}
