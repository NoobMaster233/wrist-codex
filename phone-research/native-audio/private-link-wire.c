/* Portable wire framing and SHA256/HMAC. No I/O or firmware addresses. */
#include "private-link-wire.h"
static void put32(uint8_t *p,uint32_t x){for(unsigned i=0;i<4;i++)p[i]=(uint8_t)(x>>(8*i));}
static uint32_t get32(const uint8_t *p){uint32_t x=0;for(unsigned i=0;i<4;i++)x|=(uint32_t)p[i]<<(8*i);return x;}
uint32_t bc_link_crc32(const uint8_t *data,size_t length,uint32_t previous){
 uint32_t crc=previous^0xffffffffu;
 for(size_t i=0;i<length;i++){
  crc^=data[i];for(unsigned bit=0;bit<8;bit++)crc=(crc>>1)^((crc&1u)?0xedb88320u:0u);
 }
 return crc^0xffffffffu;
}
bool bc_link_equal(const uint8_t *a,const uint8_t *b,size_t n){
 uint32_t difference=0;for(size_t i=0;i<n;i++)difference|=a[i]^b[i];return difference==0;
}
struct sha {uint32_t h[8];uint64_t bytes;size_t used;uint8_t block[64];};
static const uint32_t constants[64]={
 0x428a2f98u,0x71374491u,0xb5c0fbcfu,0xe9b5dba5u,0x3956c25bu,0x59f111f1u,0x923f82a4u,0xab1c5ed5u,
 0xd807aa98u,0x12835b01u,0x243185beu,0x550c7dc3u,0x72be5d74u,0x80deb1feu,0x9bdc06a7u,0xc19bf174u,
 0xe49b69c1u,0xefbe4786u,0x0fc19dc6u,0x240ca1ccu,0x2de92c6fu,0x4a7484aau,0x5cb0a9dcu,0x76f988dau,
 0x983e5152u,0xa831c66du,0xb00327c8u,0xbf597fc7u,0xc6e00bf3u,0xd5a79147u,0x06ca6351u,0x14292967u,
 0x27b70a85u,0x2e1b2138u,0x4d2c6dfcu,0x53380d13u,0x650a7354u,0x766a0abbu,0x81c2c92eu,0x92722c85u,
 0xa2bfe8a1u,0xa81a664bu,0xc24b8b70u,0xc76c51a3u,0xd192e819u,0xd6990624u,0xf40e3585u,0x106aa070u,
 0x19a4c116u,0x1e376c08u,0x2748774cu,0x34b0bcb5u,0x391c0cb3u,0x4ed8aa4au,0x5b9cca4fu,0x682e6ff3u,
 0x748f82eeu,0x78a5636fu,0x84c87814u,0x8cc70208u,0x90befffau,0xa4506cebu,0xbef9a3f7u,0xc67178f2u};
