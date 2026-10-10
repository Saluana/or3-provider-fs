import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
const local = host => typeof host === 'string' && ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host);
const blocked = () => { const error = new Error('OR3_TEST_OUTBOUND_DISABLED: real outbound network is disabled for this diagnostic'); process.stderr.write(error.stack + '\n'); throw error; };
const localRequest = input => { try { return local(new URL(typeof input === 'string' ? input : input?.url ?? input?.href).hostname); } catch { return typeof input === 'object' && input !== null && local(input.hostname ?? input.host); } };
const originalFetch = globalThis.fetch;
globalThis.fetch = (...args) => localRequest(args[0]) ? originalFetch(...args) : blocked();
for (const module of [http, https]) for (const name of ['request', 'get']) { const original = module[name]; module[name] = function (...args) { return localRequest(args[0]) ? original.apply(this, args) : blocked(); }; }
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = args[0]; const opts = Array.isArray(first) ? first[0] : first;
  if (typeof opts === 'object' && opts !== null && ((typeof opts.path === 'string' && opts.path.startsWith('/')) || local(opts.host))) return originalConnect.apply(this, args);
  if (typeof opts === 'number' && local(args[1])) return originalConnect.apply(this, args);
  return blocked();
};
tls.connect = blocked;
