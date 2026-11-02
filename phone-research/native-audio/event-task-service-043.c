/* .043 diagnostic: independent, bounded uORB ping/pong task. No microphone.
 * Entry points and the task-create/24-byte poll ABI layouts were checked in the pinned AP.
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
static uint32_t thread_id, worker_entered;

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
  s->stage=stage;s->thread_id=__atomic_load_n(&thread_id,__ATOMIC_ACQUIRE);
  void *f=open_fn("/data/files/dev.bandcodex.remote/bc-native-event-043-v3a.status","wb");
  if(f){(void)write_fn(s,1,sizeof(*s),f);(void)close_fn(f);}
}
static struct event_status initial_status(void){
  struct event_status s={{'B','C','E','V','T','4','3','1'},1,0,-99,-1,0,0,0,0,0,-99,0,{0,0,0}};
  return s;
}
static int worker(int argc,char **argv){
  (void)argc;(void)argv;
  __atomic_store_n(&worker_entered,1,__ATOMIC_RELEASE);
  struct event_status s=initial_status();
  struct bc_user_event input,output;
  s.create_result=0;status(&s,2);s.fd=SUBSCRIBE(USER_META,0);
  if(s.fd<0){status(&s,12);return 0;}
  bc_event_ready(&output,true);
  s.last_result=PUBLISH(USER_META,&output);
  if(s.last_result<0){s.close_result=UNSUBSCRIBE(s.fd);status(&s,15);return 0;}
  s.published++;status(&s,2);
  for(unsigned i=0;i<60;i++){
    struct poll043 p={s.fd,1,0,0,0,0};
    s.polls++;
    s.last_result=POLL(&p,1,10000);
    if(s.last_result<0||(p.revents&0x38)){
      int *(*errno_fn)(void)=(void *)0x0c1e45bd;s.reserved[0]=(uint32_t)*errno_fn();s.reserved[1]=p.revents;
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
  int (*create)(const char *,int,void *,int,int (*)(int,char **),char *const *)=(void *)0x0c208b49;
  int (*usleep_fn)(uint32_t)=(void *)0x0c1f5d0d;
  struct event_status s=initial_status();status(&s,0);
  status(&s,1);
  int pid=create("bc_evt043",100,0,8192,worker,0);
  if(pid<0){s.create_result=pid;int *(*errno_fn)(void)=(void *)0x0c1e45bd;s.reserved[0]=(uint32_t)*errno_fn();status(&s,11);return;}
  __atomic_store_n(&thread_id,(uint32_t)pid,__ATOMIC_RELEASE);
  for(unsigned i=0;i<100;i++){
    if(__atomic_load_n(&worker_entered,__ATOMIC_ACQUIRE))return;
    (void)usleep_fn(10000);
  }
  /* The task may still enter later. Keep its executable storage; never claim
   * the returned pid proves it ran, and never unload it on this timeout. */
  s.create_result=pid;status(&s,20);
}
void bc_event043_anchor(void){}
__asm__(".section .init_array,\"aw\",%init_array\n.balign 4\n.word bc_event043_ctor\n.previous");
