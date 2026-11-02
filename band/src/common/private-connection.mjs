// Interconnect-shaped adapter for the authenticated native SPP service.
// The native event carries only a mailbox ID; conversation text stays in the
// App private directory. A lost acknowledgement is queried, never replayed.
export function utf8Length(text) {
  let size=0;
  for(let i=0;i<text.length;i++) {
    const c=text.charCodeAt(i);
    if(c<0x80)size++;else if(c<0x800)size+=2;
    else if(c>=0xd800&&c<=0xdbff&&i+1<text.length&&text.charCodeAt(i+1)>=0xdc00&&text.charCodeAt(i+1)<=0xdfff){size+=4;i++;}
    else size+=3;
  }
  return size;
}
export function encodeUtf8(text) {
  const bytes=new Uint8Array(utf8Length(text));let at=0;
  for(let i=0;i<text.length;i++) {
    let cp=text.charCodeAt(i);
    if(cp>=0xd800&&cp<=0xdbff&&i+1<text.length&&text.charCodeAt(i+1)>=0xdc00&&text.charCodeAt(i+1)<=0xdfff)
      cp=0x10000+((cp-0xd800)<<10)+(text.charCodeAt(++i)-0xdc00);
    else if(cp>=0xd800&&cp<=0xdfff)cp=0xfffd;
    if(cp<0x80)bytes[at++]=cp;
    else if(cp<0x800){bytes[at++]=0xc0|(cp>>6);bytes[at++]=0x80|(cp&63);}
    else if(cp<0x10000){bytes[at++]=0xe0|(cp>>12);bytes[at++]=0x80|((cp>>6)&63);bytes[at++]=0x80|(cp&63);}
    else{bytes[at++]=0xf0|(cp>>18);bytes[at++]=0x80|((cp>>12)&63);bytes[at++]=0x80|((cp>>6)&63);bytes[at++]=0x80|(cp&63);}
  }
  return bytes;
}
export function decodeUtf8(bytes) {
  let text='';
  for(let i=0;i<bytes.length;) {
    const first=bytes[i++];let cp=first,more=0,minimum=0;
    if(first>=0xc2&&first<=0xdf){cp=first&31;more=1;minimum=0x80;}
    else if(first>=0xe0&&first<=0xef){cp=first&15;more=2;minimum=0x800;}
    else if(first>=0xf0&&first<=0xf4){cp=first&7;more=3;minimum=0x10000;}
    else if(first>0x7f)throw new Error('Invalid private UTF-8');
    if(i+more>bytes.length)throw new Error('Truncated private UTF-8');
    for(let n=0;n<more;n++){const b=bytes[i++];if((b&0xc0)!==0x80)throw new Error('Invalid private UTF-8');cp=(cp<<6)|(b&63);}
    if(cp<minimum||cp>0x10ffff||cp>=0xd800&&cp<=0xdfff)throw new Error('Invalid private UTF-8');
    if(cp<0x10000)text+=String.fromCharCode(cp);
    else{cp-=0x10000;text+=String.fromCharCode(0xd800+(cp>>10),0xdc00+(cp&1023));}
  }
  return text;
}
const id16=value=>typeof value==='string'&&/^[a-f0-9]{16}$/.test(value);
const hex8=value=>('00000000'+(value>>>0).toString(16)).slice(-8);

