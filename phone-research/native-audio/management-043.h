#ifndef BC_MANAGEMENT_043_H
#define BC_MANAGEMENT_043_H
#include <stdint.h>
#include <stddef.h>
#define BC_MGMT_REQUEST 16u
#define BC_MGMT_REPLY 12u
#define BC_MGMT_BLOCK 4096u
#define BC_MGMT_MAX_FILE 1048576u
enum bc_mgmt_op {BC_MGMT_STAT=1,BC_MGMT_READ,BC_MGMT_WRITE,BC_MGMT_MOVE,
 BC_MGMT_DELETE,BC_MGMT_EXEC,BC_MGMT_CAPS};
/* Called only by the authenticated Link I/O actor; buffers may not alias. */
size_t bc_management_handle(const uint8_t *,size_t,uint8_t *,size_t);
#endif
