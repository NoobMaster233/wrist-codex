const uuid=id=>typeof id==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
const integer=(n,min,max)=>Number.isInteger(n)&&n>=min&&n<=max;

// One publish only. Timeout asks the phone to read the saved receipt; it never
// republishes exec. Capture and Shell use separate subscriptions and messages.
export function createNativeShellRequest({event,id,timeoutMs=3000,ackMs=timeoutMs+8000}) {
  let requestSubscription,subscription,timer,settled=false,cancel=()=>{};
  const done=new Promise((resolve,reject)=>{
    const release=()=>{
      clearTimeout(timer);
      for(const id of [requestSubscription,subscription])if(typeof id==='number')try{event.unsubscribe({id});}catch(_){}
    };
    const finish=(error,result)=>{
      if(settled)return;settled=true;release();error?reject(error):resolve(result);
    };
    cancel=()=>finish(new Error('Shell page closed'));
    if(!uuid(id)||!integer(timeoutMs,50,10000)||!integer(ackMs,timeoutMs+1000,30000)){
      finish(new Error('Invalid shell request'));return;
    }
    try {
      // .043's publisher rejects a name absent from its subscription registry,
      // even if a native task already subscribes to the underlying uORB topic.
      requestSubscription=event.subscribe({eventName:'bc.shell.req',callback:()=>{}});
      if(typeof requestSubscription!=='number')throw new Error('Shell request registration unavailable');
      subscription=event.subscribe({eventName:'bc.shell.evt',callback:data=>{
        const p=data?.params;
        if(settled||data?.package!=='dev.bandcodex.shell'||p?.v!==1||p.id!==id||!['done','unknown'].includes(p.op)||
           !integer(p.r,-2147483648,2147483647)||!integer(p.f,0,255)||!integer(p.b,0,32768)||!integer(p.e,-2147483648,2147483647))return;
        finish(null,{id,op:p.op,r:p.r,f:p.f,b:p.b,e:p.e});
      }});
      if(typeof subscription!=='number')throw new Error('Shell subscription unavailable');
      if(settled){release();return;}
      timer=setTimeout(()=>finish(null,{id,op:'no-event'}),ackMs);
      event.publish({eventName:'bc.shell.req',options:{params:{v:1,op:'exec',id},permissions:['dev.bandcodex.remote']}});
    }catch(error){finish(null,{id,op:'no-event'});}
  });
  return {done,cancel};
}
