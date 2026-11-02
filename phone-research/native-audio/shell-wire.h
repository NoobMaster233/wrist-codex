/* Firmware-independent command/file framing. No OS calls or execution. */
#ifndef BC_SHELL_WIRE_H
#define BC_SHELL_WIRE_H
#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>
#include "event-wire.h"
#define BC_SHELL_HEADER_BYTES 28u
#define BC_SHELL_MAX_COMMAND 1024u
#define BC_SHELL_MAX_OUTPUT 32768u
#define BC_SHELL_REQUEST_EVENT "bc.shell.req"
#define BC_SHELL_RESPONSE_EVENT "bc.shell.evt"
#define BC_SHELL_NATIVE "dev.bandcodex.shell"
enum bc_shell_flags {
 BC_SHELL_TIMEOUT=1,BC_SHELL_OUTPUT_LIMIT=2,BC_SHELL_UNKNOWN=4,
 BC_SHELL_TRUNCATED=8,BC_SHELL_SPAWN_FAILED=16,BC_SHELL_IO_FAILED=32,
 BC_SHELL_CLEANUP_FAILED=64,BC_SHELL_DUPLICATE=128
};
struct bc_shell_request {
 uint32_t timeout_ms,output_limit,command_bytes,command_crc;
 const uint8_t *command;
};
struct bc_shell_status {
 uint8_t magic[8];uint32_t version,phase;
 int32_t pid,wait_pid,raw_status,error;
 uint32_t elapsed_ms,flags,output_bytes,command_crc,timeout_ms,reserved[3];
};
_Static_assert(sizeof(struct bc_shell_status)==64,"shell status frame");
uint32_t bc_shell_crc32(const uint8_t *data,size_t len);
bool bc_shell_parse_request(const uint8_t *data,size_t len,struct bc_shell_request *out);
bool bc_shell_uuid(const char *id);
bool bc_shell_parse_event(const struct bc_user_event *event,char id[37],bool *ping);
bool bc_shell_reply(struct bc_user_event *event,const char *id,const char *operation,
 int32_t raw_status,uint32_t flags,uint32_t output_bytes,int32_t error);
#endif
