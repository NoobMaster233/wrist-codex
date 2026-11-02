/* p67cn .043 own authenticated SPP with bounded native file/Shell management.
 * UI RPC remains an event/file adapter. Shell execution reuses the existing
 * independent executor; no stock profile replacement or live module unload.
 */
#include "private-spp-043.h"
#include "private-link-wire.h"
#include "event-wire.h"
#include "management-043.h"

static struct bc043_loop io_loop;
static void *instance,*app,*pipe_handle;
static uint32_t entered,stopping,deadline_active;
static bool app_shown;
static int event_fd=-1;
static uint64_t boot_generation;
static uint8_t key[32],tx_file[BC_LINK_MAX_PAYLOAD+1];
static uint8_t management_reply[BC_MGMT_REPLY+BC_MGMT_BLOCK];
static uint32_t management_sequence,management_crc,management_bytes;
static size_t management_reply_bytes;
static struct bc_link_decoder decoder;
static struct {
 uint8_t magic[8];uint32_t version,phase;int32_t create_pid,start_result,unregister_result;
 uint32_t up,connections,received_frames,sent_frames,received_bytes,sent_bytes,protocol_errors,auth_failures,pending_writes,reserved[2];
} status;
_Static_assert(sizeof(status)==72,"link status");
static struct {
 uint32_t generation,port,auth_phase,session,opened_at,tx_sequence,expected_rx,last_rx,rx_sequence,tx_pending_sequence;
 uint32_t rx_crc,rx_bytes,last_rx_crc,last_rx_bytes,rx_started,tx_started;
 bool rx_pending,tx_pending;
 uint8_t client_nonce[16],server_nonce[16],server_proof[32];
 char rx_id[17],tx_id[17],last_sent_id[17];
} link;
static const struct bc043_uuid service_uuid={16,{0,0,0},
 {0xde,0x98,0x3d,0x6d,0x9f,0x22,0xc7,0xb8,0xb8,0x47,0x95,0x25,0x58,0x20,0xac,0x4a}};