export function createNativeConnection({event,file,now=()=>Date.now(),timings={}}) {
  const periods={probe:1500,ack:6000,reconcile:3000,io:8000,...timings};
  const connection={available:false,ready:false,onstate:null,onmessage:null,onerror:null,onavailability:null};
  const epoch=hex8(now());let sequence=0,destroyed=false,shown=false,reqSub,evtSub,probeTimer,startTimer,active=null;
  const queue=[],seen=[];let receiving=Promise.resolve();
  const call=(method,options)=>new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('File '+method+' timed out')),periods.io);
    const finish=(error,result)=>{clearTimeout(timer);if(destroyed)reject(new Error('App closed'));else if(error)reject(error);else resolve(result);};
    try{file[method]({...options,success:r=>finish(null,r),fail:(_,code)=>finish(new Error('File '+method+':'+code))});}catch(error){finish(error);}
  });
  const publish=(op,id='0000000000000000')=>{
    if(destroyed||typeof reqSub!=='number'||typeof evtSub!=='number')return false;
    try{event.publish({eventName:'bc.link.req',options:{params:{v:1,op,id},permissions:['dev.bandcodex.remote']}});return true;}catch(_){return false;}
  };
  const discard=uri=>{call('delete',{uri}).catch(()=>{});};
  const readText=async(uri,length)=>{
    const all=new Uint8Array(length);
    for(let position=0;position<length;position+=4096){
      const count=Math.min(4096,length-position),part=await call('readArrayBuffer',{uri,position,length:count});
      const bytes=part.buffer instanceof Uint8Array?part.buffer:new Uint8Array(part.buffer);
      if(bytes.length!==count)throw new Error('Private message read length differs');all.set(bytes,position);
    }
    return decodeUtf8(all);
  };
  const finish=(job,error)=>{
    if(job.finished)return;job.finished=true;clearTimeout(job.timer);
    if(active===job)active=null;
    const at=queue.indexOf(job);if(at>=0)queue.splice(at,1);
    try{if(error)job.options.fail?.(error,-1);else job.options.success?.({sent:true});}catch(_){}
    pump();
  };
  const state=up=>{
    const was=connection.ready,known=connection.available;connection.available=true;connection.ready=up;clearTimeout(probeTimer);
    if(!known)connection.onavailability?.(true);
    if(was!==up)connection.onstate?.(up);
    if(!up)for(const job of queue.slice())finish(job,'Phone send failed: connection closed');
  };
  const pump=()=>{
    if(active||destroyed||!connection.ready||!queue.length)return;
    const job=queue[0];active=job;
    const current=()=>{
      if(destroyed||job.finished||active!==job||!connection.ready)throw new Error('Phone send failed: connection closed');
      if(now()>job.deadline)throw new Error('Phone send failed: request expired');
    };
    (async()=>{
      current();await call('writeArrayBuffer',{uri:job.uri,position:0,append:false,buffer:encodeUtf8(job.text)});current();
      const info=await call('get',{uri:job.uri});current();
      if(info.length!==utf8Length(job.text))throw new Error('Private message file differs');
      const read=await readText(job.uri,info.length);current();
      if(read!==job.text)throw new Error('Private message file differs');
      job.timer=setTimeout(()=>{
        if(job.finished)return;
        publish('txstatus',job.id);
        job.timer=setTimeout(()=>finish(job,'Phone send failed: receipt unknown'),periods.reconcile);
      },periods.ack);
      if(!publish('tx',job.id))throw new Error('Phone send failed: native event unavailable');
    })().catch(error=>finish(job,String(error.message||error)));
  };
  const receiveMailbox=(id,bytes)=>{
    receiving=receiving.then(async()=>{
      if(destroyed)return;
      if(seen.indexOf(id)>=0){publish('rxack',id);return;}
      const uri='internal://files/bc-link-rx-'+id+'.json';
      try {
        const info=await call('get',{uri});if(info.length!==bytes)throw new Error('Private receive length differs');
        const text=await readText(uri,bytes);
        const value=JSON.parse(text);if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid private message');
        if(destroyed)return;
        connection.onmessage?.({data:text});
        seen.push(id);if(seen.length>32)seen.shift();publish('rxack',id);discard(uri);
      }catch(error){if(!destroyed){publish('rxreject',id);connection.onerror?.({code:-1,data:String(error.message||error)});}}
    }).catch(()=>{});
  };
  const incoming=data=>{
    const message=data?.params;
    if(destroyed||data?.package!=='dev.bandcodex.link'||message?.v!==1)return;
    if(message.op==='state'&&(message.up===0||message.up===1)&&/^[a-f0-9]{8}$/.test(message.s||'')){state(message.up===1);return;}
    if(message.op==='rx'&&id16(message.id)&&Number.isInteger(message.b)&&message.b>=2&&message.b<=32768){
      // RX is emitted only after native mutual authentication. Recover if its
      // immediately preceding state event was coalesced by the firmware.
      if(!connection.ready)state(true);
      receiveMailbox(message.id,message.b);return;
    }
    if((message.op==='sent'||message.op==='failed')&&id16(message.id)&&Number.isInteger(message.e)){
      if(active?.id!==message.id)return;
      const job=active;
      if(message.op==='sent'&&message.e===0){discard(job.uri);finish(job,null);}
      else finish(job,'Phone send failed: native receipt '+message.e);
    }
  };
  connection.send=options=>{
    if(destroyed||!connection.ready){options.fail?.('Phone send failed: not connected',-1);return;}
    let text;
    try{text=JSON.stringify(options.data);if(typeof text!=='string'||utf8Length(text)>32768)throw new Error('Private message exceeds limit');}
    catch(error){options.fail?.(String(error.message||error),-1);return;}
    if(queue.length>=24||sequence===0xffffffff){options.fail?.('Private message queue is full',-1);return;}
    const id=epoch+hex8(++sequence),uri='internal://files/bc-link-tx-'+id+'.json';
    queue.push({id,uri,text,options,finished:false,timer:null,deadline:now()+12000});pump();
  };
  connection.probe=()=>publish('ping');
  connection.show=()=>{shown=true;return publish('show');};
  connection.hide=()=>{shown=false;return publish('hide');};
  connection.destroy=()=>{
    if(destroyed)return;publish('hide');destroyed=true;clearTimeout(startTimer);clearTimeout(probeTimer);
    for(const job of queue.slice())finish(job,'App closed');
    for(const id of [reqSub,evtSub])if(typeof id==='number')try{event.unsubscribe({id});}catch(_){}
  };
  startTimer=setTimeout(()=>{
    if(destroyed)return;
    try {
      reqSub=event.subscribe({eventName:'bc.link.req',callback:()=>{}});
      evtSub=event.subscribe({eventName:'bc.link.evt',callback:incoming});
      if(typeof reqSub!=='number'||typeof evtSub!=='number')throw new Error('Native event unavailable');
      probeTimer=setTimeout(()=>{if(!connection.available)connection.onavailability?.(false);},periods.probe);
      publish(shown?'show':'ping');
    }catch(_){connection.onavailability?.(false);}
  },0);
  return connection;
}

