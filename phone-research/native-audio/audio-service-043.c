/* Firmware 3.101.043 only. Independent event-driven capture task.
 * No stock Recorder UI/sync or firmware writes. Never unload this module live.
 */
#include <stdint.h>
#include <stddef.h>
#include "event-wire.h"

#define CAPACITY 65536u
#define LIMIT_US 24000000u
#define META ((const void *)(uintptr_t)0x2cda393c)
#define PUBLISH ((int (*)(const void *,const void *))(uintptr_t)0x0c2e64ad)
#define SUBSCRIBE ((int (*)(const void *,unsigned))(uintptr_t)0x0c2e97ad)
#define COPY ((int (*)(int,void *,size_t))(uintptr_t)0x0c2e97c5)
#define UNSUBSCRIBE ((int (*)(int))(uintptr_t)0x0c2e9651)
#define POLL ((int (*)(void *,unsigned,int))(uintptr_t)0x0c1d0d1d)
#define NOW_US ((uint64_t (*)(void))(uintptr_t)0x0c2e987d)
#define BUSY ((uint32_t (*)(void))(uintptr_t)0x0c220a5d)
#define CONFIGURE ((int (*)(const void *))(uintptr_t)0x0c220a29)
typedef int (*encoded_callback)(const void *,uint32_t);
#define OPEN ((int (*)(int,encoded_callback,int,int))(uintptr_t)0x0c220a69)
#define START ((int (*)(int))(uintptr_t)0x0c220bb9)
#define CLOSE ((int (*)(int))(uintptr_t)0x0c220b21)
#define TASK_EXISTS ((void *(*)(uint32_t))(uintptr_t)0x0c205911)
#define USLEEP ((int (*)(uint32_t))(uintptr_t)0x0c1f5d0d)

struct poll043 { int32_t fd;uint32_t events,revents,arg,callback,priv; };
struct header {
  uint8_t magic[8];uint32_t version,rate,frame_ms,duration_ms;
  int32_t open_result,start_result,close_result;
  uint32_t frames,bytes,dropped,busy,config_result,busy_after,stage;
};
_Static_assert(sizeof(struct poll043)==24,"poll ABI");
_Static_assert(sizeof(struct header)==64,"BCAP header");
static struct {
  uint32_t active,locked,used,frames,dropped,overflow;
  uint8_t data[CAPACITY];
} capture;
static uint32_t entered,owns_encoder,started_at,encoder_tid,quarantined;
static char owner[33],last_op[12];
static struct header result;

