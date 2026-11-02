// Fixed native NSH file framing. Encoding alone never executes a command.
import { crc32 } from '../band/src/common/bytes.mjs';

export const SHELL_FLAGS = Object.freeze({ timeout:1, outputLimit:2, unknown:4,
  truncated:8, spawnFailed:16, ioFailed:32, cleanupFailed:64, duplicate:128 });
export const SHELL_MAX_COMMAND = 1024;
export const SHELL_MAX_OUTPUT = 32768;

export function encodeShellRequest(command, { timeoutMs=3000, outputLimit=8192 }={}) {
  if (typeof command!=='string' || !command.trim() || command.includes('\0')) throw new Error('Invalid NSH command');
  const body=Buffer.from(command,'utf8');
  if (body.length>SHELL_MAX_COMMAND) throw new Error('NSH command exceeds 1024 bytes');
  if (!Number.isInteger(timeoutMs) || timeoutMs<50 || timeoutMs>10000) throw new Error('Invalid NSH timeout');
  if (!Number.isInteger(outputLimit) || outputLimit<128 || outputLimit>SHELL_MAX_OUTPUT) throw new Error('Invalid NSH output limit');
  const data=Buffer.alloc(28+body.length);
  data.write('BCSH0431',0,'ascii');data.writeUInt32LE(1,8);data.writeUInt32LE(timeoutMs,12);
  data.writeUInt32LE(body.length,16);data.writeUInt32LE(crc32(body),20);data.writeUInt32LE(outputLimit,24);body.copy(data,28);
  return data;
}

export function decodeShellStatus(input) {
  const data=Buffer.from(input);
  if(data.length!==64 || data.toString('ascii',0,8)!=='BCSR0431' || data.readUInt32LE(8)!==1) throw new Error('Invalid NSH status frame');
  const status={phase:data.readUInt32LE(12),pid:data.readInt32LE(16),waitPid:data.readInt32LE(20),
    rawStatus:data.readInt32LE(24),error:data.readInt32LE(28),elapsedMs:data.readUInt32LE(32),
    flags:data.readUInt32LE(36),outputBytes:data.readUInt32LE(40),commandCrc:data.readUInt32LE(44),timeoutMs:data.readUInt32LE(48)};
  if(status.phase>3 || status.flags>255 || status.outputBytes>SHELL_MAX_OUTPUT || status.timeoutMs>10000 ||
    [52,56,60].some(i=>data.readUInt32LE(i)!==0)) throw new Error('Invalid NSH status fields');
  const f=status.flags;
  if(status.phase===2 && !(f&(SHELL_FLAGS.unknown|SHELL_FLAGS.cleanupFailed)) &&
    (status.pid>=2 ? status.waitPid!==status.pid || status.rawStatus<0 :
      !status.error || !(f&(SHELL_FLAGS.spawnFailed|SHELL_FLAGS.ioFailed)))) throw new Error('NSH child not confirmed reaped');
  status.outcome=status.phase===3 || (f&(SHELL_FLAGS.unknown|SHELL_FLAGS.cleanupFailed)) ? 'unknown' :
    status.phase!==2 ? 'pending' :
    f&SHELL_FLAGS.spawnFailed ? 'spawn-failed' : f&SHELL_FLAGS.ioFailed ? 'io-error' :
    f&SHELL_FLAGS.timeout ? 'timeout' : f&SHELL_FLAGS.outputLimit ? 'output-limit' :
    'completed';
  return status;
}
