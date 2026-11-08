// Deadline-Relay: leitet Koop-Nachrichten zwischen Host und Gästen weiter (für Netze, die direkte Verbindungen blockieren).
// Der Server rechnet nichts – die Spiellogik bleibt beim Host. Jede Lobby ist ein eigenes Durable Object.
//
//  Gast  → Server: JSON-Array von Nachrichten (gebündelt)          → an den Host als {c:<id>, d:[…]}
//  Host  → Server: {o:[[ziel, nachricht], …], i?:lobbyInfo|null}   → je Gast ein Paket {d:[…]}; ziel = Gast-ID oder '*'
//  System: {sys:'open'|'close', c} an den Host · {sys:'hostgone'|'nohost'|'full'|'taken'} an Gäste/Host

const MAX_GUESTS = 3, MAX_FRAME = 256 * 1024, LOBBY_TTL = 10 * 60 * 1000;
const CORS = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Cache-Control': 'no-store'};
const codeOk = c => /^[A-Z0-9]{4,8}$/.test(c);

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, {headers: CORS});
    if (url.pathname === '/' || url.pathname === '/health') return new Response('Deadline-Relay läuft', {headers: CORS});
    if (url.pathname === '/lobbies') {
      const r = await env.DIR.get(env.DIR.idFromName('dir')).fetch('https://dir/list');
      return new Response(await r.text(), {headers: {...CORS, 'Content-Type': 'application/json'}});
    }
    const m = url.pathname.match(/^\/room\/([A-Za-z0-9]+)$/);
    if (m) {
      const code = m[1].toUpperCase(); if (!codeOk(code)) return new Response('bad code', {status: 400, headers: CORS});
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('websocket expected', {status: 426, headers: CORS});
      return env.ROOM.get(env.ROOM.idFromName(code)).fetch(req);
    }
    return new Response('not found', {status: 404, headers: CORS});
  }
};

const att = ws => { try { return ws.deserializeAttachment() || {}; } catch (e) { return {}; } };
const sendJ = (ws, o) => { try { ws.send(JSON.stringify(o)); } catch (e) {} };

export class Room {
  constructor(state, env) { this.state = state; this.env = env; }
  live() { return this.state.getWebSockets().filter(w => w.readyState === 1 && !att(w).gone); }
  host() { return this.live().find(w => att(w).role === 'host'); }
  guests() { return this.live().filter(w => att(w).role === 'guest'); }

  async fetch(req) {
    const url = new URL(req.url), role = url.searchParams.get('role') === 'host' ? 'host' : 'guest';
    const code = (url.pathname.split('/')[2] || '').toUpperCase();
    const pair = new WebSocketPair(), [client, server] = Object.values(pair);
    const reject = why => { this.state.acceptWebSocket(server); server.serializeAttachment({role: 'x', gone: true}); sendJ(server, {sys: why}); try { server.close(1000, why); } catch (e) {} return new Response(null, {status: 101, webSocket: client}); };
    if (role === 'host') { if (this.host()) return reject('taken'); }
    else { if (!this.host()) return reject('nohost'); if (this.guests().length >= MAX_GUESTS) return reject('full'); }
    const cid = role === 'host' ? 'h' : 'c' + Math.random().toString(36).slice(2, 8);
    this.state.acceptWebSocket(server); server.serializeAttachment({role, cid, code});
    if (role === 'guest') sendJ(this.host(), {sys: 'open', c: cid});
    else sendJ(server, {sys: 'hosting', code});
    return new Response(null, {status: 101, webSocket: client});
  }

  async webSocketMessage(ws, msg) {
    if (typeof msg !== 'string' || msg.length > MAX_FRAME) return;
    const a = att(ws); if (a.gone) return; let data; try { data = JSON.parse(msg); } catch (e) { return; }
    if (a.role === 'host') {
      if (data && Array.isArray(data.o)) {
        const gs = this.guests(), out = new Map(gs.map(g => [att(g).cid, []]));
        for (const e of data.o) { if (!Array.isArray(e)) continue; const [t, m] = e;
          if (t === '*') for (const l of out.values()) l.push(m); else if (out.has(t)) out.get(t).push(m); }
        for (const g of gs) { const l = out.get(att(g).cid); if (l.length) sendJ(g, {d: l}); }
        if (data.x) for (const g of gs) if (data.x.includes(att(g).cid)) { g.serializeAttachment({...att(g), gone: true}); try { g.close(1000, 'kick'); } catch (e) {} }
      }
      if (data && 'i' in data) await this.dir(a.code, data.i);
    } else if (Array.isArray(data)) {
      const h = this.host(); if (h) sendJ(h, {c: a.cid, d: data});
    }
  }
  async webSocketClose(ws) { await this.gone(ws); }
  async webSocketError(ws) { await this.gone(ws); }
  async gone(ws) {
    const a = att(ws); if (a.gone && a.role !== 'host') return; ws.serializeAttachment({...a, gone: true});
    if (a.role === 'host') { for (const g of this.guests()) { sendJ(g, {sys: 'hostgone'}); try { g.close(1000, 'hostgone'); } catch (e) {} } await this.dir(a.code, null); }
    else if (a.role === 'guest') { const h = this.host(); if (h) sendJ(h, {sys: 'close', c: a.cid}); }
    try { ws.close(1000, 'bye'); } catch (e) {}
  }
  async dir(code, info) {
    if (!code) return;
    try { await this.env.DIR.get(this.env.DIR.idFromName('dir')).fetch('https://dir/set', {method: 'POST', body: JSON.stringify({code, info})}); } catch (e) {}
  }
}

export class Directory { // Liste der öffentlichen Lobbys
  constructor(state) { this.state = state; }
  async fetch(req) {
    const url = new URL(req.url);
    let L = (await this.state.storage.get('lobbies')) || {};
    const now = Date.now();
    if (url.pathname === '/set') {
      const {code, info} = await req.json();
      if (info && typeof info === 'object') L[code] = {...clean(info), code, at: now}; else delete L[code];
      for (const k in L) if (now - L[k].at > LOBBY_TTL) delete L[k];
      await this.state.storage.put('lobbies', L); return new Response('ok');
    }
    return new Response(JSON.stringify(Object.values(L).filter(l => now - l.at < LOBBY_TTL)));
  }
}
function clean(i) {
  const s = (v, n) => String(v ?? '').slice(0, n);
  return {lobby: s(i.lobby, 24), host: s(i.host, 14), col: s(i.col, 7), ver: s(i.ver, 8), n: Math.max(0, Math.min(4, i.n | 0)), max: Math.max(1, Math.min(4, i.max | 0)), open: !!i.open, st: s(i.st, 40)};
}
