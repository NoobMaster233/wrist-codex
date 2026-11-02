"""Actual local Opus encode/decode and bounded container rejection; no microphone."""
import ctypes,importlib.util,math,struct
from pathlib import Path
spec=importlib.util.spec_from_file_location('capture',Path('scripts/read-native-capture.py'))
capture=importlib.util.module_from_spec(spec);spec.loader.exec_module(capture)
opus=ctypes.CDLL('libopus.so');opus.opus_encoder_create.argtypes=[ctypes.c_int32,ctypes.c_int,ctypes.c_int,ctypes.POINTER(ctypes.c_int)];opus.opus_encoder_create.restype=ctypes.c_void_p
opus.opus_encode.argtypes=[ctypes.c_void_p,ctypes.POINTER(ctypes.c_int16),ctypes.c_int,ctypes.POINTER(ctypes.c_ubyte),ctypes.c_int32];opus.opus_encode.restype=ctypes.c_int32
opus.opus_encoder_destroy.argtypes=[ctypes.c_void_p];opus.opus_encoder_destroy.restype=None
error=ctypes.c_int();encoder=opus.opus_encoder_create(16000,1,2048,ctypes.byref(error));assert encoder and not error.value
frames=[]
try:
 for n in range(3):
  pcm=(ctypes.c_int16*320)(*(int(8000*math.sin(2*math.pi*440*(n*320+i)/16000))for i in range(320)))
  packet=(ctypes.c_ubyte*4096)();length=opus.opus_encode(encoder,pcm,320,packet,4096);assert 0<length<=4096
  frames.append(bytes(packet[:length]))
finally:opus.opus_encoder_destroy(encoder)
payload=b''.join(struct.pack('<I',len(f))+f for f in frames)
header=capture.HEADER.pack(b'BCAP0431',1,16000,20,1000,0,0,0,3,len(payload),0,0,0,0,3)
blob=header+payload;h,packets=capture.parse_capture(blob);assert packets==frames
audio,info=capture.decode_opus(h,packets);assert audio[:4]==b'RIFF' and info['samples']==960 and info['peak']>0
service_header=capture.HEADER.pack(b'BCAP0432',2,16000,20,1000,0,0,0,3,len(payload),0,0,0,0,3)
service,packets=capture.parse_capture(service_header+payload)
assert capture.decode_opus(service,packets)[1]['samples']==960
for changed in [dict(service,dropped=1),dict(service,stage=101)]:
 try:capture.decode_opus(changed,packets)
 except ValueError:pass
 else:raise AssertionError('Incomplete/lossy capture decoded as complete')
for bad in [blob[:-1],b'X'+blob[1:],blob[:36]+struct.pack('<I',2)+blob[40:],blob[:64]+struct.pack('<I',5000)+blob[68:]]:
 try:capture.parse_capture(bad)
 except ValueError:pass
 else:raise AssertionError('Malformed container accepted')
print('PASS: real local Opus tone encode/decode and truncated, wrong-magic, wrong-count, oversized-frame rejection; no microphone')