static uint32_t rotate(uint32_t x,unsigned n){return (x>>n)|(x<<(32-n));}
static void transform(struct sha *s){
 uint32_t w[64];for(unsigned i=0;i<16;i++){
  const uint8_t *p=s->block+4*i;w[i]=(uint32_t)p[0]<<24|(uint32_t)p[1]<<16|(uint32_t)p[2]<<8|p[3];
 }
 for(unsigned i=16;i<64;i++){
  uint32_t a=w[i-15],b=w[i-2];
  w[i]=w[i-16]+(rotate(a,7)^rotate(a,18)^(a>>3))+w[i-7]+(rotate(b,17)^rotate(b,19)^(b>>10));
 }
 uint32_t a=s->h[0],b=s->h[1],c=s->h[2],d=s->h[3],e=s->h[4],f=s->h[5],g=s->h[6],h=s->h[7];
 for(unsigned i=0;i<64;i++){
  uint32_t t1=h+(rotate(e,6)^rotate(e,11)^rotate(e,25))+((e&f)^(~e&g))+constants[i]+w[i];
  uint32_t t2=(rotate(a,2)^rotate(a,13)^rotate(a,22))+((a&b)^(a&c)^(b&c));
  h=g;g=f;f=e;e=d+t1;d=c;c=b;b=a;a=t1+t2;
 }
 s->h[0]+=a;s->h[1]+=b;s->h[2]+=c;s->h[3]+=d;s->h[4]+=e;s->h[5]+=f;s->h[6]+=g;s->h[7]+=h;
}
static void sha_init(struct sha *s){
 const uint32_t initial[8]={0x6a09e667u,0xbb67ae85u,0x3c6ef372u,0xa54ff53au,0x510e527fu,0x9b05688cu,0x1f83d9abu,0x5be0cd19u};
 for(unsigned i=0;i<8;i++)s->h[i]=initial[i];
 s->bytes=0;s->used=0;
}
static void sha_update(struct sha *s,const uint8_t *data,size_t n){
 s->bytes+=n;
 for(size_t i=0;i<n;i++){s->block[s->used++]=data[i];if(s->used==64){transform(s);s->used=0;}}
}
static void sha_final(struct sha *s,uint8_t out[32]){
 uint64_t bits=s->bytes*8;s->block[s->used++]=0x80;
 if(s->used>56){while(s->used<64)s->block[s->used++]=0;transform(s);s->used=0;}
 while(s->used<56)s->block[s->used++]=0;
 for(unsigned i=0;i<8;i++)s->block[63-i]=(uint8_t)(bits>>(8*i));
 transform(s);
 for(unsigned i=0;i<32;i++)out[i]=(uint8_t)(s->h[i/4]>>(24-8*(i%4)));
}
void bc_link_sha256(const uint8_t *data,size_t n,uint8_t out[32]){struct sha s;sha_init(&s);sha_update(&s,data,n);sha_final(&s,out);}
void bc_link_hmac(const uint8_t key[32],const uint8_t *data,size_t n,uint8_t out[32]){
 uint8_t pad[64],inner[32];struct sha s;
 for(unsigned i=0;i<64;i++)pad[i]=(i<32?key[i]:0)^0x36;
 sha_init(&s);sha_update(&s,pad,64);sha_update(&s,data,n);sha_final(&s,inner);
 for(unsigned i=0;i<64;i++)pad[i]=(i<32?key[i]:0)^0x5c;
 sha_init(&s);sha_update(&s,pad,64);sha_update(&s,inner,32);sha_final(&s,out);
}
size_t bc_link_frame(uint8_t *out,size_t capacity,uint8_t type,uint32_t sequence,const uint8_t *data,size_t n){
 if(n>BC_LINK_MAX_PAYLOAD||capacity<BC_LINK_HEADER+n||type<BC_LINK_HELLO||type>BC_LINK_MANAGEMENT_REPLY||(!data&&n))return 0;
 out[0]='B';out[1]='C';out[2]='P';out[3]='1';out[4]=type;out[5]=0;out[6]=(uint8_t)n;out[7]=(uint8_t)(n>>8);put32(out+8,sequence);
 for(size_t i=0;i<n;i++)out[BC_LINK_HEADER+i]=data[i];
 put32(out+12,bc_link_crc32(data,n,bc_link_crc32(out,12,0)));return BC_LINK_HEADER+n;
}
void bc_link_decoder_init(struct bc_link_decoder *p){p->used=0;p->expected=BC_LINK_HEADER;}
bool bc_link_feed(struct bc_link_decoder *p,const uint8_t *data,size_t n,bc_link_frame_cb callback,void *context){
 if(p->expected<BC_LINK_HEADER||p->expected>sizeof(p->data)||p->used>p->expected||(!data&&n)||!callback)return false;
 while(n){
  size_t take=p->expected-p->used;if(take>n)take=n;
  for(size_t i=0;i<take;i++)p->data[p->used+i]=data[i];
  p->used+=(uint32_t)take;data+=take;n-=take;
  if(p->used<BC_LINK_HEADER)continue;
  uint8_t *h=p->data;
  if(p->expected==BC_LINK_HEADER){
   if(h[0]!='B'||h[1]!='C'||h[2]!='P'||h[3]!='1'||h[4]<BC_LINK_HELLO||h[4]>BC_LINK_MANAGEMENT_REPLY||h[5])return false;
   uint32_t length=h[6]|(uint32_t)h[7]<<8;if(length>BC_LINK_MAX_PAYLOAD)return false;
   p->expected=BC_LINK_HEADER+length;
  }
  if(p->used==p->expected){
   size_t length=p->expected-BC_LINK_HEADER;const uint8_t *body=h+BC_LINK_HEADER;
   if(get32(h+12)!=bc_link_crc32(body,length,bc_link_crc32(h,12,0)))return false;
   if(!callback(context,h[4],get32(h+8),body,length))return false;
   bc_link_decoder_init(p);
  }
 }
 return true;
}
