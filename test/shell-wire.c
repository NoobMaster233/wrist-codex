/* Cross-language fixture and native validation boundaries; no firmware calls. */
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <limits.h>
#include "shell-wire.h"
static void put32(uint8_t *p,uint32_t v){for(unsigned i=0;i<4;i++)p[i]=(uint8_t)(v>>(8*i));}
int main(int argc,char **argv){
 assert(argc==2);FILE *f=fopen(argv[1],"rb");assert(f);
 uint8_t data[1100];size_t n=fread(data,1,sizeof(data),f);assert(!ferror(f));fclose(f);
 struct bc_shell_request request;
 assert(bc_shell_parse_request(data,n,&request));
 assert(request.timeout_ms==1234&&request.output_limit==4096&&request.command_bytes==18);
 assert(!memcmp(request.command,"echo shell-fixture",18));
 assert(bc_shell_crc32((const uint8_t *)"123456789",9)==0xcbf43926u);
 assert(!bc_shell_parse_request(data,n+1,&request));
 data[n-1]^=1;assert(!bc_shell_parse_request(data,n,&request));data[n-1]^=1;
 data[n-1]=0;put32(data+20,bc_shell_crc32(data+28,n-28));assert(!bc_shell_parse_request(data,n,&request));
 struct bc_user_event e={0},reply;
 const char *id="a4018b64-eaea-414b-b5de-4a519738bbb5";
 strcpy(e.name,BC_SHELL_REQUEST_EVENT);strcpy(e.package,BC_EVENT_APP);strcpy(e.permissions,BC_EVENT_APP);
 snprintf(e.params,sizeof(e.params),"{\"v\":1,\"op\":\"exec\",\"id\":\"%s\"}",id);
 char parsed[37];bool ping=true;
 assert(bc_shell_parse_event(&e,parsed,&ping)&&!ping&&!strcmp(parsed,id));
 strcpy(e.package,"another.app");assert(!bc_shell_parse_event(&e,parsed,&ping));strcpy(e.package,BC_EVENT_APP);
 strcpy(e.permissions,"another.app");assert(!bc_shell_parse_event(&e,parsed,&ping));strcpy(e.permissions,BC_EVENT_APP);
 strcpy(e.name,BC_EVENT_REQUEST);assert(!bc_shell_parse_event(&e,parsed,&ping));strcpy(e.name,BC_SHELL_REQUEST_EVENT);
 snprintf(e.params,sizeof(e.params),"{\"v\":1,\"op\":\"ping\",\"id\":\"%s\"}",id);
 assert(bc_shell_parse_event(&e,parsed,&ping)&&ping);
 e.params[strlen(e.params)]='x';assert(!bc_shell_parse_event(&e,parsed,&ping));
 assert(bc_shell_reply(&reply,id,"done",INT32_MIN,255,32768,INT32_MIN));
 assert(strlen(reply.params)<128&&!strcmp(reply.name,BC_SHELL_RESPONSE_EVENT));
 assert(!bc_shell_reply(&reply,id,NULL,0,0,0,0));
 assert(!bc_shell_reply(&reply,id,"exec",0,0,0,0));
 assert(!bc_shell_reply(&reply,"../../not-a-request","done",0,0,0,0));
 puts("Native shell framing: cross-language fixture, CRC/NUL/length, namespace, identity and response bounds passed");
 return 0;
}
