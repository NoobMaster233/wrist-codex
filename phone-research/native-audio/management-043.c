/* .043 authenticated private-directory management. No UI lifetime dependency.
 * Writes are confined to transfer staging files; shell submission is separate
 * and stores an exclusive full-request intent before publishing an event. */
#include "management-043.h"
#include "shell-wire.h"
#ifndef BC_MANAGEMENT_TEST
#include "private-spp-043.h"
#define MG_OPEN BC043_FOPEN
#define MG_READ BC043_FREAD
#define MG_WRITE BC043_FWRITE
#define MG_CLOSE BC043_FCLOSE
#define MG_ERRNO BC043_ERRNO
/* Recovered from this AP's Lua io.seek / os.rename / os.remove wrappers. */
#define MG_SEEK BC043_AT(int (*)(void *,int32_t,int),0x0c1eb199)
#define MG_TELL BC043_AT(int32_t (*)(void *),0x0c1eb241)
#define MG_RENAME BC043_AT(int (*)(const char *,const char *),0x0c1d12e9)
#define MG_UNLINK BC043_AT(int (*)(const char *),0x0c1d2445)
#define MG_PUBLISH(e) BC043_EVENT_PUBLISH(BC043_EVENT_META,(e))
#endif

static const char directory[]="/data/files/dev.bandcodex.remote/";
static uint8_t command[BC_SHELL_HEADER_BYTES+BC_SHELL_MAX_COMMAND+1];
static uint8_t previous[BC_SHELL_HEADER_BYTES+BC_SHELL_MAX_COMMAND+1];
static uint32_t get32(const uint8_t *p){return (uint32_t)p[0]|(uint32_t)p[1]<<8|(uint32_t)p[2]<<16|(uint32_t)p[3]<<24;}
static void put32(uint8_t *p,uint32_t n){for(unsigned i=0;i<4;i++)p[i]=(uint8_t)(n>>(8*i));}
static bool same(const void *a,const void *b,size_t n){const uint8_t *p=a,*q=b;for(size_t i=0;i<n;i++)if(p[i]!=q[i])return false;return true;}
static size_t length(const char *p){size_t n=0;while(p[n])n++;return n;}
static char *append(char *p,const char *s){while(*s)*p++=*s++;*p=0;return p;}
static bool name(const uint8_t *p,size_t n,char out[81]){
 if(!n||n>80)return false;
 for(size_t i=0;i<n;i++){
  uint8_t c=p[i];bool alnum=(c>='a'&&c<='z')||(c>='A'&&c<='Z')||(c>='0'&&c<='9');
  if(!alnum&&(i==0||(c!='_'&&c!='-'&&c!='.')))return false;
  out[i]=(char)c;
 }
 out[n]=0;
 /* Auth and replay-generation files are not generic transfer content. */
 if((n==22&&same(out,"bc-private-link-v1.key",22))||
    (n==23&&same(out,"bc-private-link-v1.boot",23)))return false;
 return true;
}
static bool transfer(const char *p,const char *suffix){
 size_t n=length(p),s=length(suffix);
 if(n!=8+36+s||!same(p,"bc-file-",8)||!same(p+n-s,suffix,s))return false;
 char id[37];for(unsigned i=0;i<36;i++)id[i]=p[8+i];id[36]=0;return bc_shell_uuid(id);
}
static void path(char out[128],const char *p){append(append(out,directory),p);}
static int error(void){int n=*MG_ERRNO();return n>0&&n<4096?n:5;}
static int size_of(void *f,uint32_t *size){
 *MG_ERRNO()=0;if(MG_SEEK(f,0,2))return error();
 int32_t n=MG_TELL(f);if(n<0)return error();if((uint32_t)n>BC_MGMT_MAX_FILE)return 27;
 *size=(uint32_t)n;return 0;
}
static int open_size(const char *p,uint32_t *size){
 *MG_ERRNO()=0;void *f=MG_OPEN(p,"rb");if(!f)return error();
 int e=size_of(f,size);if(MG_CLOSE(f)&&!e)e=error();return e;
}
static int read_at(const char *p,uint32_t offset,uint32_t n,uint8_t *out){
 *MG_ERRNO()=0;void *f=MG_OPEN(p,"rb");if(!f)return error();
 uint32_t size=0;int e=size_of(f,&size);
 if(!e&&(offset>size||n>size-offset))e=22;
 if(!e&&MG_SEEK(f,(int32_t)offset,0))e=error();
 if(!e&&MG_READ(out,1,n,f)!=n)e=error();
 if(MG_CLOSE(f)&&!e)e=error();
 return e;
}
static int write_at(const char *p,uint32_t offset,uint32_t n,const uint8_t *data,bool append_mode){
 if(!append_mode&&offset)return 22;
 if(append_mode){uint32_t saved=0;int e=open_size(p,&saved);if(e)return e;if(saved!=offset)return 22;}
 *MG_ERRNO()=0;void *f=MG_OPEN(p,append_mode?"ab":"wb");if(!f)return error();
 uint32_t size=0;int e=0;
 if(append_mode){e=size_of(f,&size);if(!e&&size!=offset)e=22;}
 else if(offset)e=22;
 if(!e&&MG_WRITE(data,1,n,f)!=n)e=error();
 if(MG_CLOSE(f)&&!e)e=error();
 return e;
}
static int execute(const char *id,uint8_t *out){
 if(!bc_shell_uuid(id))return 22;
 char input[128],intent[128];char *p=append(input,directory);p=append(p,"bc-file-");p=append(p,id);append(p,".bin");
 p=append(intent,directory);p=append(p,"bc-shell-");p=append(p,id);append(p,".mgmt");
 uint32_t n=0;int e=open_size(input,&n);if(e)return e;
 if(n>sizeof(command)-1)return 22;
 e=read_at(input,0,n,command);if(e)return e;
 struct bc_shell_request request;
 if(!bc_shell_parse_request(command,n,&request))return 22;
 uint32_t old=0;e=open_size(intent,&old);
 if(!e){
  if(old!=n||old>sizeof(previous)-1)return 17;
  e=read_at(intent,0,old,previous);if(e)return e;
  if(!same(command,previous,n))return 17;
  put32(out,2);return 0; /* Observe only; never publish again after uncertainty. */
 }
 if(e!=2)return e;
 *MG_ERRNO()=0;void *f=MG_OPEN(intent,"wbx");if(!f)return error();
 e=MG_WRITE(command,1,n,f)==n?0:error();if(MG_CLOSE(f)&&!e)e=error();if(e)return e;
 e=read_at(intent,0,n,previous);if(e)return e;if(!same(command,previous,n))return 5;
 struct bc_user_event event;volatile uint8_t *z=(volatile uint8_t *)&event;
 for(size_t i=0;i<sizeof(event);i++)z[i]=0;
 append(event.name,BC_SHELL_REQUEST_EVENT);append(event.package,BC_EVENT_APP);append(event.permissions,BC_EVENT_APP);
 p=append(event.params,"{\"v\":1,\"op\":\"exec\",\"id\":\"");p=append(p,id);append(p,"\"}");
 *MG_ERRNO()=0;if(MG_PUBLISH(&event)<0)return error();
 put32(out,1);return 0;
}
size_t bc_management_handle(const uint8_t *r,size_t n,uint8_t *out,size_t capacity){
 if(!out||capacity<BC_MGMT_REPLY+BC_MGMT_BLOCK)return 0;
 for(unsigned i=0;i<BC_MGMT_REPLY;i++)out[i]=0;
 out[0]='B';out[1]='C';out[2]='R';out[3]='1';
 int e=22;size_t bytes=0;
 if(!r||n<BC_MGMT_REQUEST||!same(r,"BCM1",4))goto done;
 out[4]=r[4];uint8_t op=r[4],flags=r[5],a=r[6],b=r[7];
 uint32_t offset=get32(r+8),count=get32(r+12);
 if(op<BC_MGMT_STAT||op>BC_MGMT_CAPS||flags>1||a>80||b>80||
    n<BC_MGMT_REQUEST+(size_t)a+b||offset>BC_MGMT_MAX_FILE||count>BC_MGMT_BLOCK)goto done;
 if(op!=BC_MGMT_WRITE&&flags)goto done;
 if(op!=BC_MGMT_READ&&op!=BC_MGMT_WRITE&&(offset||count))goto done;
 if(n!=BC_MGMT_REQUEST+(size_t)a+b+(op==BC_MGMT_WRITE?count:0))goto done;
 if(op==BC_MGMT_CAPS){if(a||b)goto done;put32(out+BC_MGMT_REPLY,0x7f);bytes=4;e=0;goto done;}
 if(!a||(op==BC_MGMT_MOVE?!b:b!=0))goto done;
 char first[81],second[81],one[128],two[128];
 if(!name(r+BC_MGMT_REQUEST,a,first))goto done;
 if(b&&!name(r+BC_MGMT_REQUEST+a,b,second))goto done;
 path(one,first);
 if(op==BC_MGMT_STAT){uint32_t size=0;e=open_size(one,&size);if(!e){put32(out+BC_MGMT_REPLY,size);bytes=4;}}
 else if(op==BC_MGMT_READ){e=read_at(one,offset,count,out+BC_MGMT_REPLY);if(!e)bytes=count;}
 else if(op==BC_MGMT_WRITE){
  if(!transfer(first,".part")||count>BC_MGMT_MAX_FILE-offset)goto done;
  e=write_at(one,offset,count,r+BC_MGMT_REQUEST+a,flags==1);
  if(!e){put32(out+BC_MGMT_REPLY,offset+count);bytes=4;}
 }else if(op==BC_MGMT_MOVE){
  if(!transfer(first,".part")||!transfer(second,".bin")||!same(first,second,44))goto done;
  path(two,second);*MG_ERRNO()=0;e=MG_RENAME(one,two)?error():0;
 }else if(op==BC_MGMT_DELETE){
  if(!transfer(first,".part")&&!transfer(first,".bin"))goto done;
  *MG_ERRNO()=0;e=MG_UNLINK(one)?error():0;
 }else if(op==BC_MGMT_EXEC){e=execute(first,out+BC_MGMT_REPLY);if(!e)bytes=4;}
done:
 put32(out+8,(uint32_t)e);return BC_MGMT_REPLY+(e?0:bytes);
}
