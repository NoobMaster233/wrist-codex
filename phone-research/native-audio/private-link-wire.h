#ifndef BC_PRIVATE_LINK_WIRE_H
#define BC_PRIVATE_LINK_WIRE_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#define BC_LINK_MAX_PAYLOAD 32768u
#define BC_LINK_HEADER 16u
enum bc_link_type {BC_LINK_HELLO=1,BC_LINK_CHALLENGE,BC_LINK_AUTH,BC_LINK_READY,
 BC_LINK_JSON,BC_LINK_ACK,BC_LINK_PING,BC_LINK_PONG,BC_LINK_ERROR,BC_LINK_STOP,
 BC_LINK_MANAGEMENT,BC_LINK_MANAGEMENT_REPLY};
struct bc_link_decoder {uint32_t used,expected;uint8_t data[BC_LINK_HEADER+BC_LINK_MAX_PAYLOAD];};
typedef bool (*bc_link_frame_cb)(void *,uint8_t,uint32_t,const uint8_t *,size_t);
uint32_t bc_link_crc32(const uint8_t *,size_t,uint32_t);
void bc_link_sha256(const uint8_t *,size_t,uint8_t [32]);
void bc_link_hmac(const uint8_t [32],const uint8_t *,size_t,uint8_t [32]);
bool bc_link_equal(const uint8_t *,const uint8_t *,size_t);
size_t bc_link_frame(uint8_t *,size_t,uint8_t,uint32_t,const uint8_t *,size_t);
void bc_link_decoder_init(struct bc_link_decoder *);
bool bc_link_feed(struct bc_link_decoder *,const uint8_t *,size_t,bc_link_frame_cb,void *);
#endif
