// Reads only our four bounded regular diagnostic files. No execution or paths from commands.
const names = ['report.txt', 'rc.txt', 'log.txt', 'fw.txt'];
const call = (file, method, options) => new Promise((resolve, reject) => {
  file[method]({ ...options, success:resolve, fail:(_, code)=>reject(new Error(method+':'+code)) });
});
export async function readNativeLoaderReport(file) {
  const reports = {};
  for (const name of names) {
    const uri = 'internal://files/bc-native-load-043-' + name;
    try {
      const metadata = await call(file,'get',{uri});
      if (!Number.isInteger(metadata.length) || metadata.length < 0 || metadata.length > 2048)
        throw new Error('Invalid report length');
      let text = '';
      if (metadata.length) {
        const data = await call(file,'readArrayBuffer',{uri,position:0,length:metadata.length});
        const bytes = data.buffer instanceof Uint8Array ? data.buffer : new Uint8Array(data.buffer);
        if (bytes.length !== metadata.length) throw new Error('Report length differs');
        for (let i=0;i<bytes.length;i++) {
          const value=bytes[i];
          if (value!==9 && value!==10 && value!==13 && (value<32 || value>126)) throw new Error('Non-text report');
          text += String.fromCharCode(value);
        }
      }
      reports[name] = {text};
    } catch (error) { reports[name] = {error:String(error.message||error).slice(0,100)}; }
  }
  return reports;
}
