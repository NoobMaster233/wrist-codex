// Local system.event control only. Audio files use the existing BLE uploader.
const packageName = 'dev.bandcodex.native';
const errors = {
  10:'麦克风正被其他应用使用',11:'录音配置失败',12:'录音缓冲暂时无法结束',
  13:'保存录音失败',14:'麦克风打开失败',15:'录音启动失败',16:'麦克风关闭失败',
  17:'录音服务需要重新加载',19:'录音数据超过容量',20:'录音服务启动失败',
  22:'录音事件通道已中断',23:'录音状态通知失败',24:'此录音编号已经使用',
  25:'没有采集到声音，请重新录音',26:'手环录音状态已变化，请重新开始'
};
export function recordingNonce(sessionId) {
  if (typeof sessionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(sessionId))
    throw new Error('Invalid recording session');
  return sessionId.replace(/-/g,'');
}
export function createNativeAudioController({event,onState,onQuiescent=()=>{},onError=()=>{},timeoutMs=12000}) {
  let requestSubscription,subscription, active=null, timer, closed=false;
  const cancelled=[];
  const notify=state=>{
    try { Promise.resolve(onState(state)).catch(onError); } catch(error) { onError(error); }
  };
  const publish=(action,nonce)=>event.publish({eventName:'bc.capture.req',
    options:{params:{v:2,op:action,n:nonce},permissions:['dev.bandcodex.remote']}});
  const report=(op,error=0)=>{
    if(!active)return;
    const signature=op+':'+error;
    if(active.signature===signature)return;
    active.signature=signature;active.phase=op;
    active.terminal=['done','cancelled','error'].includes(op);
    const base={sessionId:active.sessionId};
    if(op==='recording')notify({...base,phase:'recording'});
    else if(op==='done')notify({...base,phase:'receiving',name:'bc-audio-'+active.nonce+'.bcap'});
    else if(op==='cancelled')notify({...base,phase:'cancelled'});
    else if(op==='error')notify({...base,phase:'error',error:errors[error]||'手环录音失败，请重新开始'});
  };
  const arm=()=>{
    clearTimeout(timer);
    const session=active;
    timer=setTimeout(()=>{
      if(closed||active!==session)return;
      // A failed acknowledgement never restarts the microphone. Ask the
      // native task to stop, then let the phone own retry/draft decisions.
      report('error',0);
      try{publish('stop',session.nonce);}catch(_){}
    },timeoutMs);
  };
  try {
    requestSubscription=event.subscribe({eventName:'bc.capture.req',callback:()=>{}});
    if(typeof requestSubscription!=='number')throw new Error('原生录音请求接口不可用');
    subscription=event.subscribe({eventName:'bc.capture.evt',callback:data=>{
      const p=data?.params;
      if(closed||!active||data?.package!==packageName||p?.v!==2||p.n!==active.nonce||
          !Number.isInteger(p.e)||p.e<0||p.e>100||!['recording','done','cancelled','error'].includes(p.op))return;
      if(p.op!=='error'&&p.e!==0)return;
      if(['cancelled','error'].includes(p.op)&&!active.quiescent){
        active.quiescent=true;try{onQuiescent(active.sessionId);}catch(_){}
      }
      if(active.terminal)return;
      if(cancelled.includes(active.sessionId)&&p.op!=='cancelled')return;
      clearTimeout(timer);report(p.op,p.e);
    }});
    if(typeof subscription!=='number')throw new Error('原生录音事件接口不可用');
  } catch(error) {
    for(const id of [requestSubscription,subscription])if(typeof id==='number')try{event.unsubscribe({id});}catch(_){}
    throw error;
  }
  return {
    control({action,sessionId}) {
      if(closed)throw new Error('Native recording controller closed');
      const nonce=recordingNonce(sessionId);
      if(!['start','stop','cancel','status'].includes(action))throw new Error('Invalid recording action');
      if(action==='cancel'){
        if(!cancelled.includes(sessionId))cancelled.push(sessionId);
        if(cancelled.length>16)cancelled.shift();
      } else if(action==='start'&&cancelled.includes(sessionId))return;
      if(!active||active.sessionId!==sessionId) {
        if(action==='stop'||action==='cancel'){
          publish(action,nonce);return;
        }
        clearTimeout(timer);active={sessionId,nonce,phase:'preparing',signature:'',terminal:false};
      }
      if(action==='cancel'){
        clearTimeout(timer);active.terminal=true;active.phase='cancelled';publish(action,nonce);return;
      }
      if(action==='status'){active.terminal=false;active.signature='';}
      arm();
      try{publish(action,nonce);}catch(error){clearTimeout(timer);report('error',0);throw error;}
    },
    destroy() {
      if(closed)return;
      closed=true;clearTimeout(timer);
      // Save a partial recording when the JS page is destroyed. The phone
      // can recover the completed file through one status query on reopening.
      if(active&&['preparing','recording'].includes(active.phase))try{publish('stop',active.nonce);}catch(_){}
      for(const id of [requestSubscription,subscription])if(typeof id==='number')try{event.unsubscribe({id});}catch(_){}
    }
  };
}