static const char directory[]="/data/files/dev.bandcodex.remote/";
static const char key_path[]="/data/files/dev.bandcodex.remote/bc-private-link-v1.key";
static const char status_path[]="/data/files/dev.bandcodex.remote/bc-private-link-v1.status";
static const char boot_path[]="/data/files/dev.bandcodex.remote/bc-private-link-v1.boot";
static void close_pipe(void *);
static size_t text_length(const char *p){size_t n=0;while(p[n])n++;return n;}
static char *append(char *out,const char *in){while(*in)*out++=*in++;*out=0;return out;}
static void copy(char *out,const char *in){(void)append(out,in);}
static bool text_is(const char *a,const char *b){for(size_t i=0;;i++){if(a[i]!=b[i])return false;if(!a[i])return true;}}
static char *decimal(char *out,uint32_t n){char tmp[10];unsigned used=0;do{tmp[used++]=(char)('0'+n%10);n/=10;}while(n);while(used)*out++=tmp[--used];*out=0;return out;}
static void hex8(char *out,uint32_t n){const char *digits="0123456789abcdef";for(unsigned i=0;i<8;i++)out[i]=digits[(n>>(28-4*i))&15];out[8]=0;}
static void file_path(char *out,const char *kind,const char *id){char *p=append(out,directory);p=append(p,"bc-link-");p=append(p,kind);p=append(p,"-");p=append(p,id);append(p,".json");}
static int read_file(const char *path,void *out,size_t capacity){
 void *f=BC043_FOPEN(path,"rb");if(!f)return -1;*BC043_ERRNO()=0;
 size_t n=BC043_FREAD(out,1,capacity,f);int error=*BC043_ERRNO(),rc=BC043_FCLOSE(f);
 return error||rc?-1:(int)n;
}
static bool write_file(const char *path,const void *data,size_t n){
 void *f=BC043_FOPEN(path,"wb");if(!f)return false;
 size_t written=BC043_FWRITE(data,1,n,f);int rc=BC043_FCLOSE(f);return written==n&&!rc;
}
static bool next_boot_generation(void){
 uint8_t data[17],check[17];int n=read_file(boot_path,data,sizeof(data));
 if(n<0){if(*BC043_ERRNO()!=2)return false;boot_generation=0;}
 else{
  if(n!=16||!bc_link_equal(data,(const uint8_t *)"BCBT0431",8))return false;
  boot_generation=0;for(unsigned i=0;i<8;i++)boot_generation|=(uint64_t)data[8+i]<<(8*i);
 }
 if(++boot_generation==0)return false;
 for(unsigned i=0;i<8;i++){data[i]=(uint8_t)"BCBT0431"[i];data[8+i]=(uint8_t)(boot_generation>>(8*i));}
 return write_file(boot_path,data,16)&&read_file(boot_path,check,sizeof(check))==16&&bc_link_equal(data,check,16);
}
static void persist(uint32_t phase){status.phase=phase;(void)write_file(status_path,&status,sizeof(status));}
static void deadlines(void){
 __atomic_store_n(&deadline_active,pipe_handle&&(link.auth_phase!=2||link.rx_pending||link.tx_pending),__ATOMIC_RELEASE);
}
static void emit(const char *op,const char *id,uint32_t value){
 struct bc_user_event event;volatile uint8_t *zero=(volatile uint8_t *)&event;
 for(size_t i=0;i<sizeof(event);i++)zero[i]=0;
 copy(event.name,"bc.link.evt");copy(event.package,"dev.bandcodex.link");copy(event.permissions,"dev.bandcodex.remote");
 char *p=append(event.params,"{\"v\":1,\"op\":\"");p=append(p,op);p=append(p,"\"");
 if(text_is(op,"state")){
  p=append(p,",\"up\":");p=decimal(p,status.up);p=append(p,",\"s\":\"");hex8(p,link.session);p+=8;p=append(p,"\"");
 }else{
  p=append(p,",\"id\":\"");p=append(p,id);p=append(p,"\",");
  p=append(p,text_is(op,"rx")?"\"b\":" : "\"e\":");p=decimal(p,value);
 }
 append(p,"}");(void)BC043_EVENT_PUBLISH(BC043_EVENT_META,&event);
}
static void written(void *handle,uint8_t *buffer,int result){
 (void)handle;uint32_t generation=0;for(unsigned i=0;i<4;i++)generation|=(uint32_t)(buffer-4)[i]<<(8*i);
 BC043_FREE(buffer-4);__atomic_fetch_sub(&status.pending_writes,1,__ATOMIC_RELEASE);
 if(result<0&&generation==link.generation)close_pipe(0);
}
static bool send_frame(uint8_t type,uint32_t seq,const uint8_t *data,size_t bytes){
 if(!pipe_handle||__atomic_load_n(&status.pending_writes,__ATOMIC_ACQUIRE)>=8)return false;
 uint8_t *memory=BC043_MALLOC(4+BC_LINK_HEADER+bytes);if(!memory)return false;
 for(unsigned i=0;i<4;i++)memory[i]=(uint8_t)(link.generation>>(8*i));
 size_t n=bc_link_frame(memory+4,BC_LINK_HEADER+bytes,type,seq,data,bytes);
 if(!n){BC043_FREE(memory);return false;}
 __atomic_fetch_add(&status.pending_writes,1,__ATOMIC_RELEASE);
 if(BC043_PIPE_WRITE(pipe_handle,memory+4,(int)n,written)<0){
  __atomic_fetch_sub(&status.pending_writes,1,__ATOMIC_RELEASE);BC043_FREE(memory);return false;
 }
 status.sent_frames++;status.sent_bytes+=(uint32_t)bytes;return true;
}
static void close_pipe(void *unused){
 (void)unused;void *old=pipe_handle;pipe_handle=0;
 status.up=0;link.auth_phase=0;link.rx_pending=false;
 if(link.tx_pending){link.tx_pending=false;emit("failed",link.tx_id,1);}
 deadlines();if(old)BC043_PIPE_CLOSE(old);persist(5);emit("state",0,0);
}
static bool report_visibility(void){
 const uint8_t payload[5]={'B','C','L','V',app_shown?1:0};
 return !status.up||send_frame(BC_LINK_PONG,0,payload,sizeof(payload));
}
static void proof(const char *label,uint8_t out[32]){
 uint8_t message[43];for(unsigned i=0;i<11;i++)message[i]=(uint8_t)label[i];
 for(unsigned i=0;i<16;i++){message[11+i]=link.client_nonce[i];message[27+i]=link.server_nonce[i];}
 bc_link_hmac(key,message,sizeof(message),out);
}
static bool frame_received(void *unused,uint8_t type,uint32_t seq,const uint8_t *data,size_t n){
 (void)unused;status.received_frames++;status.received_bytes+=(uint32_t)n;
 if(link.auth_phase!=2){
  if(type==BC_LINK_HELLO&&!seq&&n==16&&link.auth_phase==0){
   for(unsigned i=0;i<16;i++)link.client_nonce[i]=data[i];
   for(unsigned i=0;i<8;i++)link.server_nonce[i]=(uint8_t)(boot_generation>>(8*i));
   for(unsigned i=0;i<4;i++){link.server_nonce[8+i]=(uint8_t)(link.generation>>(8*i));link.server_nonce[12+i]=(uint8_t)(link.opened_at>>(8*i));}
   proof("BCP1/server",link.server_proof);uint8_t challenge[48];
   for(unsigned i=0;i<16;i++)challenge[i]=link.server_nonce[i];
   for(unsigned i=0;i<32;i++)challenge[16+i]=link.server_proof[i];
   link.auth_phase=1;deadlines();return send_frame(BC_LINK_CHALLENGE,0,challenge,sizeof(challenge));
  }
  if(type==BC_LINK_AUTH&&!seq&&n==32&&link.auth_phase==1){
   uint8_t expected[32];proof("BCP1/client",expected);
   if(!bc_link_equal(data,expected,32)){status.auth_failures++;return false;}
   link.session=0;for(unsigned i=0;i<4;i++)link.session|=(uint32_t)link.server_proof[i]<<(8*i);
   uint8_t ready[12]={0};for(unsigned i=0;i<4;i++)ready[i]=(uint8_t)(link.session>>(8*i));
   ready[4]=2;ready[9]=0x80; /* v2 adds UI-independent management; max32768. */
   link.auth_phase=2;status.up=1;link.expected_rx=1;link.last_rx=0;link.tx_sequence=0;
   management_sequence=0;management_reply_bytes=0;
   if(!send_frame(BC_LINK_READY,0,ready,sizeof(ready)))return false;
   deadlines();persist(6);emit("state",0,0);return report_visibility();
  }
  status.auth_failures++;return false;
 }
 if(type==BC_LINK_PING&&seq)return send_frame(BC_LINK_PONG,seq,data,n);
 if(type==BC_LINK_MANAGEMENT&&seq){
  uint32_t crc=bc_link_crc32(data,n,0);
  if(seq==management_sequence&&n==management_bytes&&crc==management_crc&&management_reply_bytes)
   return send_frame(BC_LINK_MANAGEMENT_REPLY,seq,management_reply,management_reply_bytes);
  if(seq!=management_sequence+1||!seq)return false;
  management_reply_bytes=bc_management_handle(data,n,management_reply,sizeof(management_reply));
  if(!management_reply_bytes)return false;
  management_sequence=seq;management_bytes=(uint32_t)n;management_crc=crc;
  return send_frame(BC_LINK_MANAGEMENT_REPLY,seq,management_reply,management_reply_bytes);
 }
 if(type==BC_LINK_ACK&&seq&&n==0&&link.tx_pending&&seq==link.tx_pending_sequence){
  link.tx_pending=false;copy(link.last_sent_id,link.tx_id);deadlines();emit("sent",link.tx_id,0);return true;
 }
 if(type==BC_LINK_JSON&&seq&&n>=2){
  uint32_t crc=bc_link_crc32(data,n,0);
  if(seq==link.last_rx&&seq<link.expected_rx&&crc==link.last_rx_crc&&n==link.last_rx_bytes)return send_frame(BC_LINK_ACK,seq,0,0);
  if(link.rx_pending){
   if(seq==link.rx_sequence&&crc==link.rx_crc&&n==link.rx_bytes){emit("rx",link.rx_id,link.rx_bytes);return true;}
   return false;
  }
  if(seq!=link.expected_rx)return false;
  hex8(link.rx_id,link.session);hex8(link.rx_id+8,seq);char path[100];file_path(path,"rx",link.rx_id);
  if(!write_file(path,data,n))return false;
  link.rx_sequence=seq;link.rx_crc=crc;link.rx_bytes=(uint32_t)n;link.rx_started=(uint32_t)BC043_CLOCK();link.rx_pending=true;
  deadlines();emit("rx",link.rx_id,(uint32_t)n);return true;
 }
 if(type==BC_LINK_STOP&&seq&&n==0){__atomic_store_n(&stopping,1,__ATOMIC_RELEASE);status.up=0;emit("state",0,0);return true;}
 return false;
}
static void read_data(void *handle,const uint8_t *data,int32_t bytes){
 if(handle!=pipe_handle||!bytes)return;
 if(bytes<0){close_pipe(0);return;}
 if(!bc_link_feed(&decoder,data,(size_t)bytes,frame_received,0)){status.protocol_errors++;close_pipe(0);}
}
static void connected(void *handle,int result,void *unused){
 (void)unused;
 if(result<0||__atomic_load_n(&stopping,__ATOMIC_ACQUIRE)){
  if(pipe_handle==handle)close_pipe(0);
  return;
 }
 pipe_handle=handle;link.generation++;status.connections++;link.auth_phase=0;status.up=0;
 link.opened_at=(uint32_t)BC043_CLOCK();link.rx_pending=link.tx_pending=false;link.last_sent_id[0]=0;
 bc_link_decoder_init(&decoder);deadlines();persist(5);emit("state",0,0);
 if(BC043_PIPE_READ(handle,1024,read_data,0)<0)close_pipe(0);
}
struct proxy_request {uint16_t port;int state;char name[64];};
static void proxy_process(void *pointer){
 struct proxy_request *r=pointer;
 if(!__atomic_load_n(&stopping,__ATOMIC_ACQUIRE)){
  if(r->state==1){if(r->port==link.port)close_pipe(0);}
  else if(!pipe_handle){link.port=r->port;pipe_handle=BC043_PIPE_CONNECT(&io_loop,r->name,connected,0);}
 }
 BC043_FREE(r);
}
static void proxy(void *handle,const void *address,int state,uint16_t scn,uint16_t port,char *name){
 (void)handle;(void)address;
 if(scn!=11||state<0||state>1||__atomic_load_n(&stopping,__ATOMIC_ACQUIRE))return;
 struct proxy_request *r=BC043_MALLOC(sizeof(*r));if(!r)return;
 r->state=state;r->port=port;r->name[0]=0;
 if(state==0){
  if(!name){BC043_FREE(r);return;}
  size_t n=0;while(n<sizeof(r->name)-1&&name[n]){r->name[n]=name[n];n++;}
  if(name[n]){BC043_FREE(r);return;}r->name[n]=0;
 }
 BC043_LOOP_DO(&io_loop,proxy_process,r);
}
static void state_changed(void *handle,const void *address,uint16_t scn,uint16_t port,int state){(void)handle;(void)address;(void)scn;(void)port;(void)state;}
static const struct bc043_spp_callbacks callbacks={16,0,state_changed,proxy};
static bool request(const struct bc_user_event *event,char op[9],char id[17]){
 if(!bc_link_equal((const uint8_t *)event->name,(const uint8_t *)"bc.link.req\0",12)||
    !bc_link_equal((const uint8_t *)event->package,(const uint8_t *)"dev.bandcodex.remote\0",21))return false;
 const char *s=event->params;const char *prefix="{\"v\":1,\"op\":\"";size_t at=text_length(prefix);
 if(!bc_link_equal((const uint8_t *)s,(const uint8_t *)prefix,at))return false;
 size_t n=0;while(n<8&&s[at+n]>='a'&&s[at+n]<='z'){op[n]=s[at+n];n++;}op[n]=0;at+=n;
 const char *middle="\",\"id\":\"";size_t length=text_length(middle);
 if(!n||!bc_link_equal((const uint8_t *)s+at,(const uint8_t *)middle,length))return false;
 at+=length;
 for(unsigned i=0;i<16;i++){char c=s[at+i];if(!((c>='0'&&c<='9')||(c>='a'&&c<='f')))return false;id[i]=c;}id[16]=0;at+=16;
 return s[at]=='"'&&s[at+1]=='}'&&s[at+2]==0;
}
static void event_process(void *pointer){
 struct bc_user_event *event=pointer;char op[9],id[17];bool valid=request(event,op,id);BC043_FREE(event);if(!valid)return;
 if(text_is(op,"ping")||text_is(op,"show")||text_is(op,"hide")){
  bool changed=false;
  if(text_is(op,"show")&&!app_shown){app_shown=true;changed=true;}
  if(text_is(op,"hide")&&app_shown){app_shown=false;changed=true;}
  persist(status.up?6:5);emit("state",0,0);
  if(changed&&!report_visibility())close_pipe(0);
  if(link.rx_pending&&app_shown)emit("rx",link.rx_id,link.rx_bytes);
  return;
 }
 if(text_is(op,"txstatus")){
  if(text_is(id,link.last_sent_id))emit("sent",id,0);
  else if(!link.tx_pending||!text_is(id,link.tx_id))emit("failed",id,1);
  return;
 }
 if(!status.up){if(text_is(op,"tx"))emit("failed",id,1);return;}
 if(text_is(op,"rxack")&&link.rx_pending&&text_is(id,link.rx_id)){
  uint32_t seq=link.rx_sequence;link.last_rx=seq;link.last_rx_crc=link.rx_crc;link.last_rx_bytes=link.rx_bytes;
  link.expected_rx=seq+1;link.rx_pending=false;deadlines();if(!seq||!link.expected_rx||!send_frame(BC_LINK_ACK,seq,0,0))close_pipe(0);return;
 }
 if(text_is(op,"rxreject")&&link.rx_pending&&text_is(id,link.rx_id)){close_pipe(0);return;}
 if(!text_is(op,"tx"))return;
 if(text_is(id,link.last_sent_id)){emit("sent",id,0);return;}
 if(link.tx_pending){if(!text_is(id,link.tx_id))emit("failed",id,3);return;}
 char path[100];file_path(path,"tx",id);int n=read_file(path,tx_file,sizeof(tx_file));
 if(n<2||n>(int)BC_LINK_MAX_PAYLOAD){emit("failed",id,4);return;}
 uint32_t seq=++link.tx_sequence;if(!seq){close_pipe(0);emit("failed",id,1);return;}
 copy(link.tx_id,id);link.tx_pending_sequence=seq;link.tx_started=(uint32_t)BC043_CLOCK();link.tx_pending=true;deadlines();
 if(!send_frame(BC_LINK_JSON,seq,tx_file,(size_t)n))close_pipe(0);
 else emit("queued",id,0); /* Wake the deadline worker after this loop task. */
}
static void check_deadlines(void *unused){
 (void)unused;uint32_t now=(uint32_t)BC043_CLOCK();
 if((pipe_handle&&link.auth_phase!=2&&(uint32_t)(now-link.opened_at)>10000000u)||
    (link.rx_pending&&(uint32_t)(now-link.rx_started)>12000000u)||
    (link.tx_pending&&(uint32_t)(now-link.tx_started)>12000000u))close_pipe(0);
}
static void ready_status(void *unused){(void)unused;persist(status.up?6:5);}
static int worker(int argc,char **argv){
 (void)argc;(void)argv;__atomic_store_n(&entered,1,__ATOMIC_RELEASE);persist(1);
 if(read_file(key_path,key,32)!=32){persist(110);return 0;}
 /* Read one byte past the configured key to reject accidental extra data. */
 uint8_t exact[33];if(read_file(key_path,exact,sizeof(exact))!=32||!bc_link_equal(key,exact,32)){persist(110);return 0;}
 if(!next_boot_generation()){persist(116);return 0;}
 if(BC043_LOOP_INIT(&io_loop)){persist(111);return 0;}
 if(BC043_LOOP_RUN(&io_loop,true,"bc_link_io")){BC043_LOOP_EXIT(&io_loop);persist(112);return 0;}
 instance=BC043_BT_CREATE();if(!instance){BC043_LOOP_EXIT(&io_loop);persist(113);return 0;}
 app=BC043_SPP_REGISTER(instance,"bandcodex-link",&callbacks);
 if(!app){BC043_BT_DELETE(instance);BC043_LOOP_EXIT(&io_loop);persist(114);return 0;}
 event_fd=BC043_EVENT_SUBSCRIBE(BC043_EVENT_META,0);
 if(event_fd<0){status.start_result=7;}
 else status.start_result=BC043_SPP_START(instance,app,11,&service_uuid,1);
 if(!status.start_result){
  BC043_LOOP_DO(&io_loop,ready_status,0);
  while(!__atomic_load_n(&stopping,__ATOMIC_ACQUIRE)){
   struct bc043_poll poll={event_fd,1,0,0,0,0};int ready=BC043_POLL(&poll,1,__atomic_load_n(&deadline_active,__ATOMIC_ACQUIRE)?1000:-1);
   if(ready<0){if(*BC043_ERRNO()==4)continue;break;}
   if(poll.revents&0x38)break;
   if(!ready){BC043_LOOP_DO(&io_loop,check_deadlines,0);continue;}
   if(poll.revents&1){
    struct bc_user_event incoming;
    if(BC043_EVENT_COPY(event_fd,&incoming,sizeof(incoming))!=(int)sizeof(incoming))continue;
    if(incoming.name[0]=='b'&&incoming.name[3]=='l'&&incoming.name[8]=='r'){
     struct bc_user_event *owned=BC043_MALLOC(sizeof(*owned));if(!owned)continue;
     for(size_t i=0;i<sizeof(*owned);i++)((uint8_t *)owned)[i]=((const uint8_t *)&incoming)[i];
     BC043_LOOP_DO(&io_loop,event_process,owned);
    }
   }
  }
 }
 __atomic_store_n(&stopping,1,__ATOMIC_RELEASE);
 if(event_fd>=0)(void)BC043_EVENT_UNSUBSCRIBE(event_fd);
 status.unregister_result=BC043_SPP_UNREGISTER(instance,app);BC043_BT_DELETE(instance);
 BC043_LOOP_DO(&io_loop,close_pipe,0);BC043_LOOP_EXIT(&io_loop);persist(7);return 0;
}
__attribute__((used)) static void bc_event043_ctor(void){
 const char *magic="BCLN0431";for(unsigned i=0;i<8;i++)status.magic[i]=(uint8_t)magic[i];
 status.version=2;status.create_pid=status.start_result=status.unregister_result=-99;persist(0);
 status.create_pid=BC043_CREATE("bc_link043",100,0,8192,worker,0);
 if(status.create_pid<0){persist(115);return;}
 for(unsigned i=0;i<100;i++){if(__atomic_load_n(&entered,__ATOMIC_ACQUIRE))return;(void)BC043_SLEEP(10000);}
}
void bc_event043_anchor(void){}
__asm__(".section .init_array,\"aw\",%init_array\n.balign 4\n.word bc_event043_ctor\n.previous");
