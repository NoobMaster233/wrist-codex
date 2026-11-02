// Diagnostic receiver only. No native function, shell, or microphone call.
export function createNativeEventProbe({ event, nonce, onArmed, receiveOnly = false, timeoutMs = 120000 }) {
  let cancel = () => {};
  const done = new Promise((resolve, reject) => {
    if (!/^[0-9a-f]{32}$/.test(nonce || '')) { reject(new Error('Invalid native probe nonce')); return; }
    let requestId, responseId, timer, settled = false, armed = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      for (const id of [requestId, responseId]) if (typeof id === 'number') {
        try { event.unsubscribe({ id }); } catch (_) {}
      }
      if (error) reject(error); else resolve(result);
    };
    cancel = () => finish(new Error('Native event probe cancelled'));
    try {
      requestId = event.subscribe({ eventName: 'bc.capture.req', callback: () => {} });
      armed = true;
      responseId = event.subscribe({ eventName: 'bc.capture.evt', callback: data => {
        if (!armed || settled || data?.package !== 'dev.bandcodex.native' || data.params?.v !== 1) return;
        const params = data.params;
        if (params.op === 'pong' && params.n === nonce) finish(null, { nativeTx:true, nativeRx:true, nativeCapture:false });
        else if (params.op === 'ready' && params.rx === false && params.audio === false)
          finish(null, { nativeTx:true, nativeRx:false, nativeCapture:false });
      } });
      if (typeof requestId !== 'number' || typeof responseId !== 'number') throw new Error('Native event subscriptions unavailable');
      // A retained event may arrive inside subscribe(), before its numeric id
      // is assigned. Release that id now and never start a timer after settling.
      if (settled) { try { event.unsubscribe({id:responseId}); } catch (_) {} return; }
      timer = setTimeout(() => finish(new Error('原生事件检测超时')), timeoutMs);
      if (!receiveOnly) event.publish({ eventName: 'bc.capture.req', options: { params: { v:1, op:'ping', n:nonce }, permissions:['dev.bandcodex.remote'] } });
      Promise.resolve().then(onArmed).catch(error => finish(error));
    } catch (error) { finish(error); }
  });
  return { done, cancel: () => cancel() };
}
