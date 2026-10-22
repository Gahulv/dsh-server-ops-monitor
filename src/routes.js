export function trusted(req, connection) {
  if (typeof connection?.requestRejection !== 'function') return false;
  try { if (connection.requestRejection(req) !== undefined) return false; } catch { return false; }
  const address = req.socket?.remoteAddress;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)) return false;
  const origin = req.headers?.origin;
  if (origin) { try { if (new URL(origin).host !== req.headers.host) return false; } catch { return false; } }
  return !req.headers?.['sec-fetch-site'] || ['same-origin', 'none'].includes(req.headers['sec-fetch-site']);
}
export function createHandler(monitor, connection) {
  return async (req, res) => {
    const send = (status, value) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(value)); };
    if (!trusted(req, connection)) return send(403, {error:'需要当前 DSH 的已认证本机连接'});
    if (req.method !== 'GET') return send(405, {error:'仅允许读取'});
    try {
      const url = new URL(req.url, 'http://localhost');
      const id = url.searchParams.get('connectionId');
      if (url.pathname.endsWith('/connections')) return send(200, {connections:monitor.list()});
      if (!id || id.length > 200) return send(400, {error:'必须选择明确的服务器连接'});
      if (url.pathname.endsWith('/snapshot')) return send(200, {snapshot:await monitor.getSnapshot(id)});
      if (url.pathname.endsWith('/activity')) return send(200, {activity:monitor.getActivity(id)});
      return send(404, {error:'接口不存在'});
    } catch (error) { return send(409, {error:String(error.message || '读取失败')}); }
  };
}
