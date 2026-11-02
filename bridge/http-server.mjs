import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import {basename} from 'node:path';

export function createAstroServer(relay, token) {
  return createServer(async (req, res) => {
    const reply = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    if (req.headers.origin) return reply(403, { error: 'Browser origins are not accepted' });
    const supplied = Buffer.from(req.headers.authorization || ''), expected = Buffer.from('Bearer ' + token);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return reply(401, { error: 'Unauthorized' });
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/status') {
        await relay.shell?.expire();
        relay.expireNativeRecovery();
        relay.expireFileUpload();
        relay.expireFileProbe();
        relay.expireNativeProbe();
        relay.expireNativeLoaderReport();
        const s = relay.recording.state;
        const lastSeenAgoMs = relay.lastSeen ? Date.now() - relay.lastSeen : null;
        const activeRequests=[...relay.requests.values()].filter(r=>!r.settled).map(r=>({method:r.method}));
        const busy=activeRequests.length>0 || ['preparing','recording','receiving','transcribing'].includes(s.phase) ||
          relay.fileDeliveries.active() || !!relay.shell?.list().some(j=>!['complete','failed','unknown'].includes(j.phase)) || [relay.fileUpload,relay.nativeAudioCheck,relay.nativeRecovery,relay.fileProbe,relay.nativeProbe]
            .some(job=>job?.phase==='pending');
        return reply(200, { service: 'band-codex', version: '0.4.3', protocolVersion: 1, connected: !!relay.connected && lastSeenAgoMs !== null && lastSeenAgoMs < 15000, lastSeenAgoMs,
          busy,
          lastBandRpcAgoMs: relay.lastBandRpcAt ? Date.now()-relay.lastBandRpcAt : null,
          queuedEvents: relay.events.length, recording: { phase: s.phase, ...(s.error ? { error: s.error } : {}),
            ...(s.audio ? { audio: s.audio } : {}), textChars: s.text?.length || 0 },
          lifecycle: relay.lifecycle ? { phase: relay.lifecycle.phase, view: relay.lifecycle.view, recordingPhase: relay.lifecycle.recordingPhase,instanceId:relay.lifecycle.instanceId||'' } : null,
          recordingViewShown: !!relay.recordingViewShown && relay.recordingViewShown.sessionId === s.id,
          nativeOnly: !!relay.nativeOnly,
          nativeManagement:relay.nativeManagement===true,
          shellJobs:relay.shell?.list()||[],
          codex: relay.service.client?.snapshot?.() || null,
          nativeAudioCheck: relay.nativeAudioCheck || null,
          nativeRecovery: relay.nativeRecovery || null,
          nativeLoaderReport: relay.nativeLoaderReport || null,
          nativeProbe: relay.nativeProbe ? {id:relay.nativeProbe.id, phase:relay.nativeProbe.phase,
            stage:relay.nativeProbe.stage, nativeTx:relay.nativeProbe.nativeTx, nativeRx:relay.nativeProbe.nativeRx,
            nativeCapture:false, ...(relay.nativeProbe.error ? {error:relay.nativeProbe.error} : {})} : null,
          fileProbe: relay.fileProbe ? { id: relay.fileProbe.id, phase: relay.fileProbe.phase,
            stage: relay.fileProbe.stage || 'queued',
            size: relay.fileProbe.size, fileReadWrite: !!relay.fileProbe.fileReadWrite,
            uploadChunkBytes: relay.fileProbe.uploadChunkBytes, receivedChunkBytes:relay.fileProbe.receivedChunkBytes,
            uploadChunkBytesVerified:relay.fileProbe.uploadChunkBytesVerified===true,
            receivedBytes: relay.fileProbe.receivedBytes || 0, eventLoopback: !!relay.fileProbe.eventLoopback,
            ...(relay.fileProbe.error ? { error: relay.fileProbe.error } : {}) } : null,
          requests: [...relay.requests.values()].slice(-12).map(r => ({ method: r.method, settled: r.settled, failed: !!r.failed })),
          activeRequests,
          nextEvent: relay.events[0] ? { kind: relay.events[0].kind, command: relay.events[0].data.bc_command || relay.events[0].data.action,
            bytes: Buffer.byteLength(JSON.stringify(relay.events[0].data)) } : null,
          diagnostics: relay.diagnostics || [] });
      }
      if (req.method === 'GET' && url.pathname === '/events') {
        await relay.shell?.expire();return reply(200, relay.poll(Number(url.searchParams.get('cursor')), url.searchParams.get('epoch') ?? undefined));
      }
      if(req.method==='GET'&&url.pathname==='/shell/status') {
        await relay.shell?.expire();const id=url.searchParams.get('id');
        const result=id?relay.shell?.snapshot(id):relay.shell?.list();
        return reply(result?200:404,result||{error:'Unknown shell request'});
      }
      if(req.method==='GET'&&url.pathname==='/shell/output') {
        if(!relay.shell)throw new Error('Native shell is unavailable');
        const output=await relay.shell.output(url.searchParams.get('id'));
        return reply(200,{base64:output.toString('base64'),bytes:output.length});
      }
      if (req.method === 'GET' && url.pathname === '/files/status') {
        const result=relay.fileDeliveries.snapshot(url.searchParams.get('id'));
        return reply(result?200:404,result||{error:'Unknown file delivery'});
      }
      if(req.method==='GET'&&url.pathname==='/files/receive/status'){
        const result=relay.fileUploadStatus(url.searchParams.get('id'));
        return reply(result?200:404,result||{error:'Unknown file upload'});
      }
      if (req.method !== 'POST') return reply(404, { error: 'Not found' });
      const audio = /^\/audio\/([a-zA-Z0-9-]{36})$/.exec(url.pathname);
      let bytes = 0; const chunks = [], limit = audio || url.pathname==='/files/send' ? 1024 * 1024 : 32768;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > limit) return reply(413, { error: 'Too large' }); chunks.push(chunk); }
      const data = Buffer.concat(chunks);
      if (audio) { await relay.recording.ingest(audio[1], data); return reply(202, { accepted: true }); }
      if (url.pathname==='/files/send') return reply(202,relay.startFileDelivery(data,decodeURIComponent(req.headers['x-file-name']||'payload.bin'),Number(req.headers['x-chunk-bytes']||128)));
      const body = JSON.parse(data.toString('utf8'));
      if(url.pathname==='/shell') {
        if(!relay.shell)throw new Error('Native shell is unavailable');
        return reply(202,await relay.shell.start(body.command,{timeoutMs:body.timeoutMs??3000,outputLimit:body.outputLimit??8192}));
      }
      if(url.pathname==='/shell/reconcile')return reply(202,await relay.shell.reconcile(body.id));
      if(url.pathname==='/shell/close-unknown'){
        if(body.confirm!=='preserve-unknown')throw new Error('Explicit unknown-result acknowledgement required');
        return reply(200,await relay.shell.acknowledgeUnknown(body.id,body.reason));
      }
      if(url.pathname==='/files/receive') {
        if(body.shellOwner!==undefined) {
          const job=relay.shell?.snapshot(body.shellOwner);
          const names=['bc-nsh-shell-v1.service','bc-shell-'+body.shellOwner+'.intent',
            'bc-shell-'+body.shellOwner+'.status','bc-shell-'+body.shellOwner+'.out','bc-file-'+body.shellOwner+'.bin',
            'bc-shell-'+body.shellOwner+'.mgmt',
            // Existing read-only reboot evidence. An unknown exec still blocks
            // every new command; observing boot files never publishes exec.
            'bc-daily-v1-uptime.txt','bc-daily-v1-modules.txt','bc-daily-v1-report.txt',
            'bc-shell-selftest-v1.status','bc-installcheck-index-refresh-report.txt',
            'bc-installcheck-index-refresh-launch.log'];
          if(job?.phase!=='unknown'||!names.includes(body.name))throw new Error('Shell inspection is limited to the unknown request and service state');
        }
        return reply(202,relay.startFileUpload(body.name,body.chunkBytes??1024,undefined,body.shellOwner));
      }
      if (url.pathname === '/files/probe') return reply(202, relay.startFileProbe(body.size ?? 1024,body.uploadChunkBytes??128));
      if (url.pathname === '/native/probe') return reply(202, relay.startNativeProbe(body.receiveOnly===true));
      if (url.pathname === '/native/audio/check') return reply(202,relay.startNativeAudioCheck());
      if(url.pathname==='/native/service')return reply(202,relay.startNativeRecovery());
      if(url.pathname==='/native/service/report'){
        relay.expireNativeRecovery();const job=relay.nativeRecovery;
        if(!job||body.id!==job.id||job.phase!=='pending')return reply(200,{accepted:false});
        if(!['complete','error'].includes(body.phase)||typeof body.message!=='string'||body.message.length>120)throw new Error('Invalid recovery report');
        job.phase=body.phase;job.message=body.message;job.finishedAt=Date.now();return reply(200,{accepted:true});
      }
      if (url.pathname === '/native/report') return reply(202, relay.requestNativeLoaderReport());
      if (url.pathname === '/rpc') return reply(200, await relay.rpc(body));
      if (url.pathname === '/restore') return reply(200, { restored: relay.restoreRecording() });
      // Bounded read-only navigation for phone-side recovery and verification.
      // This preserves the phone draft and cannot submit a prompt or record.
      if (url.pathname === '/navigate') {
        if(body.view==='conversation'){
          relay.service.requireThread({threadId:body.threadId});
          await relay.service.client.connect();
          const {thread}=await relay.service.client.request('thread/read',{threadId:body.threadId});
          if(typeof thread.cwd!=='string'||!thread.cwd)throw new Error('Thread project is missing');
          relay.enqueue('band',{bc_command:'probeConversation',project:{path:thread.cwd,name:basename(thread.cwd)},
            thread:{id:thread.id,title:(thread.name||'当前对话').slice(0,160)}});
          return reply(202,{accepted:true});
        }
        if (!['projects','recordings'].includes(body.view)) throw new Error('Unsupported navigation target');
        relay.enqueue('band', { bc_command: body.view === 'projects' ? 'probeProjects' : 'recordingManager' });
        return reply(202, { accepted: true });
      }
      if (url.pathname === '/ready') { relay.connected = !!body.connected;relay.nativeManagement=body.connected===true&&body.nativeManagement===true; relay.lastSeen = Date.now(); return reply(200, { ready: true }); }
      if (url.pathname === '/recording') { await relay.recording.telemetry(body); return reply(200, { accepted: true }); }
      if (url.pathname === '/diagnostic') {
        if (['projects','messages','draft-shown','recording-manager','recorder'].includes(body.kind) || /^rpk-0\.\d{1,2}\.\d{1,4}$/.test(body.kind || '')) {
          relay.diagnostics ||= [];
          relay.diagnostics.push({ kind: body.kind, count: Number.isSafeInteger(body.count) ? body.count : 0, at: Date.now() });
          if (body.kind === 'recorder') {
            const entry = relay.diagnostics.at(-1);
            for (const key of ['stage','event','error']) if (typeof body[key] === 'string') entry[key] = body[key].slice(0,100);
            for (const key of ['state','packet','files','matches','bytes','current','total']) if (Number.isSafeInteger(body[key])) entry[key] = body[key];
          }
          relay.diagnostics = relay.diagnostics.slice(-40);
        }
        return reply(200, { accepted: true });
      }
      // Only lifecycle flags, never microphone content, auth tokens or conversation text.
      if (url.pathname === '/lifecycle') {
        if (['show','hide','ready'].includes(body.phase)) {
          relay.lifecycle = { phase: body.phase, view: String(body.view || '').slice(0, 20),
            recordingPhase: String(body.recordingPhase || '').slice(0, 20), sessionId: String(body.sessionId || '').slice(0, 36),
            instanceId:/^[0-9]+-[a-f0-9]{1,4}$/.test(body.instanceId||'')?body.instanceId:'',at: Date.now() };
          if (body.phase === 'show' && body.view === 'recording' && body.sessionId === relay.recording.state.id)
            relay.recordingViewShown = { sessionId: body.sessionId, at: Date.now() };
          // A normal exit/reopen after an RPK update creates a fresh home page.
          // Restore its protected draft from this lifecycle event, without
          // requiring another phone action or starting capture.
          if (body.phase !== 'hide' && body.view === 'home') relay.restoreRecording();
        }
        return reply(200, { accepted: true });
      }
      return reply(404, { error: 'Not found' });
    } catch (error) { reply(400, { error: error.message }); }
  });
}

