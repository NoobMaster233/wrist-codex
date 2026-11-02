// Read installed resource identities through the factory channel.
import {DirectBand} from '../bridge/bluetooth/direct-band.mjs';
import {watchfaceListResponse} from '../bridge/bluetooth/install-resource.mjs';
import {wear} from '../bridge/bluetooth/protobuf.mjs';
import {fileURLToPath} from 'node:url';
const args=process.argv.slice(2);
if(args.length&&!(args.length===2&&args[0]==='--transport'&&['spp','ble'].includes(args[1])))throw new Error('Expected optional --transport spp|ble');
const band=new DirectBand(fileURLToPath(new URL('../',import.meta.url)),{transport:args[1]||'spp'});
try{
 const apps=await band.open(),faces=await band.requestL2(band.auth.encode(wear(4,0)),watchfaceListResponse);
 console.log(JSON.stringify({apps:apps.map(({packageName,versionCode})=>({packageName,versionCode})),faces,
  selected:faces.find(f=>f.current)?.id}));
}finally{await band.close();}
