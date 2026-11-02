/* Verified against p67cn 3.101.043 AP SHA256 519307675665e4866d722a8119a98589
 * c397b614ac3294cb87bfc86de45756ec and live bttool callback table. These are
 * firmware addresses, not a portable openVela ABI. Never use after an update.
 */
#ifndef BC_PRIVATE_SPP_043_H
#define BC_PRIVATE_SPP_043_H
#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

#define BC043_AT(type,address) ((type)(uintptr_t)(address))
#define BC043_CREATE BC043_AT(int (*)(const char *,int,void *,int,int (*)(int,char **),char *const *),0x0c208b49)
#define BC043_SLEEP BC043_AT(int (*)(uint32_t),0x0c1f5d0d)
#define BC043_CLOCK BC043_AT(uint64_t (*)(void),0x0c2e987d)
#define BC043_MALLOC BC043_AT(void *(*)(size_t),0x0c1f903d)
#define BC043_FREE BC043_AT(void (*)(void *),0x0c1f8ff9)
#define BC043_FOPEN BC043_AT(void *(*)(const char *,const char *),0x0c1eadcd)
#define BC043_FREAD BC043_AT(size_t (*)(void *,size_t,size_t,void *),0x0c1eafd1)
#define BC043_FWRITE BC043_AT(size_t (*)(const void *,size_t,size_t,void *),0x0c1eb54d)
#define BC043_FCLOSE BC043_AT(int (*)(void *),0x0c1eaea1)
#define BC043_ERRNO BC043_AT(int *(*)(void),0x0c1e45bd)
#define BC043_EVENT_META ((const void *)(uintptr_t)0x2cda393c)
#define BC043_EVENT_PUBLISH BC043_AT(int (*)(const void *,const void *),0x0c2e64ad)
#define BC043_EVENT_SUBSCRIBE BC043_AT(int (*)(const void *,unsigned),0x0c2e97ad)
#define BC043_EVENT_COPY BC043_AT(int (*)(int,void *,size_t),0x0c2e97c5)
#define BC043_EVENT_UNSUBSCRIBE BC043_AT(int (*)(int),0x0c2e9651)
#define BC043_POLL BC043_AT(int (*)(void *,unsigned,int),0x0c1d0d1d)
struct bc043_poll {int32_t fd;uint32_t events,revents,arg,callback,priv;};
_Static_assert(sizeof(struct bc043_poll)==24,".043 poll");
#define BC043_BT_CREATE BC043_AT(void *(*)(void),0x0c3af1a9)
#define BC043_BT_DELETE BC043_AT(void (*)(void *),0x0c3af24d)
#define BC043_LOOP_INIT BC043_AT(int (*)(void *),0x0c3aa2f5)
#define BC043_LOOP_RUN BC043_AT(int (*)(void *,bool,const char *),0x0c3aa381)
#define BC043_LOOP_EXIT BC043_AT(void (*)(void *),0x0c3aa475)
#define BC043_LOOP_DO BC043_AT(void (*)(void *,void (*)(void *),void *),0x0c3aa5ed)
typedef void (*bc043_pipe_connect_cb)(void *,int,void *);
typedef void (*bc043_pipe_read_cb)(void *,const uint8_t *,int32_t);
typedef void (*bc043_pipe_write_cb)(void *,uint8_t *,int);
#define BC043_PIPE_CONNECT BC043_AT(void *(*)(void *,const char *,bc043_pipe_connect_cb,void *),0x0c3a9cad)
#define BC043_PIPE_READ BC043_AT(int (*)(void *,uint16_t,bc043_pipe_read_cb,void *),0x0c3a9a75)
#define BC043_PIPE_WRITE BC043_AT(int (*)(void *,uint8_t *,int,bc043_pipe_write_cb),0x0c3a9bfd)
#define BC043_PIPE_CLOSE BC043_AT(void (*)(void *),0x0c3aa051)
struct bc043_spp_callbacks {
 uint32_t bytes;
 void (*pty)(void *,const void *,uint16_t,uint16_t,char *);
 void (*state)(void *,const void *,uint16_t,uint16_t,int);
 void (*proxy)(void *,const void *,int,uint16_t,uint16_t,char *);
};
struct bc043_uuid {uint8_t type,reserved[3],little_endian[16];};
struct bc043_loop {uint64_t words[0x270/8];};
#define BC043_SPP_REGISTER BC043_AT(void *(*)(void *,const char *,const struct bc043_spp_callbacks *),0x0c3b1435)
/* This .043 wrapper returns a boolean, unlike newer public bt_status_t APIs. */
#define BC043_SPP_UNREGISTER BC043_AT(int (*)(void *,void *),0x0c3b14e1)
#define BC043_SPP_START BC043_AT(int (*)(void *,void *,uint16_t,const struct bc043_uuid *,uint8_t),0x0c3b152d)
_Static_assert(sizeof(struct bc043_uuid)==20,".043 UUID");
_Static_assert(sizeof(struct bc043_spp_callbacks)==16,".043 callbacks");
_Static_assert(sizeof(struct bc043_loop)==0x270,".043 loop");
_Static_assert(sizeof(void *)==4,".043 pointers");
#endif
