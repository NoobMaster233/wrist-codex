/* .043 diagnostic: detached, bounded uORB ping/pong worker. No microphone.
 * Entry points and the 12/24-byte ABI layouts were checked in the pinned AP.
 * Module code stays loaded after the worker exits; do not rmmod it live.
 */
#include <stdint.h>
#include <stddef.h>
#include "event-wire.h"

struct poll043 {
  int32_t fd;
  uint32_t events, revents, arg, callback, priv;
};
_Static_assert(sizeof(struct poll043)==24,".043 pollfd stride");
struct event_status {
  uint8_t magic[8];
  uint32_t version, stage;
  int32_t create_result, fd;
  uint32_t seen, accepted, published, polls;
  int32_t last_result, close_result;
  uint32_t thread_id, reserved[3];
};
_Static_assert(sizeof(struct event_status)==64,"event status");
static uint32_t thread_id;

#define USER_META ((const void *)(uintptr_t)0x2cda393c)
#define PUBLISH ((int (*)(const void *,const void *))(uintptr_t)0x0c2e64ad)
#define SUBSCRIBE ((int (*)(const void *,unsigned))(uintptr_t)0x0c2e97ad)
#define COPY ((int (*)(int,void *,size_t))(uintptr_t)0x0c2e97c5)
#define UNSUBSCRIBE ((int (*)(int))(uintptr_t)0x0c2e9651)
#define POLL ((int (*)(struct poll043 *,unsigned,int))(uintptr_t)0x0c1d0d1d)

static void status(struct event_status *s,uint32_t stage){
  void *(*open_fn)(const char *,const char *)=(void *)0x0c1eadcd;
  size_t (*write_fn)(const void *,size_t,size_t,void *)=(void *)0x0c1eb54d;
  int (*close_fn)(void *)=(void *)0x0c1eaea1;
  s->stage=stage;s->thread_id=thread_id;
  void *f=open_fn("/data/files/dev.bandcodex.remote/bc-native-event-043-v2.status","wb");
  if(f){(void)write_fn(s,1,sizeof(*s),f);(void)close_fn(f);}
}
static struct event_status initial_status(void){
  struct event_status s={{'B','C','E','V','T','4','3','1'},1,0,-99,-1,0,0,0,0,0,-99,0,{0,0,0}};
  return s;
}
static void *worker(void *arg){
  (void)arg;
  struct event_status s=initial_status();
  struct bc_user_event input,output;
  s.create_result=0;s.fd=SUBSCRIBE(USER_META,0);
  if(s.fd<0){status(&s,12);return 0;}
  bc_event_ready(&output,true);
  s.last_result=PUBLISH(USER_META,&output);
  if(s.last_result<0){s.close_result=UNSUBSCRIBE(s.fd);status(&s,15);return 0;}
  s.published++;status(&s,2);
  for(unsigned i=0;i<300;i++){
    struct poll043 p={s.fd,1,0,0,0,0};
    s.polls++;
    s.last_result=POLL(&p,1,1000);
    if(s.last_result<0||(p.revents&0x38)){
      s.close_result=UNSUBSCRIBE(s.fd);status(&s,13);return 0;
    }
    if(!(p.revents&1))continue;
    s.last_result=COPY(s.fd,&input,sizeof(input));
    if(s.last_result!=(int)sizeof(input)){
      s.close_result=UNSUBSCRIBE(s.fd);status(&s,14);return 0;
    }
    s.seen++;
    if(!bc_event_reply(&input,&output))continue;
    s.accepted++;
    s.last_result=PUBLISH(USER_META,&output);
    if(s.last_result<0){s.close_result=UNSUBSCRIBE(s.fd);status(&s,15);return 0;}
    s.published++;status(&s,2);
  }
  s.close_result=UNSUBSCRIBE(s.fd);status(&s,3);return 0;
}
__attribute__((used)) static void bc_event043_ctor(void){
  int (*attr_init)(void *)=(void *)0x0c1e9855;
  int (*attr_stack)(void *,size_t)=(void *)0x0c1e98a5;
  int (*attr_destroy)(void *)=(void *)0x0c1e9881;
  int (*create)(uint32_t *,const void *,void *(*)(void *),void *)=(void *)0x0c1e9a11;
  struct event_status s=initial_status();uint32_t attr[3];status(&s,0);
  s.last_result=attr_init(attr);
  if(s.last_result){status(&s,10);return;}
  s.last_result=attr_stack(attr,8192);
  if(s.last_result){(void)attr_destroy(attr);status(&s,10);return;}
  /* Actual .043 pthread_create reads detachstate at byte 3 (not dev headers).
   * Only our initialized attribute object is modified. Detached task exit
   * reclaims the RTOS thread; executable module storage stays resident.
   */
  ((uint8_t *)attr)[3]=1;
  status(&s,1);
  s.create_result=create(&thread_id,attr,worker,0);
  (void)attr_destroy(attr);
  if(s.create_result)status(&s,11);
}
void bc_event043_anchor(void){}
__asm__(".section .init_array,\"aw\",%init_array\n.balign 4\n.word bc_event043_ctor\n.previous");
