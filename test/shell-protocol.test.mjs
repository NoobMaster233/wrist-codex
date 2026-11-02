import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeShellRequest, decodeShellStatus, SHELL_FLAGS } from '../bridge/shell-protocol.mjs';

function status({phase=2,pid=12,waitPid=12,rawStatus=0,flags=0,error=0}={}) {
  const b=Buffer.alloc(64);b.write('BCSR0431');b.writeUInt32LE(1,8);b.writeUInt32LE(phase,12);
  b.writeInt32LE(pid,16);b.writeInt32LE(waitPid,20);b.writeInt32LE(rawStatus,24);b.writeInt32LE(error,28);
  b.writeUInt32LE(286,32);b.writeUInt32LE(flags,36);b.writeUInt32LE(3000,48);return b;
}
test('NSH request counts UTF-8 bytes and rejects invalid command, deadline and output bounds',()=>{
  const b=encodeShellRequest('echo 你好',{timeoutMs:1234,outputLimit:4096});
  assert.equal(b.toString('ascii',0,8),'BCSH0431');assert.equal(b.readUInt32LE(16),11);assert.equal(b.length,39);
  for(const s of ['', '   ', 'echo\0bad', '你'.repeat(342)])assert.throws(()=>encodeShellRequest(s));
  for(const timeoutMs of [49,10001,1.5,NaN])assert.throws(()=>encodeShellRequest('uptime',{timeoutMs}));
  for(const outputLimit of [127,32769,Infinity])assert.throws(()=>encodeShellRequest('uptime',{outputLimit}));
});
test('NSH raw zero after a timed kill remains timeout, never successful normal exit',()=>{
  assert.equal(decodeShellStatus(status({flags:SHELL_FLAGS.timeout})).outcome,'timeout');
  assert.equal(decodeShellStatus(status({rawStatus:65280})).rawStatus,65280);
  assert.equal(decodeShellStatus(status({flags:SHELL_FLAGS.outputLimit})).outcome,'output-limit');
});
test('NSH uncertain cleanup dominates raw status and a running termination remains pending',()=>{
  assert.equal(decodeShellStatus(status({flags:SHELL_FLAGS.timeout|SHELL_FLAGS.cleanupFailed})).outcome,'unknown');
  assert.equal(decodeShellStatus(status({phase:1,flags:SHELL_FLAGS.timeout})).outcome,'pending');
  assert.equal(decodeShellStatus(status({phase:3,rawStatus:-99,waitPid:0})).outcome,'unknown');
});
test('NSH terminal status requires a reaped own child and rejects unsupported frames',()=>{
  assert.throws(()=>decodeShellStatus(status({waitPid:0})),/reaped/);
  assert.throws(()=>decodeShellStatus(status({pid:0,waitPid:0})),/reaped/);
  assert.throws(()=>decodeShellStatus(status({waitPid:0,error:5,flags:SHELL_FLAGS.ioFailed})),/reaped/);
  assert.equal(decodeShellStatus(status({pid:-1,waitPid:-99,rawStatus:-99,flags:SHELL_FLAGS.spawnFailed,error:12})).outcome,'spawn-failed');
  const bad=status();bad.writeUInt32LE(1,60);assert.throws(()=>decodeShellStatus(bad));
  assert.throws(()=>decodeShellStatus(status().subarray(1)));
});
