/* .043 NSH executor. Separate event namespace; no microphone or phone commands.
 * Idle blocks on uORB. Per-request intent is exclusive and verified before
 * spawning. Only an owned, unreaped child may be killed, once. An uncertain
 * child blocks further execution and retains its arguments/file actions.
 * Timeout covers the direct NSH task, not independently created descendants.
 */
#include <stdint.h>
#include <stddef.h>
#include "shell-wire.h"

#define CREATE ((int (*)(const char *,int,void *,int,int (*)(int,char **),char *const *))(uintptr_t)0x0c208b49)
#define SLEEP ((int (*)(uint32_t))(uintptr_t)0x0c1f5d0d)
#define CLOCK ((uint64_t (*)(void))(uintptr_t)0x0c2e987d)
#define ATTR_INIT ((int (*)(void *))(uintptr_t)0x0c1ea725)
#define ATTR_PRIORITY ((int (*)(void *,const void *))(uintptr_t)0x0c1ea7a1)
#define ATTR_STACK ((int (*)(void *,size_t))(uintptr_t)0x0c1ea7c5)
#define ATTR_FLAGS ((int (*)(void *,int))(uintptr_t)0x0c1ea781)
#define ATTR_DESTROY ((int (*)(void *))(uintptr_t)0x0c1ea7e1)
#define ACTION_INIT ((int (*)(void *))(uintptr_t)0x0c1ea711)
#define ACTION_OPEN ((int (*)(void *,int,const char *,int,unsigned))(uintptr_t)0x0c1ea67d)
#define ACTION_DUP ((int (*)(void *,int,int))(uintptr_t)0x0c1ea63d)
#define ACTION_DESTROY ((int (*)(void *))(uintptr_t)0x0c1ea6e5)
#define SPAWN ((int (*)(const char *,int (*)(int,char **),const void *,const void *,char *const *,char *const *))(uintptr_t)0x0c209771)
#define NSH ((int (*)(int,char **))(uintptr_t)0x0c2390e1)
#define WAIT ((int (*)(int,int32_t *,int))(uintptr_t)0x0c2063c5)
#define KILL ((int (*)(int,int))(uintptr_t)0x0c207a49)
#define ERRNO ((int *(*)(void))(uintptr_t)0x0c1e45bd)
#define OPEN ((void *(*)(const char *,const char *))(uintptr_t)0x0c1eadcd)
#define READ ((size_t (*)(void *,size_t,size_t,void *))(uintptr_t)0x0c1eafd1)
#define WRITE ((size_t (*)(const void *,size_t,size_t,void *))(uintptr_t)0x0c1eb54d)
#define CLOSE ((int (*)(void *))(uintptr_t)0x0c1eaea1)
#define META ((const void *)(uintptr_t)0x2cda393c)
#define PUBLISH ((int (*)(const void *,const void *))(uintptr_t)0x0c2e64ad)
#define SUBSCRIBE ((int (*)(const void *,unsigned))(uintptr_t)0x0c2e97ad)
#define COPY ((int (*)(int,void *,size_t))(uintptr_t)0x0c2e97c5)
#define UNSUBSCRIBE ((int (*)(int))(uintptr_t)0x0c2e9651)
#define POLL ((int (*)(void *,unsigned,int))(uintptr_t)0x0c1d0d1d)

static const char directory[]="/data/files/dev.bandcodex.remote/";
static const char service_file[]="/data/files/dev.bandcodex.remote/bc-nsh-shell-v1.service";
static uint32_t entered;
static bool blocked;
static struct {
 struct bc_shell_status status;
 struct bc_shell_request request;
 uint32_t attr[5];void *actions;char *argv[3];
 char id[37],input[112],output[112],receipt[112],intent[112];
 uint8_t request_data[BC_SHELL_HEADER_BYTES+BC_SHELL_MAX_COMMAND+1];
 uint8_t output_data[BC_SHELL_MAX_OUTPUT+1];
} job;
struct poll043 {int32_t fd;uint32_t events,revents,arg,callback,priv;};
_Static_assert(sizeof(struct poll043)==24,".043 poll layout");
_Static_assert(sizeof(int)==4,".043 integer ABI");

