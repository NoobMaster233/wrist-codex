"""Pure Lua watchface container encoder; defaults match the live PS diagnostic."""
import re
import struct


def pack_lua_face(script,identifier,title,width=336,height=480,preview_rgba=None):
    assert isinstance(script,bytes) and 0<len(script)<65536
    assert re.fullmatch(r'[0-9]{9}',identifier,re.ASCII)
    title=title.encode('utf-8');assert 0<len(title)<=63 and b'\0' not in title
    assert (width,height) in [(336,480),(84,120)]
    name=b'lua/main.lua';start=304;size=20+len(name)+len(script);end=(start+size+3)&~3
    body=bytearray(end);body[:4]=bytes.fromhex('5aa53412');body[5]=9
    body[40:49]=identifier.encode();body[104:104+len(title)]=title
    def put(o,*v):struct.pack_into('<'+'I'*len(v),body,o,*v)
    put(16,0x800);put(28,1,end);put(172,end,1,256,0)
    for o in (188,196,204,212):put(o,272,0)
    put(216,1,272,0)
    for o in (228,236,244,252):put(o,288,0)
    put(260,0,288,16)
    struct.pack_into('<HHIII',body,272,0,0x500,0,start,size)
    struct.pack_into('<HHIII',body,288,0,0x500,0,0,0)
    body[start:start+3]=len(script).to_bytes(3,'little');body[start+3]=len(name)
    body[start+20:start+20+len(name)]=name;body[start+20+len(name):start+size]=script
    preview=bytes((23,15,9,255))*width*height if preview_rgba is None else preview_rgba
    assert isinstance(preview,bytes) and len(preview)==width*height*4
    body+=struct.pack('<IHHI',0,width,height,len(preview))+preview
    assert body[start+20+len(name):start+size]==script
    return bytes(body)