static int text_equal(const char *field,size_t capacity,const char *text){
  for(size_t i=0;i<capacity;i++){if(field[i]!=text[i])return 0;if(!text[i])return 1;}
  return 0;
}
static char *append(char *p,const char *s){while(*s)*p++=*s++;*p=0;return p;}
static void clear(void *p,size_t n){uint8_t *b=p;for(size_t i=0;i<n;i++)b[i]=0;}
static void number(char *p,uint32_t value){
  char reversed[10];unsigned used=0;
  do{reversed[used++]=(char)('0'+value%10);value/=10;}while(value);
  while(used)*p++=reversed[--used];
  *p=0;
}
static int command(const struct bc_user_event *event,char nonce[33]){
  const char *ops[] = {"ping","start","stop","cancel","status"};
  if(!text_equal(event->name,32,BC_EVENT_REQUEST)||!text_equal(event->package,32,BC_EVENT_APP)||
     !text_equal(event->permissions,64,BC_EVENT_APP))return -1;
  for(unsigned op=0;op<5;op++){
    char canonical[100];char *p=append(canonical,"{\"v\":2,\"op\":\"");
    p=append(p,ops[op]);p=append(p,"\",\"n\":\"");size_t offset=(size_t)(p-canonical);
    for(unsigned i=0;i<32;i++){
      unsigned char c=(unsigned char)event->params[offset+i];
      if(!((c>='0'&&c<='9')||(c>='a'&&c<='f')))goto next;
      nonce[i]=(char)c;*p++=(char)c;
    }
    nonce[32]=0;append(p,"\"}");
    if(text_equal(event->params,128,canonical))return (int)op;
next:;
  }
  return -1;
}
static int emit(const char *op,const char *nonce,uint32_t error){
  struct bc_user_event e;clear(&e,sizeof(e));
  append(e.name,BC_EVENT_RESPONSE);append(e.package,BC_EVENT_NATIVE);append(e.permissions,BC_EVENT_APP);
  char *p=append(e.params,"{\"v\":2,\"op\":\"");p=append(p,op);p=append(p,"\",\"n\":\"");
  p=append(p,nonce);p=append(p,"\",\"e\":");number(p,error);
  while(*p)p++;
  append(p,"}");
  return PUBLISH(META,&e);
}
static int save(const char *path,const void *data,size_t length,const void *extra,size_t extra_length){
  void *(*open_fn)(const char *,const char *)=(void *)0x0c1eadcd;
  size_t (*write_fn)(const void *,size_t,size_t,void *)=(void *)0x0c1eb54d;
  int (*close_fn)(void *)=(void *)0x0c1eaea1;
  void *f=open_fn(path,"wb");if(!f)return -1;
  int okay=write_fn(data,1,length,f)==length;
  if(extra_length)okay=okay&&write_fn(extra,1,extra_length,f)==extra_length;
  return close_fn(f)==0&&okay?0:-1;
}
static void status(uint32_t stage){
  result.stage=stage;
  (void)save("/data/files/dev.bandcodex.remote/bc-native-audio-service-043-v1.status",&result,sizeof(result),0,0);
}
static void path_for(char *path,const char *nonce){
  char *p=append(path,"/data/files/dev.bandcodex.remote/bc-audio-");p=append(p,nonce);append(p,".bcap");
}
static int exists(const char *path){
  void *(*open_fn)(const char *,const char *)=(void *)0x0c1eadcd;
  int (*close_fn)(void *)=(void *)0x0c1eaea1;
  void *f=open_fn(path,"rb");if(!f)return 0;(void)close_fn(f);return 1;
}
static int lock_capture(void){
  for(unsigned i=0;i<100;i++){
    uint32_t expected=0;
    if(__atomic_compare_exchange_n(&capture.locked,&expected,1,0,__ATOMIC_ACQUIRE,__ATOMIC_RELAXED))return 1;
    (void)USLEEP(1000);
  }
  return 0;
}
static int receive_encoded(const void *pointer,uint32_t length){
  uint32_t expected=0;
  if(!__atomic_load_n(&capture.active,__ATOMIC_ACQUIRE))return 0;
  if(!__atomic_compare_exchange_n(&capture.locked,&expected,1,0,__ATOMIC_ACQUIRE,__ATOMIC_RELAXED)){
    __atomic_fetch_add(&capture.dropped,1,__ATOMIC_RELAXED);return 0;
  }
  if(__atomic_load_n(&capture.active,__ATOMIC_RELAXED)){
    if(!pointer||!length||length>4096||capture.used>CAPACITY-4-length){
      __atomic_fetch_add(&capture.dropped,1,__ATOMIC_RELAXED);
      __atomic_store_n(&capture.overflow,1,__ATOMIC_RELEASE);
    }else{
      uint32_t offset=capture.used;const uint8_t *data=pointer;
      for(uint32_t i=0;i<4;i++)capture.data[offset+i]=(uint8_t)(length>>(i*8));
      for(uint32_t i=0;i<length;i++)capture.data[offset+4+i]=data[i];
      capture.used+=4+length;capture.frames++;
    }
  }
  __atomic_store_n(&capture.locked,0,__ATOMIC_RELEASE);return 0;
}
static void finish(int cancelled,uint32_t error){
  __atomic_store_n(&capture.active,0,__ATOMIC_RELEASE);
  if(owns_encoder){
    result.duration_ms=((uint32_t)NOW_US()-started_at)/1000;
    result.close_result=CLOSE(1);owns_encoder=0;result.busy_after=BUSY();
    /* The stock encoder creates a joinable worker and CLOSE joins it. Check
     * that its actual tid is gone before allowing a subsequent generation.
     * A nonzero lookup is conservatively quarantined, including pid reuse.
     */
    if(result.close_result||result.busy_after){error=16;quarantined=1;}
    else if(encoder_tid&&TASK_EXISTS(encoder_tid)){error=17;quarantined=1;}
  }
  if(!lock_capture()){status(12);quarantined=1;append(last_op,"error");(void)emit(last_op,owner,12);return;}
  result.frames=capture.frames;result.bytes=capture.used;
  result.dropped=__atomic_load_n(&capture.dropped,__ATOMIC_RELAXED);
  if(!error&&result.dropped)error=19;
  if(cancelled){status(18);append(last_op,"cancelled");}
  else if(error){status(error);append(last_op,"error");}
  else if(!result.frames){status(25);append(last_op,"error");}
  else{
    char path[100];path_for(path,owner);result.stage=3;
    if(save(path,&result,sizeof(result),capture.data,capture.used)){status(13);append(last_op,"error");}
    else{status(4);append(last_op,"done");}
  }
  /* Remain locked and inactive until the verified next start resets data.
   * Storage is never freed, even when CLOSE or task quiescence failed.
   */
  (void)emit(last_op,owner,text_equal(last_op,sizeof(last_op),"error")?result.stage:0);
}
static void begin(const char *nonce){
  if(owner[0]&&text_equal(owner,sizeof(owner),nonce)){
    (void)emit(last_op,nonce,text_equal(last_op,sizeof(last_op),"error")?result.stage:0);return;
  }
  if(owns_encoder||quarantined){(void)emit("error",nonce,quarantined?17:10);return;}
  char path[100];path_for(path,nonce);
  if(exists(path)){(void)emit("error",nonce,24);return;}
  uint32_t busy=BUSY()?1u:0u;if(*(volatile uint32_t *)(uintptr_t)0x2013eb88)busy|=2;
  if(busy){(void)emit("error",nonce,10);return;}
  /* A previous finish holds the lock, and no previous worker can still run.
   * Initial startup has no producer. No active callback storage is reused.
   */
  clear(&result,sizeof(result));
  const char *magic="BCAP0432";
  for(unsigned i=0;i<8;i++)result.magic[i]=(uint8_t)magic[i];
  result.version=2;result.rate=16000;result.frame_ms=20;
  result.open_result=result.start_result=result.close_result=-99;
  capture.used=capture.frames=0;
  __atomic_store_n(&capture.dropped,0,__ATOMIC_RELAXED);
  __atomic_store_n(&capture.overflow,0,__ATOMIC_RELAXED);
  __atomic_store_n(&capture.locked,0,__ATOMIC_RELEASE);
  append(owner,nonce);append(last_op,"preparing");encoder_tid=0;
  uint32_t configuration[3]={0x3e800000,0x803,*(volatile uint32_t *)(uintptr_t)0x2013eb84};
  result.config_result=(uint32_t)CONFIGURE(configuration);
  if(result.config_result){status(11);append(last_op,"error");(void)emit(last_op,owner,11);return;}
  result.open_result=OPEN(1,receive_encoded,16000,20);owns_encoder=1;
  started_at=(uint32_t)NOW_US();
  if(result.open_result){finish(0,14);return;}
  __atomic_store_n(&capture.active,1,__ATOMIC_RELEASE);
  result.start_result=START(1);
  encoder_tid=*(volatile uint32_t *)(uintptr_t)0x200f7604;
  if(result.start_result){finish(0,15);return;}
  status(101);append(last_op,"recording");
  if(emit(last_op,owner,0)<0)finish(0,23);
}
static int worker(int argc,char **argv){
  (void)argc;(void)argv;
  uint32_t expected=0;
  if(!__atomic_compare_exchange_n(&entered,&expected,1,0,__ATOMIC_ACQUIRE,__ATOMIC_RELAXED))return 0;
  int fd=SUBSCRIBE(META,0);
  if(fd<0){status(21);return 0;}
  status(2);
  for(;;){
    if(owns_encoder&&((uint32_t)NOW_US()-started_at>=LIMIT_US||__atomic_load_n(&capture.overflow,__ATOMIC_ACQUIRE)))finish(0,0);
    struct poll043 p={fd,1,0,0,0,0};int ready=POLL(&p,1,owns_encoder?200:-1);
    if(ready<0||(p.revents&0x38)){
      int *(*errno_fn)(void)=(void *)0x0c1e45bd;
      if(ready<0&&*errno_fn()==4)continue;
      if(owns_encoder)finish(0,22);
      status(22);(void)UNSUBSCRIBE(fd);return 0;
    }
    if(!(p.revents&1))continue;
    struct bc_user_event input,reply;char nonce[33];
    if(COPY(fd,&input,sizeof(input))!=(int)sizeof(input))continue;
    if(bc_event_reply(&input,&reply)){(void)PUBLISH(META,&reply);continue;}
    int op=command(&input,nonce);if(op<0)continue;
    if(op==0){(void)emit("ready",nonce,quarantined?17:0);continue;}
    if(op==1){begin(nonce);continue;}
    if(!owner[0]||!text_equal(owner,sizeof(owner),nonce)){(void)emit("error",nonce,26);continue;}
    if(op==2&&owns_encoder)finish(0,0);
    else if(op==3&&owns_encoder)finish(1,0);
    else if(op==3){append(last_op,"cancelled");(void)emit(last_op,owner,0);}
    else (void)emit(last_op,owner,text_equal(last_op,sizeof(last_op),"error")?result.stage:0);
  }
}
__attribute__((used)) static void bc_event043_ctor(void){
  int (*create)(const char *,int,void *,int,int (*)(int,char **),char *const *)=(void *)0x0c208b49;
  const char *magic="BCAP0432";
  for(unsigned i=0;i<8;i++)result.magic[i]=(uint8_t)magic[i];
  result.version=2;result.rate=16000;result.frame_ms=20;
  result.open_result=result.start_result=result.close_result=-99;
  status(0);status(1);
  int pid=create("bc_audio043",100,0,8192,worker,0);
  if(pid<0){status(20);return;}
  for(unsigned i=0;i<100;i++){
    if(__atomic_load_n(&entered,__ATOMIC_ACQUIRE))return;
    (void)USLEEP(10000);
  }
  uint32_t expected=0;
  if(__atomic_compare_exchange_n(&entered,&expected,2,0,__ATOMIC_ACQUIRE,__ATOMIC_RELAXED))status(20);
  /* A late task observes 2 and exits before touching result or the mic.
   * Keep executable storage resident even on failed startup. */
}
void bc_event043_anchor(void){}
__asm__(".section .init_array,\"aw\",%init_array\n.balign 4\n.word bc_event043_ctor\n.previous");
