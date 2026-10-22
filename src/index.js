import { createMonitor } from './host.js';
import { createHandler } from './routes.js';
export const name = 'dsh-server-ops-monitor';
export const inject = ['sshOps', 'webServer', 'connection'];
export function apply(ctx) {
  const monitor = createMonitor(ctx.sshOps);
  const handler = createHandler(monitor, ctx.connection);
  ctx.effect(() => {
    const remove = ['connections', 'snapshot', 'activity'].map(action => ctx.webServer.register({kind:'exact', path:'/api/server-ops-monitor/' + action, handler}));
    return () => { for (const dispose of remove) dispose?.(); monitor.dispose(); };
  });
}
