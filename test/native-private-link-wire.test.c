#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "private-link-wire.h"
static uint8_t frame[BC_LINK_HEADER+BC_LINK_MAX_PAYLOAD],payload[BC_LINK_MAX_PAYLOAD];
static struct bc_link_decoder decoder;
static size_t expected_length,calls;
static bool delivered(void *context,uint8_t type,uint32_t sequence,const uint8_t *body,size_t n){
 (void)context;assert(type==BC_LINK_JSON&&sequence==0xffffffffu&&n==expected_length);
 assert(!memcmp(body,payload,n));calls++;return true;
}
static bool deny(void *context,uint8_t type,uint32_t sequence,const uint8_t *body,size_t n){
 (void)context;(void)type;(void)sequence;(void)body;(void)n;return false;
}
static void hex_is(const uint8_t *bytes,const char *expected){
 const char digits[]="0123456789abcdef";
 for(size_t i=0;i<32;i++){assert(digits[bytes[i]>>4]==expected[2*i]);assert(digits[bytes[i]&15]==expected[2*i+1]);}
}
int main(void){
 uint8_t digest[32],key[32]={0};
 bc_link_sha256((const uint8_t *)"",0,digest);
 hex_is(digest,"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
 bc_link_sha256((const uint8_t *)"abc",3,digest);
 hex_is(digest,"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
 for(unsigned i=0;i<20;i++)key[i]=0x0b;
 bc_link_hmac(key,(const uint8_t *)"Hi There",8,digest);
 hex_is(digest,"b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7");
 puts("SHA256 known vectors and RFC4231 HMAC");
 assert(bc_link_crc32((const uint8_t *)"123456789",9,0)==0xcbf43926u);
 assert(bc_link_crc32((const uint8_t *)"56789",5,bc_link_crc32((const uint8_t *)"1234",4,0))==0xcbf43926u);
 puts("CRC32 known vector and split updates");
 for(size_t i=0;i<sizeof(payload);i++)payload[i]=(uint8_t)(i*37+11);
 size_t sizes[]={0,1,17,1024,32768},chunks[]={1,7,16,17,990,4096,32784};
 for(size_t a=0;a<sizeof(sizes)/sizeof(*sizes);a++)for(size_t b=0;b<sizeof(chunks)/sizeof(*chunks);b++){
  expected_length=sizes[a];calls=0;size_t bytes=bc_link_frame(frame,sizeof(frame),BC_LINK_JSON,0xffffffffu,payload,expected_length);
  assert(bytes==BC_LINK_HEADER+expected_length);bc_link_decoder_init(&decoder);
  for(size_t at=0;at<bytes;){size_t n=bytes-at;if(n>chunks[b])n=chunks[b];assert(bc_link_feed(&decoder,frame+at,n,delivered,0));at+=n;}
  assert(calls==1&&decoder.used==0);
 }
 puts("35 combinations of payload and fragmented stream sizes");
 expected_length=17;size_t bytes=bc_link_frame(frame,sizeof(frame),BC_LINK_JSON,0xffffffffu,payload,expected_length);
 calls=0;bc_link_decoder_init(&decoder);assert(bc_link_feed(&decoder,frame,bytes,delivered,0));assert(bc_link_feed(&decoder,frame,bytes,delivered,0));assert(calls==2);
 frame[BC_LINK_HEADER+3]^=1;bc_link_decoder_init(&decoder);assert(!bc_link_feed(&decoder,frame,bytes,delivered,0));frame[BC_LINK_HEADER+3]^=1;
 frame[5]=1;bc_link_decoder_init(&decoder);assert(!bc_link_feed(&decoder,frame,bytes,delivered,0));frame[5]=0;
 frame[6]=1;frame[7]=0x80;bc_link_decoder_init(&decoder);assert(!bc_link_feed(&decoder,frame,16,delivered,0));
 bytes=bc_link_frame(frame,sizeof(frame),BC_LINK_JSON,0xffffffffu,payload,17);bc_link_decoder_init(&decoder);assert(!bc_link_feed(&decoder,frame,bytes,deny,0));
 assert(!bc_link_frame(frame,16,BC_LINK_JSON,1,payload,1));assert(!bc_link_frame(frame,sizeof(frame),0,1,payload,1));
 puts("Multiple frames, corruption, invalid flags, oversized body and callback refusal");
 return 0;
}
