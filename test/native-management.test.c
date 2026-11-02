#define _GNU_SOURCE
#include <assert.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <unistd.h>
#include "shell-wire.h"
static char folder[128];static unsigned published,mutations;static int publish_error;
static const char *mapped(const char *p,char out[256]){
 const char *base="/data/files/dev.bandcodex.remote/";assert(!strncmp(p,base,strlen(base)));
 assert(!strchr(p+strlen(base),'/'));snprintf(out,256,"%s/%s",folder,p+strlen(base));return out;
}
static void *open_file(const char *p,const char *mode){char out[256];if(strchr(mode,'w')||strchr(mode,'a'))mutations++;return fopen(mapped(p,out),mode);}
static int rename_file(const char *a,const char *b){char x[256],y[256];mutations++;return rename(mapped(a,x),mapped(b,y));}
static int unlink_file(const char *p){char out[256];mutations++;return unlink(mapped(p,out));}
static int *error_address(void){return &errno;}
static int publish(const struct bc_user_event *e){
 char id[37];bool ping;assert(bc_shell_parse_event(e,id,&ping)&&!ping);published++;
 if(publish_error){errno=5;return -1;}return 0;
}
#define BC_MANAGEMENT_TEST 1
#define MG_OPEN open_file
#define MG_READ fread
#define MG_WRITE fwrite
#define MG_CLOSE fclose
#define MG_ERRNO error_address
#define MG_SEEK fseek
#define MG_TELL ftell
#define MG_RENAME rename_file
#define MG_UNLINK unlink_file
#define MG_PUBLISH publish
#include "management-043.c"
static uint8_t in[5000],out[5000];static size_t out_bytes;
static int op(unsigned kind,const char *a,const char *b,uint32_t at,const uint8_t *data,uint32_t n,unsigned flags){
 size_t x=strlen(a),y=strlen(b);memset(in,0,16);memcpy(in,"BCM1",4);in[4]=kind;in[5]=flags;in[6]=x;in[7]=y;
 put32(in+8,at);put32(in+12,n);memcpy(in+16,a,x);memcpy(in+16+x,b,y);
 if(kind==BC_MGMT_WRITE&&n)memcpy(in+16+x+y,data,n);
 out_bytes=bc_management_handle(in,16+x+y+(kind==BC_MGMT_WRITE?n:0),out,sizeof(out));
 assert(out_bytes>=12&&same(out,"BCR1",4)&&out[4]==kind);return get32(out+8);
}
static void seed(const char *name,const uint8_t *data,size_t n){char full[160];snprintf(full,sizeof(full),"/data/files/dev.bandcodex.remote/%s",name);void *f=open_file(full,"wb");assert(f&&fwrite(data,1,n,f)==n&&!fclose(f));}
int main(void){
 snprintf(folder,sizeof(folder),"%s/bc-management-XXXXXX",getenv("TMPDIR")?getenv("TMPDIR"):"/tmp");assert(mkdtemp(folder));
 const char *part="bc-file-11111111-2222-4333-8444-555555555555.part";
 const char *bin="bc-file-11111111-2222-4333-8444-555555555555.bin";
 uint8_t bytes[4096];for(unsigned i=0;i<sizeof(bytes);i++)bytes[i]=(uint8_t)(i*73+19);
 assert(op(BC_MGMT_CAPS,"","",0,0,0,0)==0&&get32(out+12)==127);
 assert(op(BC_MGMT_STAT,part,"",0,0,0,0)==2);
 assert(op(BC_MGMT_WRITE,part,"",0,bytes,4096,0)==0&&get32(out+12)==4096);
 assert(op(BC_MGMT_WRITE,part,"",4096,bytes,7,1)==0&&get32(out+12)==4103);
 unsigned before=mutations;assert(op(BC_MGMT_WRITE,part,"",8,bytes,3,0)==22&&mutations==before);
 assert(op(BC_MGMT_WRITE,part,"",123,bytes,3,1)==22&&mutations==before);
 assert(op(BC_MGMT_STAT,part,"",0,0,0,0)==0&&get32(out+12)==4103);
 assert(op(BC_MGMT_READ,part,"",4096,0,7,0)==0&&out_bytes==19&&same(out+12,bytes,7));
 assert(op(BC_MGMT_READ,part,"",4100,0,7,0)==22);
 assert(op(BC_MGMT_MOVE,part,bin,0,0,0,0)==0);
 assert(op(BC_MGMT_STAT,part,"",0,0,0,0)==2);
 assert(op(BC_MGMT_READ,bin,"",1,0,4096,0)==0&&same(out+12,bytes+1,4095)&&out[4107]==bytes[0]);
 before=mutations;
 for(unsigned i=0;i<2;i++)assert(op(BC_MGMT_WRITE,i?"bc-private-link-v1.key":"../outside","",0,bytes,1,0)==22);
 assert(op(BC_MGMT_WRITE,bin,"",0,bytes,1,0)==22);
 assert(op(BC_MGMT_DELETE,"bc-private-link-v1.key","",0,0,0,0)==22);
 assert(op(BC_MGMT_STAT,"bc-private-link-v1.key","",0,0,0,0)==22&&mutations==before);
 assert(op(BC_MGMT_DELETE,bin,"",0,0,0,0)==0);
 uint8_t request[31]={0};memcpy(request,"BCSH0431",8);put32(request+8,1);put32(request+12,3000);
 put32(request+16,3);memcpy(request+28,"pwd",3);put32(request+20,bc_shell_crc32(request+28,3));put32(request+24,128);
 const char *id="aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
 seed("bc-file-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.bin",request,sizeof(request));
 assert(op(BC_MGMT_EXEC,id,"",0,0,0,0)==0&&get32(out+12)==1&&published==1);
 assert(op(BC_MGMT_EXEC,id,"",0,0,0,0)==0&&get32(out+12)==2&&published==1);
 request[28]='l';put32(request+20,bc_shell_crc32(request+28,3));seed("bc-file-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.bin",request,sizeof(request));
 assert(op(BC_MGMT_EXEC,id,"",0,0,0,0)==17&&published==1);
 seed("bc-file-aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff.bin",request,sizeof(request));publish_error=1;
 assert(op(BC_MGMT_EXEC,"aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff","",0,0,0,0)==5&&published==2);
 assert(op(BC_MGMT_EXEC,"aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff","",0,0,0,0)==0&&get32(out+12)==2&&published==2);
 before=mutations;memset(in,0,sizeof(in));assert(bc_management_handle(in,15,out,sizeof(out))==12&&get32(out+8)==22&&mutations==before);
 printf("native management: bounded files, exact offsets, commit, path isolation, exclusive intent and unknown publish passed\n");
 char p[256];const char *names[]={"bc-file-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.bin","bc-file-aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff.bin","bc-shell-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.mgmt","bc-shell-aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff.mgmt"};
 for(unsigned i=0;i<4;i++){snprintf(p,sizeof(p),"%s/%s",folder,names[i]);assert(!unlink(p));}assert(!rmdir(folder));return 0;
}