static size_t length(const char *s){size_t n=0;while(s[n])n++;return n;}
static void clear(void *p,size_t n){volatile uint8_t *v=p;while(n--)*v++=0;}
static void copy(char *out,const char *s){while(*s)*out++=*s++;*out=0;}
static void path(char *out,const char *prefix,const char *id,const char *suffix){
 copy(out,directory);out+=sizeof(directory)-1;copy(out,prefix);out+=length(prefix);
 copy(out,id);out+=36;copy(out,suffix);
}
static bool same(const uint8_t *a,const uint8_t *b,size_t n){for(size_t i=0;i<n;i++)if(a[i]!=b[i])return false;return true;}
static bool write_file(const char *name,const void *data,size_t bytes,const char *mode){
 void *f=OPEN(name,mode);if(!f)return false;
 size_t n=WRITE(data,1,bytes,f);int rc=CLOSE(f);return n==bytes&&rc==0;
}
static int read_file(const char *name,void *out,size_t capacity){
 void *f=OPEN(name,"rb");if(!f)return -1;
 *ERRNO()=0;size_t n=READ(out,1,capacity,f);int error=*ERRNO();int rc=CLOSE(f);
 return error||rc ? -1:(int)n;
}
static bool exists(const char *name){void *f=OPEN(name,"rb");if(!f)return false;(void)CLOSE(f);return true;}
static void service(const char *message){(void)write_file(service_file,message,length(message),"wb");}
static void init_status(void){
 clear(&job.status,sizeof(job.status));
 for(unsigned i=0;i<8;i++)job.status.magic[i]=(uint8_t)"BCSR0431"[i];
 job.status.version=1;job.status.pid=-99;job.status.wait_pid=-99;job.status.raw_status=-99;
 job.status.command_crc=job.request.command_crc;job.status.timeout_ms=job.request.timeout_ms;
}
static void state_error(uint32_t flags,int error,bool uncertain){
 job.status.flags|=flags;job.status.error=error?error:1;
 if(uncertain){blocked=true;job.status.flags|=BC_SHELL_UNKNOWN;job.status.phase=3;}
 else job.status.phase=2;
}
static int collect(uint32_t milliseconds){
 uint32_t start=(uint32_t)CLOCK();
 do {
  job.status.wait_pid=WAIT(job.status.pid,&job.status.raw_status,2);
  if(job.status.wait_pid==job.status.pid)return 1;
  if(job.status.wait_pid<0){job.status.error=*ERRNO();return -1;}
  (void)SLEEP(10000);
 }while((uint32_t)((uint32_t)CLOCK()-start)<milliseconds*1000u);
 return 0;
}
static void release_actions(void){(void)ACTION_DESTROY(&job.actions);(void)ATTR_DESTROY(job.attr);}
static void execute(void){
 int priority=100,rc=ATTR_INIT(job.attr);
 if(rc){state_error(BC_SHELL_SPAWN_FAILED,rc,false);return;}
 rc=ACTION_INIT(&job.actions);
 if(rc){(void)ATTR_DESTROY(job.attr);state_error(BC_SHELL_SPAWN_FAILED,rc,false);return;}
 /* .043 wb = O_WRONLY | O_CREAT | O_TRUNC = 38, not Linux flags. */
 if(!(rc=ACTION_OPEN(&job.actions,1,job.output,38,0600)) &&
    !(rc=ACTION_DUP(&job.actions,1,2)) && !(rc=ATTR_PRIORITY(job.attr,&priority)) &&
    !(rc=ATTR_STACK(job.attr,8192)))rc=ATTR_FLAGS(job.attr,4);
 if(rc){release_actions();state_error(BC_SHELL_SPAWN_FAILED,rc,false);return;}
 job.argv[0]=(char *)"-c";job.argv[1]=(char *)job.request.command;job.argv[2]=0;
 uint32_t start=(uint32_t)CLOCK(),last_output_check=0;
 job.status.pid=SPAWN("bc_shell_cmd043",NSH,&job.actions,job.attr,job.argv,0);
 if(job.status.pid<2){rc=*ERRNO();release_actions();state_error(BC_SHELL_SPAWN_FAILED,rc,false);return;}
 bool terminate=false;
 for(;;){
  job.status.wait_pid=WAIT(job.status.pid,&job.status.raw_status,2);
  if(job.status.wait_pid==job.status.pid)break;
  if(job.status.wait_pid<0){state_error(BC_SHELL_CLEANUP_FAILED,*ERRNO(),true);return;}
  uint32_t elapsed=(uint32_t)((uint32_t)CLOCK()-start)/1000u;
  if(elapsed>=job.request.timeout_ms){job.status.flags|=BC_SHELL_TIMEOUT;terminate=true;}
  else if(elapsed-last_output_check>=100){
   last_output_check=elapsed;
   int n=read_file(job.output,job.output_data,job.request.output_limit+1);
   if(n<0){job.status.flags|=BC_SHELL_IO_FAILED;terminate=true;}
   else if((uint32_t)n>job.request.output_limit){job.status.flags|=BC_SHELL_OUTPUT_LIMIT;terminate=true;}
  }
  if(terminate)break;
  (void)SLEEP(10000);
 }
 if(terminate){
  /* No name lookup, zero pid, group selector, or second kill is permitted. */
  if(KILL(job.status.pid,9)!=0){state_error(BC_SHELL_CLEANUP_FAILED,*ERRNO(),true);return;}
  if(collect(1000)!=1){state_error(BC_SHELL_CLEANUP_FAILED,job.status.error,true);return;}
 }
 job.status.elapsed_ms=(uint32_t)((uint32_t)CLOCK()-start)/1000u;
 /* Keep file-action nodes alive until the own child is confirmed reaped. */
 release_actions();job.status.phase=2;
 int n=read_file(job.output,job.output_data,job.request.output_limit+1);
 if(n<0){state_error(BC_SHELL_IO_FAILED,*ERRNO(),false);return;}
 uint32_t bytes=(uint32_t)n;
 if(bytes>job.request.output_limit){
  bytes=job.request.output_limit;job.status.flags|=BC_SHELL_TRUNCATED|BC_SHELL_OUTPUT_LIMIT;
  if(!write_file(job.output,job.output_data,bytes,"wb")){state_error(BC_SHELL_IO_FAILED,*ERRNO(),false);return;}
 }
 job.status.output_bytes=bytes;
}
static bool valid_status(const struct bc_shell_status *s){
 return same(s->magic,(const uint8_t *)"BCSR0431",8)&&s->version==1&&s->phase==2&&
   s->flags<=255&&!(s->flags&(BC_SHELL_UNKNOWN|BC_SHELL_CLEANUP_FAILED))&&
   s->output_bytes<=BC_SHELL_MAX_OUTPUT&&s->timeout_ms>=50&&s->timeout_ms<=10000&&
   ((s->pid>=2&&s->wait_pid==s->pid&&s->raw_status>=0)||
    (s->pid<2&&s->error&&(s->flags&(BC_SHELL_SPAWN_FAILED|BC_SHELL_IO_FAILED))))&&
   !s->reserved[0]&&!s->reserved[1]&&!s->reserved[2];
}
static void respond(struct bc_user_event *event,const char *id,const char *op,uint32_t extra){
 if(bc_shell_reply(event,id,op,job.status.raw_status,job.status.flags|extra,job.status.output_bytes,job.status.error))
  (void)PUBLISH(META,event);
}
static void request(const char *id,struct bc_user_event *reply){
 if(blocked){
  if(bc_shell_reply(reply,id,"unknown",-99,BC_SHELL_UNKNOWN,0,1))(void)PUBLISH(META,reply);
  return;
 }
 copy(job.id,id);path(job.input,"bc-file-",id,".bin");path(job.output,"bc-shell-",id,".out");
 path(job.receipt,"bc-shell-",id,".status");path(job.intent,"bc-shell-",id,".intent");
 if(exists(job.intent)){
  uint8_t prior[65];int n=read_file(job.receipt,prior,sizeof(prior));
  if(n==64){
   clear(&job.status,sizeof(job.status));
   for(size_t i=0;i<64;i++)((uint8_t *)&job.status)[i]=prior[i];
   if(valid_status(&job.status)){respond(reply,id,"done",BC_SHELL_DUPLICATE);return;}
  }
  clear(&job.request,sizeof(job.request));init_status();state_error(BC_SHELL_UNKNOWN,1,true);
  respond(reply,id,"unknown",0);return;
 }
 int n=read_file(job.input,job.request_data,sizeof(job.request_data));
 if(n<0||!bc_shell_parse_request(job.request_data,(size_t)n,&job.request)){
  clear(&job.request,sizeof(job.request));init_status();state_error(BC_SHELL_IO_FAILED,2,false);
  respond(reply,id,"done",0);return;
 }
 job.request_data[n]=0;init_status();
 /* O_EXCL makes the intent creation atomic; verify bytes before any spawn. */
 uint8_t check[BC_SHELL_HEADER_BYTES+1];
 if(!write_file(job.intent,job.request_data,BC_SHELL_HEADER_BYTES,"wbx")||
    read_file(job.intent,check,sizeof(check))!=(int)BC_SHELL_HEADER_BYTES||
    !same(check,job.request_data,BC_SHELL_HEADER_BYTES)){
  state_error(BC_SHELL_IO_FAILED,3,false);respond(reply,id,"done",0);return;
 }
 job.status.phase=1;
 if(!write_file(job.receipt,&job.status,sizeof(job.status),"wb")){
  state_error(BC_SHELL_IO_FAILED,4,false);respond(reply,id,"done",0);return;
 }
 execute();
 if(!write_file(job.receipt,&job.status,sizeof(job.status),"wb"))state_error(BC_SHELL_IO_FAILED,5,blocked);
 respond(reply,id,blocked?"unknown":"done",0);
}
static int worker(int argc,char **argv){
 (void)argc;(void)argv;__atomic_store_n(&entered,1,__ATOMIC_RELEASE);
 static const char command[]="echo bc-shell-fd-v1",expected[]="bc-shell-fd-v1\n";
 copy(job.output,"/data/files/dev.bandcodex.remote/bc-shell-selftest-v1.out");
 job.request.command=(const uint8_t *)command;job.request.command_bytes=sizeof(command)-1;
 job.request.command_crc=bc_shell_crc32((const uint8_t *)command,sizeof(command)-1);
 job.request.timeout_ms=3000;job.request.output_limit=128;init_status();execute();
 (void)write_file("/data/files/dev.bandcodex.remote/bc-shell-selftest-v1.status",&job.status,sizeof(job.status),"wb");
 if(blocked||job.status.phase!=2||job.status.flags||job.status.raw_status||
    job.status.output_bytes!=sizeof(expected)-1||!same(job.output_data,(const uint8_t *)expected,sizeof(expected)-1)){
  service("selftest-failed\n");return 0;
 }
 int fd=SUBSCRIBE(META,0);
 if(fd<0){service("subscribe-failed\n");return 0;}
 service("ready:shell043-v1\n");
 struct bc_user_event input,reply;char id[37];bool ping;
 for(;;){
  struct poll043 p={fd,1,0,0,0,0};int rc=POLL(&p,1,-1);
  if(rc<0||(p.revents&0x38)){service("event-poll-failed\n");break;}
  if(!(p.revents&1))continue;
  if(COPY(fd,&input,sizeof(input))!=(int)sizeof(input)){service("event-read-failed\n");break;}
  if(!bc_shell_parse_event(&input,id,&ping))continue;
  if(ping){if(bc_shell_reply(&reply,id,"pong",0,blocked?BC_SHELL_UNKNOWN:0,0,0))(void)PUBLISH(META,&reply);}
  else request(id,&reply);
 }
 (void)UNSUBSCRIBE(fd);return 0;
}
__attribute__((used)) static void bc_event043_ctor(void){
 service("starting:shell043-v1\n");
 if(CREATE("bc_shell043",100,0,8192,worker,0)<0){service("worker-create-failed\n");return;}
 for(unsigned i=0;i<100;i++){if(__atomic_load_n(&entered,__ATOMIC_ACQUIRE))return;(void)SLEEP(10000);}
 /* Retain the module on a late start; never unload or repeat an unsure load. */
}
void bc_event043_anchor(void){}
__asm__(".section .init_array,\"aw\",%init_array\n.balign 4\n.word bc_event043_ctor\n.previous");
