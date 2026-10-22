import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { COLLECT_COMMAND, parseSnapshot } from './collector.js';

const OUTPUT_LIMIT = 65536;
const HISTORY_LIMIT = 30;
const contexts = new AsyncLocalStorage();

function append(record, key, chunk) {
  const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
  const remaining = OUTPUT_LIMIT - Buffer.byteLength(record[key]);
  if (Buffer.byteLength(text) > remaining) record.truncated = true;
  if (remaining > 0) record[key] += Buffer.from(text).subarray(0, remaining).toString('utf8');
}

function redact(text) {
  return String(text).replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[private key redacted]').replace(/((?:password|passwd|token|secret|api[_-]?key|authorization)\s*[:=]\s*)[^\s]+/gi, '$1[redacted]');
}

export function createMonitor(sshOps) {
  if (typeof sshOps?.resolveConnection !== 'function' || typeof sshOps?.runPreparedExec !== 'function' || typeof sshOps?.collectExecOutput !== 'function') throw new Error('需要兼容的 dsh-ssh-ops 0.4.1 服务');
  let disposed = false;
  const records = [];
  const cleanups = new Set();
  const pending = new Map();
  const samples = new Map();
  const originalRun = sshOps.runPreparedExec;
  const originalCollect = sshOps.collectExecOutput;
  const assertOpen = () => { if (disposed) throw new Error('监控已卸载'); };
  function select(id) {
    assertOpen();
    if (typeof id !== 'string' || !id.trim() || id.length > 200) throw new Error('必须指定 connection_id');
    const selected = sshOps.resolveConnection(id);
    if (!selected.ok || selected.connectionId !== id) throw new Error('所选 SSH 连接不存在');
    return selected.connection;
  }
  function trustError(conn) {
    if (!conn || conn.dead || conn.closing || conn.connecting || !conn.client) return 'SSH 连接离线；不会自动连接或重放';
    if (conn.hostKeyMode !== 'verify') return '请先在 SSH Ops 验证主机指纹并以 verify 模式重新连接';
    // shortcut: 0.4.1 does not expose a verified-session attestation; fail closed if live verifier evidence is unavailable.
    // ssh2 does not retain hostVerifier on client.config; verify mode + a recorded fingerprint + no mismatch is the available attestation.
    if (!sshOps.knownHosts?.get?.(conn.host, conn.port)?.fingerprint || conn.hostKeyMismatch) return '无法确认当前 SSH 传输已验证主机指纹，拒绝采集';
    if (conn.proxyJump?.length || conn.hops?.length) return '首版无法证明跳板链均已验证，拒绝采集';
    return null;
  }
  function observe(stream, record) {
    let finished = false;
    const stdout = chunk => append(record, 'stdout', chunk);
    const stderr = chunk => append(record, 'stderr', chunk);
    const finish = (code, signal, error) => {
      if (finished) return; finished = true;
      record.running = false; record.exitCode = Number.isInteger(code) ? code : null; record.signal = signal || null;
      if (error) record.error = String(error.message || error).slice(0, 1000);
      record.finishedAt = Date.now(); record.durationMs = record.finishedAt - record.startedAt;
      cleanup();
    };
    const close = (code, signal) => finish(code, signal);
    const error = value => finish(null, null, value);
    const cleanup = () => { stream.removeListener('data', stdout); stream.stderr?.removeListener('data', stderr); stream.removeListener('close', close); stream.removeListener('error', error); cleanups.delete(detach); };
    const detach = () => { record.running = false; record.error = '观察已卸载；原命令继续由 SSH Ops 管理'; cleanup(); };
    stream.on('data', stdout); stream.stderr?.on('data', stderr); stream.once('close', close); stream.once('error', error); cleanups.add(detach);
    return () => finish(null, null);
  }
  function wrappedRun(connectionId, prepared, displayCommand, ...rest) {
    return contexts.run({ owner: sshOps, connectionId, command: String(displayCommand).slice(0, 8192) }, () => originalRun.call(this, connectionId, prepared, displayCommand, ...rest));
  }
  function wrappedCollect(client, command, ...rest) {
    const context = contexts.getStore();
    if (disposed || context?.owner !== sshOps) return originalCollect.call(this, client, command, ...rest);
    const originalExec = client.exec;
    const finishObservers = [];
    function observedExec(...args) {
      const callbackIndex = args.length - 1;
      const callback = args[callbackIndex];
      if (typeof callback !== 'function') return originalExec.apply(this, args);
      const record = { id:randomUUID(), connectionId:context.connectionId, command:context.command, startedAt:Date.now(), running:true, stdout:'', stderr:'', exitCode:null, truncated:false };
      records.push(record);
      while (records.length > HISTORY_LIMIT) records.shift();
      args[callbackIndex] = function(error, stream) {
        // Observation must never turn a successful original SSH call into a failure.
        try { if (error) {record.running=false;record.error=String(error.message || error).slice(0,1000);} else if (!disposed && stream) finishObservers.push(observe(stream, record)); } catch {}
        return callback.apply(this, arguments);
      };
      try { return originalExec.apply(this, args); } catch (error) { record.running=false; record.error=String(error.message || error).slice(0,1000); throw error; }
    }
    client.exec = observedExec;
    try { return Promise.resolve(originalCollect.call(this, client, command, ...rest)).finally(() => { for (const finish of finishObservers) finish(); }); }
    finally { if (client.exec === observedExec) client.exec = originalExec; }
  }
  sshOps.runPreparedExec = wrappedRun;
  sshOps.collectExecOutput = wrappedCollect;

  function collect(conn) {
    const client=conn.client;
    return new Promise((resolve, reject) => {
      let stream; let done=false;
      const result={stdout:'',stderr:'',truncated:false};
      const finish=(error, code) => {
        if(done) return; done=true; clearTimeout(timer); cleanups.delete(stop);
        stream?.removeListener('data', out); stream?.stderr?.removeListener('data', err); stream?.removeListener('close', close); stream?.removeListener('error', fail); client.removeListener?.('close', offline);
        if(error) reject(error); else if(code !== 0 || result.truncated) reject(new Error('采集失败或输出超限')); else resolve(parseSnapshot(result.stdout));
      };
      const close=code => { try { finish(null, code); } catch(error) { reject(error); } };
      const fail=error => finish(error);
      const out=chunk => append(result,'stdout',chunk);
      const err=chunk => append(result,'stderr',chunk);
      const offline=() => finish(new Error('SSH 已断开；采集不会重放'));
      const stop=() => { finish(new Error('采集已取消或超时')); try {stream?.close();} catch {} };
      const timer=setTimeout(stop,5000); cleanups.add(stop); client.once?.('close',offline);
      try { client.exec(COLLECT_COMMAND,{pty:false},(error,channel) => {
        if(done) { try {channel?.close();} catch {} return; }
        if(error) return finish(error);
        stream=channel; stream.on('data',out); stream.stderr?.on('data',err); stream.once('close',close); stream.once('error',fail);
      }); } catch(error) {finish(error);}
    });
  }
  return {
    list() { assertOpen(); return [...(sshOps.connections?.entries?.() || [])].map(([connectionId,conn]) => ({connectionId,name:conn.name || conn.host,host:conn.host,port:conn.port,username:conn.username,available:!trustError(conn),reason:trustError(conn)})); },
    async getSnapshot(id) {
      const conn=select(id); const problem=trustError(conn); if(problem) throw new Error(problem);
      if(pending.has(id)) return pending.get(id);
      const previous=samples.get(id); if(previous && previous.client===conn.client && Date.now()-previous.at<3000) return previous.value;
      const samplingClient=conn.client;
      const operation=collect(conn).then(value => {
        if(disposed || conn.dead || conn.closing || conn.client!==samplingClient || sshOps.connections.get(id)!==conn) throw new Error('采集期间连接已变化');
        const elapsed=previous && previous.client===conn.client ? value.cpuTicks-previous.value.cpuTicks : 0;
        value.cpuPercent=elapsed>0 ? Math.max(0,Math.min(100,100*(1-(value.idleTicks-previous.value.idleTicks)/elapsed))) : null;
        const seconds=previous && previous.client===conn.client ? (Date.now()-previous.at)/1000 : 0;
        value.network.rxBytesPerSecond=seconds>0 && value.network.rxBytes>=previous.value.network.rxBytes ? (value.network.rxBytes-previous.value.network.rxBytes)/seconds : null;
        value.network.txBytesPerSecond=seconds>0 && value.network.txBytes>=previous.value.network.txBytes ? (value.network.txBytes-previous.value.network.txBytes)/seconds : null;
        value.connectionId=id; value.sampledAt=Date.now(); samples.set(id,{client:conn.client,at:value.sampledAt,value}); return value;
      }).finally(()=>pending.delete(id));
      pending.set(id,operation); return operation;
    },
    getActivity(id) { select(id); return records.filter(record=>record.connectionId===id).map(record=>({...record,command:redact(record.command),stdout:redact(record.stdout),stderr:redact(record.stderr),error:record.error ? redact(record.error) : undefined,durationMs:record.running ? Date.now()-record.startedAt : record.durationMs})); },
    dispose() {
      if(disposed) return; disposed=true;
      if(sshOps.runPreparedExec===wrappedRun) sshOps.runPreparedExec=originalRun;
      if(sshOps.collectExecOutput===wrappedCollect) sshOps.collectExecOutput=originalCollect;
      for(const cleanup of [...cleanups]) cleanup();
      records.length=0; samples.clear();
    }
  };
}
