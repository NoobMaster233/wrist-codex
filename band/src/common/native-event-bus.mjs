// Firmware .043 uses one shared uORB sample for system.event. Keep native
// requests in separate scheduler turns so a Shell/capture request is not
// overwritten immediately by the private transport's acknowledgement.
export function createNativeEventBus(native,{interval=80,schedule=setTimeout,cancel=clearTimeout,onTrace=()=>{}}={}) {
  const queue=[];let timer=null,closed=false,active=null,deadline=null,expectedResponse=null;
  const trace=(phase,item)=>{try{onTrace({phase,name:item.eventName,op:item.options?.params?.op||''});}catch{}};
  const complete=(reason='settled')=>{
    if(!active)return;cancel(deadline);trace(reason,active);active=null;expectedResponse=null;
    timer=schedule(drain,interval);
  };
  const expected=item=>{
    const p=item.options?.params||{};
    if(item.eventName==='bc.link.req'){
      if(['tx','txstatus'].includes(p.op))return {name:'bc.link.evt',ms:1500,match:r=>r.id===p.id&&['sent','failed'].includes(r.op)};
      if(['ping','show','hide'].includes(p.op))return {name:'bc.link.evt',ms:700,match:r=>r.op==='state'};
    }
    if(item.eventName==='bc.shell.req')return {name:'bc.shell.evt',ms:11000,match:r=>r.id===p.id&&['done','unknown','pong'].includes(r.op)};
    if(item.eventName==='bc.capture.req')return {name:'bc.capture.evt',ms:3500,match:r=>r.n===p.n&&['recording','done','cancelled','error','pong'].includes(r.op)};
    return null;
  };
  const drain=()=>{
    timer=null;
    const item=queue.shift();if(!item||closed)return;
    active=item;expectedResponse=expected(item);trace('published',item);
    deadline=schedule(()=>complete(expectedResponse?'timeout':'settled'),expectedResponse?.ms||interval);
    try{native.publish(item);}catch(error){item.fail?.(String(error.message||error),-1);complete('publish-failed');}
  };
  return {
    subscribe:options=>native.subscribe({...options,callback:data=>{
      const e=expectedResponse;
      if(e&&options.eventName===e.name&&data?.params&&e.match(data.params))complete('replied');
      options.callback(data);
    }}),
    unsubscribe:options=>native.unsubscribe(options),
    publish(options){
      if(closed||!native||typeof native.publish!=='function')throw new Error('Native event unavailable');
      if(queue.length>=96)throw new Error('Native event queue full');
      queue.push(options);if(timer===null&&!active)timer=schedule(drain,0);
    },
    // A microphone stop queued during onDestroy still drains before disposal.
    close(){closed=true;queue.length=0;cancel(deadline);cancel(timer);active=null;}
  };
}
