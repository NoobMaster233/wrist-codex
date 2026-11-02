"""Inspect our bounded native capture container; optionally decode Opus locally."""
import argparse,ctypes,hashlib,io,json,math,struct,wave
from pathlib import Path

HEADER=struct.Struct('<8s4I3i7I')
KEYS=['magic','version','rate','frameMs','durationMs','openResult','startResult','closeResult',
      'frames','bytes','dropped','busy','configResult','busyAfter','stage']

def parse_header(data):
    if len(data)<HEADER.size:raise ValueError('Native header truncated')
    values=list(HEADER.unpack_from(data));values[0]=values[0].decode('ascii')
    header=dict(zip(KEYS,values))
    legacy=values[:5]==['BCAP0431',1,16000,20,1000]
    service=values[:4]==['BCAP0432',2,16000,20] and 0<=header['durationMs']<=25000
    if not (legacy or service):raise ValueError('Native header differs')
    if header['bytes']>(65536 if service else 32768) or header['frames']>(1300 if service else 8192):
        raise ValueError('Native capture exceeds bound')
    return header

def parse_capture(data):
    h=parse_header(data)
    if len(data)!=64+h['bytes']:raise ValueError('Native file length differs')
    frames=[];position=64
    while position<len(data):
        if len(data)-position<4:raise ValueError('Frame header truncated')
        length=struct.unpack_from('<I',data,position)[0];position+=4
        if not 0<length<=4096 or position+length>len(data):raise ValueError('Native frame length differs')
        frames.append(data[position:position+length]);position+=length
    if len(frames)!=h['frames']:raise ValueError('Native frame count differs')
    return h,frames

def decode_opus(header,frames):
    if not frames or header['stage']!=3 or any(header[k]!=0 for k in ['openResult','startResult','closeResult','busy','configResult','busyAfter','dropped']):
        raise ValueError('Capture did not complete successfully')
    opus=ctypes.CDLL('libopus.so');ptr=ctypes.POINTER(ctypes.c_ubyte)
    opus.opus_decoder_create.argtypes=[ctypes.c_int32,ctypes.c_int,ctypes.POINTER(ctypes.c_int)];opus.opus_decoder_create.restype=ctypes.c_void_p
    opus.opus_decoder_destroy.argtypes=[ctypes.c_void_p];opus.opus_decoder_destroy.restype=None
    opus.opus_packet_get_nb_samples.argtypes=[ptr,ctypes.c_int32,ctypes.c_int32];opus.opus_packet_get_nb_samples.restype=ctypes.c_int
    opus.opus_packet_get_nb_channels.argtypes=[ptr];opus.opus_packet_get_nb_channels.restype=ctypes.c_int
    opus.opus_decode.argtypes=[ctypes.c_void_p,ptr,ctypes.c_int32,ctypes.POINTER(ctypes.c_int16),ctypes.c_int,ctypes.c_int];opus.opus_decode.restype=ctypes.c_int
    error=ctypes.c_int();decoder=opus.opus_decoder_create(16000,1,ctypes.byref(error))
    if not decoder or error.value:raise ValueError('Opus decoder unavailable')
    blocks=[];samples=0;peak=0;energy=0;durations=set()
    try:
        for frame in frames:
            packet=(ctypes.c_ubyte*len(frame)).from_buffer_copy(frame)
            expected=opus.opus_packet_get_nb_samples(packet,len(frame),16000)
            if not 0<expected<=1920 or opus.opus_packet_get_nb_channels(packet)!=1:
                raise ValueError('Callback bytes are not supported mono Opus packets')
            if header['version']==2 and expected!=320:raise ValueError('Native packet duration differs')
            pcm=(ctypes.c_int16*1920)();count=opus.opus_decode(decoder,packet,len(frame),pcm,1920,0)
            if count!=expected:raise ValueError('Callback Opus packet failed decoding')
            samples+=count
            limit=min(400000,(header['durationMs']+1000)*16) if header['version']==2 else 32000
            if samples>limit:raise ValueError('Decoded duration exceeds capture bound')
            values=pcm[:count];blocks.append(struct.pack('<'+'h'*count,*values))
            peak=max(peak,max(abs(x) for x in values));energy+=sum(x*x for x in values);durations.add(count)
    finally:opus.opus_decoder_destroy(decoder)
    buffer=io.BytesIO()
    with wave.open(buffer,'wb') as output:
        output.setparams((1,2,16000,0,'NONE','not compressed'));output.writeframes(b''.join(blocks))
    return buffer.getvalue(),{'samples':samples,'durationMs':samples/16,'rate':16000,'channels':1,
        'peak':peak,'rms':round(math.sqrt(energy/max(1,samples)),3),'packetSamples':sorted(durations)}

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('file',type=Path)
    parser.add_argument('--status',action='store_true');parser.add_argument('--wav',type=Path);args=parser.parse_args()
    try:
        data=args.file.read_bytes()
        if args.status:
            if len(data)!=64 or args.wav:raise ValueError('Expected one status header')
            result={'header':parse_header(data)}
        else:
            header,frames=parse_capture(data);result={'header':header,'packetLengths':sorted(set(map(len,frames))),'sha256':hashlib.sha256(data).hexdigest()}
            if args.wav:
                audio,info=decode_opus(header,frames);args.wav.parent.mkdir(parents=True,exist_ok=True)
                with args.wav.open('xb') as output:output.write(audio)
                args.wav.chmod(0o600);result.update(decoded=info,wavSha256=hashlib.sha256(audio).hexdigest(),wav=str(args.wav))
        print(json.dumps(result,ensure_ascii=False))
    except Exception as error:raise SystemExit(type(error).__name__+': '+str(error))
