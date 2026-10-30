/**
 * Remote Support Server — registry, presence, session + WebRTC signalling relay.
 * Run: PROVIDER_KEY=change-me PORT=8080 node server.js
 * Storage: clients.json next to this file (created automatically).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.PORT || '8080', 10);
const PROVIDER_KEY = process.env.PROVIDER_KEY || 'provider-secret-change-me';
const DATA_FILE = path.join(__dirname, 'clients.json');

function loadClients() {
  try { return new Map(Object.entries(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')))); }
  catch { return new Map(); }
}
function saveClients() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(Object.fromEntries(clients), null, 2));
}
const clients = loadClients(); // id -> {id,name,phone,token,claimed,createdAt}
const liveClients = new Map(); // id -> ws
const providers = new Set();   // ws
const sessions = new Map();    // sessionId -> {id, clientId, providerWs, clientWs, state}

function clientView(c) {
  return { id: c.id, name: c.name, phone: c.phone, online: liveClients.has(c.id), claimed: !!c.claimed };
}
function broadcastPresence() {
  const list = [...clients.values()].map(clientView);
  const msg = JSON.stringify({ type: 'clients', clients: list });
  for (const p of providers) if (p.readyState === 1) p.send(msg);
}
function json(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) });
  res.end(b);
}
function authProvider(req) { return (req.headers['x-provider-key'] || '') === PROVIDER_KEY; }

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') return json(res, 200, { ok: true, clients: clients.size, online: liveClients.size, sessions: sessions.size });
  if (url.pathname === '/api/clients' && req.method === 'GET') {
    if (!authProvider(req)) return json(res, 401, { error: 'bad provider key' });
    return json(res, 200, { clients: [...clients.values()].map(clientView) });
  }
  if (url.pathname === '/api/clients' && req.method === 'POST') {
    if (!authProvider(req)) return json(res, 401, { error: 'bad provider key' });
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { id, name, phone } = JSON.parse(body || '{}');
        if (!id || !name) return json(res, 400, { error: 'id and name required' });
        if (clients.has(String(id))) return json(res, 409, { error: 'id exists' });
        const c = { id: String(id), name: String(name), phone: String(phone || ''), token: crypto.randomBytes(16).toString('hex'), claimed: false, createdAt: new Date().toISOString() };
        clients.set(c.id, c); saveClients(); broadcastPresence();
        return json(res, 201, { client: clientView(c) });
      } catch (e) { return json(res, 400, { error: 'bad json' }); }
    });
    return;
  }
  if (url.pathname === '/api/register' && req.method === 'POST') {
    // Public self-registration (v2): a brand-new client phone claims the next
    // free numeric ID with zero typing. Creates the exact same record shape as
    // POST /api/clients (server-generated token, claimed=false); the returned
    // token is what the app stores permanently and presents on WS register.
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      let maxExisting = 0;
      for (const id of clients.keys()) {
        const n = Number(id);
        if (Number.isInteger(n) && n > maxExisting) maxExisting = n;
      }
      let next = Math.max(1000, maxExisting) + 1;
      while (clients.has(String(next))) next++;
      const c = { id: String(next), name: 'নতুন ফোন', phone: '', token: crypto.randomBytes(16).toString('hex'), claimed: false, createdAt: new Date().toISOString() };
      clients.set(c.id, c); saveClients(); broadcastPresence();
      return json(res, 201, { id: c.id, token: c.token, name: c.name });
    });
    return;
  }
  if (url.pathname.startsWith('/api/clients/') && req.method === 'DELETE') {
    if (!authProvider(req)) return json(res, 401, { error: 'bad provider key' });
    const id = decodeURIComponent(url.pathname.split('/')[3]);
    clients.delete(id); saveClients(); broadcastPresence();
    return json(res, 200, { ok: true });
  }
  if (url.pathname.startsWith('/api/clients/') && req.method === 'PUT') {
    // Rename/update (v2): provider edits name/phone of an existing client
    // (e.g. an auto-registered phone). Never touches id/token/claimed.
    if (!authProvider(req)) return json(res, 401, { error: 'bad provider key' });
    const id = decodeURIComponent(url.pathname.split('/')[3]);
    const c = clients.get(id);
    if (!c) return json(res, 404, { error: 'unknown client id' });
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { name, phone } = JSON.parse(body || '{}');
        if (typeof name === 'string' && name.trim()) c.name = name.trim();
        if (typeof phone === 'string' && phone.trim()) c.phone = phone.trim();
        saveClients(); broadcastPresence();
        return json(res, 200, { client: clientView(c) });
      } catch (e) { return json(res, 400, { error: 'bad json' }); }
    });
    return;
  }
  json(res, 404, { error: 'not found' });
});

const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  ws.role = null;
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    const send = (o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };

    if (m.type === 'register') {
      if (m.role === 'provider') {
        if (m.providerKey !== PROVIDER_KEY) return send({ type: 'error', error: 'bad provider key' });
        ws.role = 'provider'; providers.add(ws);
        send({ type: 'registered', role: 'provider' });
        send({ type: 'clients', clients: [...clients.values()].map(clientView) });
        return;
      }
      if (m.role === 'client') {
        const c = clients.get(String(m.clientId || ''));
        if (!c) return send({ type: 'error', error: 'unknown client id' });
        // First claim: no token yet on file presented -> bind presented-or-issued token.
        // Client stores the returned token permanently and presents it afterwards.
        if (!c.claimed) {
          c.claimed = true; saveClients();
          ws.role = 'client'; ws.clientId = c.id; liveClients.set(c.id, ws);
          send({ type: 'registered', role: 'client', clientId: c.id, token: c.token, name: c.name });
          broadcastPresence(); return;
        }
        if (m.token !== c.token) return send({ type: 'error', error: 'bad token' });
        ws.role = 'client'; ws.clientId = c.id; liveClients.set(c.id, ws);
        send({ type: 'registered', role: 'client', clientId: c.id, name: c.name });
        broadcastPresence(); return;
      }
      return send({ type: 'error', error: 'bad role' });
    }

    // Everything below requires registration.
    if (!ws.role) return send({ type: 'error', error: 'not registered' });

    if (m.type === 'help_request' && ws.role === 'client') {
      for (const p of providers) if (p.readyState === 1) p.send(JSON.stringify({ type: 'help_request', clientId: ws.clientId }));
      return;
    }

    if (m.type === 'request_session' && ws.role === 'provider') {
      const cws = liveClients.get(String(m.clientId));
      if (!cws || cws.readyState !== 1) return send({ type: 'error', error: 'client offline' });
      const sid = crypto.randomBytes(8).toString('hex');
      sessions.set(sid, { id: sid, clientId: String(m.clientId), providerWs: ws, clientWs: cws, state: 'active', mode: m.mode || 1 });
      // Mode 1 is pre-authorized at setup: client auto-accepts (tone + mic indicator).
      cws.send(JSON.stringify({ type: 'session_started', sessionId: sid, mode: m.mode || 1 }));
      send({ type: 'session_started', sessionId: sid, clientId: String(m.clientId), mode: m.mode || 1 });
      return;
    }

    if (m.type === 'signal' || m.type === 'screenshot' || m.type === 'gesture' || m.type === 'session_control') {
      const s = sessions.get(m.sessionId);
      if (!s) return send({ type: 'error', error: 'no such session' });
      const peer = (ws === s.providerWs) ? s.clientWs : s.providerWs;
      // Only session members may relay.
      if (ws !== s.providerWs && ws !== s.clientWs) return;
      if (m.type === 'gesture' && ws !== s.providerWs) return;
      if (m.type === 'screenshot' && ws !== s.clientWs) return;
      if (peer.readyState === 1) peer.send(JSON.stringify(m));
      return;
    }

    if (m.type === 'end_session') {
      const s = sessions.get(m.sessionId);
      if (s) {
        for (const p of [s.providerWs, s.clientWs]) if (p && p !== ws && p.readyState === 1) p.send(JSON.stringify({ type: 'session_ended', sessionId: s.id }));
        sessions.delete(m.sessionId);
      }
      return;
    }
  });
  ws.on('close', () => {
    providers.delete(ws);
    if (ws.role === 'client' && ws.clientId && liveClients.get(ws.clientId) === ws) {
      liveClients.delete(ws.clientId);
      for (const [sid, s] of sessions) if (s.clientId === ws.clientId) {
        if (s.providerWs.readyState === 1) s.providerWs.send(JSON.stringify({ type: 'session_ended', sessionId: sid, reason: 'client_disconnected' }));
        sessions.delete(sid);
      }
      broadcastPresence();
    }
  });
});

server.listen(PORT, () => console.log(`remote-support server on :${PORT} (provider key ${PROVIDER_KEY === 'provider-secret-change-me' ? 'DEFAULT - set PROVIDER_KEY!' : 'set'})`));
