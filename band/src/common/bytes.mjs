// Byte helpers shared by the RPK and phone. No Node/browser-only APIs.
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export function crc32(bytes, previous = 0) {
  let crc = (previous ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
export function encode64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += alphabet[a >>> 2] + alphabet[((a & 3) << 4) | (b >>> 4)] +
      (i + 1 < bytes.length ? alphabet[((b & 15) << 2) | (c >>> 6)] : '=') +
      (i + 2 < bytes.length ? alphabet[c & 63] : '=');
  }
  return out;
}
export function decode64(text, maximum = 1048576) {
  if (typeof text !== 'string' || text.length % 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text))
    throw new Error('Invalid base64');
  const length = text.length / 4 * 3 - (text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0);
  if (length > maximum) throw new Error('Binary payload exceeds limit');
  const out = new Uint8Array(length);
  for (let i = 0, j = 0; i < text.length; i += 4) {
    const n = alphabet.indexOf(text[i]) << 18 | alphabet.indexOf(text[i + 1]) << 12 |
      (text[i + 2] === '=' ? 0 : alphabet.indexOf(text[i + 2])) << 6 |
      (text[i + 3] === '=' ? 0 : alphabet.indexOf(text[i + 3]));
    if (j < length) out[j++] = n >>> 16;
    if (j < length) out[j++] = n >>> 8;
    if (j < length) out[j++] = n;
  }
  if (encode64(out) !== text) throw new Error('Non-canonical base64');
  return out;
}

export async function uploadBlob(bytes, { id, name, rpc, cancelled = () => false, chunkBytes: requestedChunkBytes = 128 }) {
  return uploadSource({size:bytes.length, checksum:crc32(bytes), readChunk:async(offset,length)=>bytes.subarray(offset,offset+length),
    id,name,rpc,cancelled,chunkBytes:requestedChunkBytes});
}

/** Bounded upload: callers can read a file without holding its contents in RAM. */
export const interruptedTransfer=error=>/^(Phone request timed out|Phone send failed:|App closed|File upload cancelled|File reception cancelled|Transfer cancelled)/.test(String(error?.message||error));

export async function uploadSource({size,checksum,readChunk,id,name,rpc,cancelled=()=>false,chunkBytes:requestedChunkBytes=128,progress=()=>{},resumable=false}) {
  if (!Number.isInteger(size)||size<0||size>1048576||!Number.isInteger(checksum)||checksum<0||checksum>0xffffffff)
    throw new Error('Invalid upload source');
  if (![128,1024].includes(requestedChunkBytes)) throw new Error('Unsupported upload chunk size');
  const check=()=>{if(cancelled())throw new Error('Transfer cancelled');};
  check();
  try {
  const opened = await rpc({ t: 'open', id, name, size, crc: checksum, chunkBytes:requestedChunkBytes });
  if (opened.state === 'complete') return opened;
  // An older phone omits the negotiated size and still expects 128-byte frames.
  const chunkBytes = opened.chunkBytes === undefined ? 128 : opened.chunkBytes;
  if (![128,1024].includes(chunkBytes) || chunkBytes > requestedChunkBytes)
    throw new Error('Invalid negotiated upload chunk size');
  let sequence = opened.next;
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > Math.ceil(size / chunkBytes))
    throw new Error('Invalid transfer resume position');
  while (sequence * chunkBytes < size) {
    check();
    const length=Math.min(chunkBytes,size-sequence*chunkBytes);
    const data = await readChunk(sequence*chunkBytes,length);
    check();
    if(!(data instanceof Uint8Array)||data.length!==length)throw new Error('Upload read length differs');
    const ack = await rpc({ t: 'chunk', id, seq: sequence, b64: encode64(data), crc: crc32(data) });
    if (ack.next !== sequence + 1) throw new Error('Unexpected transfer acknowledgement');
    sequence = ack.next;
    progress(Math.min(sequence*chunkBytes,size),size);
  }
  check();
  return await rpc({ t: 'finish', id });
  } catch(error) {
    if(!resumable||!interruptedTransfer(error)){try{await rpc({t:'cancel',id});}catch(_){}}
    throw error;
  }
}