export function createBandConnection({event,file,legacy,now,timings}) {
  const native=createNativeConnection({event,file,now,timings});
  const connection={onopen:null,onclose:null,onerror:null,onmessage:null};
  let route='probing',connected=false,destroyed=false,old=null;
  const announce=up=>{
    if(up===connected)return;connected=up;
    if(up)connection.onopen?.();else connection.onclose?.();
  };
  const fallback=()=>{
    if(old)return old;
    old=typeof legacy==='function'?legacy():legacy;
    old.onopen=()=>{if(route==='legacy')announce(true);};
    old.onclose=()=>{if(route==='legacy')announce(false);};
    old.onerror=error=>{if(route==='legacy')connection.onerror?.(error);};
    old.onmessage=event=>{if(route==='legacy')connection.onmessage?.(event);};
    return old;
  };
  native.onavailability=available=>{
    if(destroyed)return;
    if(route==='probing')route=available?'native':'legacy';
    if(route==='legacy')fallback().getReadyState({success:r=>announce(r.status===1),fail:()=>announce(false)});
  };
  native.onstate=up=>{if(up)route='native';if(route==='native')announce(up);};
  native.onmessage=event=>{if(route==='native')connection.onmessage?.(event);};
  native.onerror=error=>{if(route==='native')connection.onerror?.(error);};
  connection.send=options=>{
    if(destroyed){options.fail?.('App closed',-1);return;}
    if(route==='native')native.send(options);
    else if(route==='legacy')fallback().send(options);
    else options.fail?.('正在检测手机通道',-1);
  };
  connection.getReadyState=options=>{
    native.probe();
    if(route==='legacy')fallback().getReadyState(options);
    else options.success?.({status:native.ready?1:0});
  };
  connection.show=()=>native.show();connection.hide=()=>native.hide();
  connection.destroy=()=>{
    destroyed=true;native.destroy();
    if(old)old.onopen=old.onclose=old.onmessage=old.onerror=null;
  };
  return connection;
}
