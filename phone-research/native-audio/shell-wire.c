#include "shell-wire.h"
static uint32_t u32(const uint8_t *p){return (uint32_t)p[0]|((uint32_t)p[1]<<8)|((uint32_t)p[2]<<16)|((uint32_t)p[3]<<24);}
static bool exact(const char *s,size_t capacity,const char *expected){
 for(size_t i=0;i<capacity;i++){if(s[i]!=expected[i])return false;if(!expected[i])return true;}return false;
}
uint32_t bc_shell_crc32(const uint8_t *p,size_t len){
 uint32_t c=~(uint32_t)0;
 for(size_t i=0;i<len;i++){c^=p[i];for(unsigned j=0;j<8;j++)c=(c>>1)^((0u-(c&1u))&0xedb88320u);}
 return ~c;
}
bool bc_shell_parse_request(const uint8_t *data,size_t len,struct bc_shell_request *out){
 static const uint8_t magic[8]={'B','C','S','H','0','4','3','1'};
 if(!data||!out||len<BC_SHELL_HEADER_BYTES)return false;
 for(unsigned i=0;i<8;i++)if(data[i]!=magic[i])return false;
 if(u32(data+8)!=1)return false;
 uint32_t timeout=u32(data+12),count=u32(data+16),crc=u32(data+20),limit=u32(data+24);
 if(timeout<50||timeout>10000||!count||count>BC_SHELL_MAX_COMMAND||
    limit<128||limit>BC_SHELL_MAX_OUTPUT||len!=BC_SHELL_HEADER_BYTES+count)return false;
 const uint8_t *command=data+BC_SHELL_HEADER_BYTES;
 for(uint32_t i=0;i<count;i++)if(!command[i])return false;
 if(bc_shell_crc32(command,count)!=crc)return false;
 out->timeout_ms=timeout;out->command_bytes=count;out->command_crc=crc;out->output_limit=limit;out->command=command;
 return true;
}
bool bc_shell_uuid(const char *id){
 if(!id)return false;
 for(unsigned i=0;i<36;i++){
  char c=id[i];
  if(i==8||i==13||i==18||i==23){if(c!='-')return false;}
  else if(!((c>='0'&&c<='9')||(c>='a'&&c<='f')))return false;
 }return id[36]==0;
}
bool bc_shell_parse_event(const struct bc_user_event *e,char id[37],bool *ping){
 static const char exec_prefix[]="{\"v\":1,\"op\":\"exec\",\"id\":\"";
 static const char ping_prefix[]="{\"v\":1,\"op\":\"ping\",\"id\":\"";
 if(!e||!id||!ping||!exact(e->name,32,BC_SHELL_REQUEST_EVENT)||
    !exact(e->package,32,BC_EVENT_APP)||!exact(e->permissions,64,BC_EVENT_APP))return false;
 bool is_ping=true,is_exec=true;
 for(unsigned i=0;i<sizeof(exec_prefix)-1;i++){
  if(e->params[i]!=exec_prefix[i])is_exec=false;
  if(e->params[i]!=ping_prefix[i])is_ping=false;
 }
 if(!is_ping&&!is_exec)return false;
 const size_t n=sizeof(exec_prefix)-1;
 for(unsigned i=0;i<36;i++)id[i]=e->params[n+i];
 id[36]=0;
 if(!bc_shell_uuid(id)||e->params[n+36]!='"'||e->params[n+37]!='}'||e->params[n+38]!=0)return false;
 *ping=is_ping;return true;
}
struct text {char *p;size_t n,capacity;bool valid;};
static void append(struct text *s,const char *p){
 while(*p){if(s->n+1>=s->capacity){s->valid=false;return;}s->p[s->n++]=*p++;}s->p[s->n]=0;
}
static void number(struct text *s,int32_t v){
 char out[12];unsigned n=0;uint32_t u=v<0?0u-(uint32_t)v:(uint32_t)v;
 if(v<0)append(s,"-");
 do{out[n++]=(char)('0'+u%10);u/=10;}while(u);
 while(n){char c[2]={out[--n],0};append(s,c);}
}
bool bc_shell_reply(struct bc_user_event *e,const char *id,const char *op,int32_t raw,uint32_t flags,uint32_t bytes,int32_t error){
 if(!e||!op||!bc_shell_uuid(id)||flags>255||bytes>BC_SHELL_MAX_OUTPUT||
    (!exact(op,5,"done")&&!exact(op,5,"pong")&&!exact(op,8,"unknown")))return false;
 volatile uint8_t *zero=(volatile uint8_t *)e;for(size_t i=0;i<sizeof(*e);i++)zero[i]=0;
 struct text n={e->name,0,32,true},p={e->package,0,32,true},a={e->permissions,0,64,true},s={e->params,0,128,true};
 append(&n,BC_SHELL_RESPONSE_EVENT);append(&p,BC_SHELL_NATIVE);append(&a,BC_EVENT_APP);
 append(&s,"{\"v\":1,\"op\":\"");append(&s,op);append(&s,"\",\"id\":\"");append(&s,id);append(&s,"\",\"r\":");number(&s,raw);
 append(&s,",\"f\":");number(&s,(int32_t)flags);append(&s,",\"b\":");number(&s,(int32_t)bytes);append(&s,",\"e\":");number(&s,error);append(&s,"}");
 return n.valid&&p.valid&&a.valid&&s.valid;
}
