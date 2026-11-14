// Deadline-Relay: leitet Koop-Nachrichten zwischen Host und Gästen weiter (für Netze, die direkte Verbindungen blockieren).
// Der Server rechnet nichts – die Spiellogik bleibt beim Host. Jede Lobby ist ein eigenes Durable Object.
//
//  Gast  → Server: JSON-Array von Nachrichten (gebündelt)          → an den Host als {c:<id>, d:[…]}
//  Host  → Server: {o:[[ziel, nachricht], …], i?:lobbyInfo|null}   → je Gast ein Paket {d:[…]}; ziel = Gast-ID oder '*'
//  System: {sys:'open'|'close', c} an den Host · {sys:'hostgone'|'nohost'|'full'|'taken'} an Gäste/Host

const MAX_GUESTS = 3, MAX_FRAME = 256 * 1024, LOBBY_TTL = 10 * 60 * 1000;
const CORS = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '86400', 'Cache-Control': 'no-store'};
const codeOk = c => /^[A-Z0-9]{4,8}$/.test(c);

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, {headers: CORS});
    if (url.pathname === '/' || url.pathname === '/health') return new Response('Deadline-Relay läuft', {headers: CORS});
    if (url.pathname.startsWith('/auth/') || url.pathname === '/save' || url.pathname.startsWith('/account') || url.pathname.startsWith('/name/')) return accounts(req, env, url);
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


// ================= Konten (Anmeldung mit Google) =================
// Gespeichert wird nur: Googles anonyme Konto-Nummer (sub, gehasht als Schlüssel) + Spielstand + Zeitstempel.
// Keine Passwörter, keine E-Mail-Adressen. Die E-Mail aus dem Google-Ausweis wird nur einmalig mit ADMIN_EMAIL verglichen (Secret, nicht im Code).
// Secrets (wrangler secret put): SESSION_SECRET (zufällig, signiert Sitzungen), ADMIN_EMAIL. Variable: GOOGLE_CLIENT_ID (öffentlich).
const MAX_SAVE = 400 * 1024, SESSION_DAYS = 60;
const J = (o, status = 200) => new Response(JSON.stringify(o), {status, headers: {...CORS, 'Content-Type': 'application/json'}});
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const enc = new TextEncoder();
let JWKS = null, JWKS_T = 0;
async function googleKeys() {
  if (JWKS && Date.now() - JWKS_T < 3600e3) return JWKS;
  const r = await fetch('https://www.googleapis.com/oauth2/v3/certs'); JWKS = (await r.json()).keys || []; JWKS_T = Date.now(); return JWKS;
}
async function verifyGoogle(cred, clientId) { // Google-Ausweis (ID-Token) prüfen: Signatur, Aussteller, Empfänger, Ablauf
  const [h, p, sig] = String(cred).split('.'); if (!h || !p || !sig) throw new Error('format');
  const head = JSON.parse(new TextDecoder().decode(unb64u(h))), pay = JSON.parse(new TextDecoder().decode(unb64u(p)));
  let jwk = (await googleKeys()).find(k => k.kid === head.kid); if (!jwk) { JWKS = null; jwk = (await googleKeys()).find(k => k.kid === head.kid); } if (!jwk || head.alg !== 'RS256') throw new Error('key');
  const key = await crypto.subtle.importKey('jwk', jwk, {name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256'}, false, ['verify']);
  if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, unb64u(sig), enc.encode(h + '.' + p))) throw new Error('sig');
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(pay.iss)) throw new Error('iss');
  if (pay.aud !== clientId) throw new Error('aud'); if (!pay.exp || pay.exp*1000 < Date.now() - 60e3) throw new Error('exp'); if (!pay.sub) throw new Error('sub');
  return pay;
}
async function hmac(secret, data) { const k = await crypto.subtle.importKey('raw', enc.encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']); return b64u(await crypto.subtle.sign('HMAC', k, enc.encode(data))); }
async function makeSession(env, uid, admin) { const body = b64u(enc.encode(JSON.stringify({u: uid, a: admin ? 1 : 0, e: Date.now() + SESSION_DAYS*864e5}))); return body + '.' + await hmac(env.SESSION_SECRET, body); }
async function readSession(env, req) {
  const t = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/, ''), [body, sig] = t.split('.'); if (!body || !sig) return null;
  const want = await hmac(env.SESSION_SECRET, body); if (want.length !== sig.length) return null; let d = 0; for (let i = 0; i < sig.length; i++) d |= want.charCodeAt(i) ^ sig.charCodeAt(i); if (d) return null;
  try { const o = JSON.parse(new TextDecoder().decode(unb64u(body))); return o.e > Date.now() ? o : null; } catch (e) { return null; }
}
const sha = async s => b64u(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const tooMany = new Map();   // einfache Bremse je IP (pro Server-Instanz)
async function accounts(req, env, url) {
  if (!env.GOOGLE_CLIENT_ID || !env.SESSION_SECRET) return J({err: 'not_configured'}, 503);
  const acc = uid => env.ACCOUNT.get(env.ACCOUNT.idFromName(uid));
  if (url.pathname === '/auth/google' && req.method === 'POST') {
    const ip = req.headers.get('CF-Connecting-IP') || '?', n = (tooMany.get(ip) || []).filter(t => Date.now() - t < 60e3); if (n.length > 20) return J({err: 'slow_down'}, 429); n.push(Date.now()); tooMany.set(ip, n);
    let pay; try { pay = await verifyGoogle((await req.json()).cred, env.GOOGLE_CLIENT_ID); } catch (e) { return J({err: 'bad_token'}, 401); }
    const uid = await sha('g:' + pay.sub), admin = !!(env.ADMIN_EMAIL && pay.email_verified && String(pay.email).toLowerCase() === String(env.ADMIN_EMAIL).toLowerCase());
    const info = await (await acc(uid).fetch('https://a/touch', {method: 'POST'})).json();
    return J({token: await makeSession(env, uid, admin), isNew: info.isNew, rev: info.rev, admin, name: info.name || ''});
  }
  const names = () => env.NAMES.get(env.NAMES.idFromName('names'));
  if (url.pathname === '/name/check') { const n = url.searchParams.get('n') || '', bad = nameProblem(n); if (bad) return J({ok: false, err: bad});
    const ses = await readSession(env, req);   // angemeldet: eigener Name und (für den Besitzer) reservierte Namen zählen als frei
    return J(await (await names().fetch('https://n/check?n=' + encodeURIComponent(n) + (ses ? '&uid=' + ses.u + (ses.a ? '&adm=1' : '') : ''))).json()); }
  if (url.pathname === '/name/verify' && req.method === 'POST') { // Koop: gehört der Name einem Konto? Ohne gültigen Nachweis → name_guest
    let b; try { b = await req.json(); } catch (e) { return J({err: 'bad_json'}, 400); }
    const name = String(b.name || '').slice(0, 24), key = name.toLowerCase().trim();
    if (b.proof) { const [body, sig] = String(b.proof).split('.'); if (body && sig && sig === await hmac(env.SESSION_SECRET, 'n:' + body)) { try { const o = JSON.parse(new TextDecoder().decode(unb64u(body))); if (o.e > Date.now() && o.n === key) return J({ok: true, name}); } catch (e) {} } }
    const taken = (await (await names().fetch('https://n/check?n=' + encodeURIComponent(key))).json()).err === 'taken' || /_guest$/i.test(key);
    return J(taken ? {ok: false, name: guestName(name)} : {ok: true, name});
  }
  const s = await readSession(env, req); if (!s) return J({err: 'login'}, 401);
  if (url.pathname === '/name/proof') { const info = await (await acc(s.u).fetch('https://a/info')).json(); if (!info.name) return J({err: 'no_name'}, 404);
    const body = b64u(enc.encode(JSON.stringify({n: info.name.toLowerCase(), e: Date.now() + 2*864e5}))); return J({proof: body + '.' + await hmac(env.SESSION_SECRET, 'n:' + body)}); }
  if (url.pathname === '/auth/me') { const info = await (await acc(s.u).fetch('https://a/info')).json(); return J({admin: !!s.a, rev: info.rev, exists: info.exists, name: info.name || ''}); }
  if (url.pathname === '/account/name' && req.method === 'POST') { // Nutzernamen festlegen/ändern – einmalig, Groß-/Kleinschreibung egal
    let n; try { n = String((await req.json()).name || '').trim(); } catch (e) { return J({err: 'bad_json'}, 400); }
    const bad = nameProblem(n); if (bad) return J({err: bad}, 400);
    const r = await names().fetch('https://n/claim', {method: 'POST', body: JSON.stringify({name: n, uid: s.u, adm: !!s.a})}), j = await r.json();
    if (r.status !== 200) return J(j, r.status);
    await acc(s.u).fetch('https://a/setname', {method: 'POST', body: JSON.stringify({name: n})}); return J({ok: true, name: n});
  }
  if (url.pathname === '/save' && req.method === 'GET') return new Response(await (await acc(s.u).fetch('https://a/get')).text(), {headers: {...CORS, 'Content-Type': 'application/json'}});
  if (url.pathname === '/save' && req.method === 'PUT') {
    const txt = await req.text(); if (txt.length > MAX_SAVE) return J({err: 'too_big'}, 413);
    const r = await acc(s.u).fetch('https://a/put', {method: 'POST', body: txt}); return new Response(await r.text(), {status: r.status, headers: {...CORS, 'Content-Type': 'application/json'}});
  }
  if (url.pathname === '/account' && req.method === 'DELETE') { await names().fetch('https://n/release', {method: 'POST', body: JSON.stringify({uid: s.u})}); await acc(s.u).fetch('https://a/delete', {method: 'POST'}); return J({ok: true}); }
  return J({err: 'not_found'}, 404);
}
export class Account { // ein Durable Object je Konto
  constructor(state) { this.state = state; }
  async fetch(req) {
    const p = new URL(req.url).pathname, st = this.state.storage;
    const meta = (await st.get('meta')) || null;
    if (p === '/touch') { const now = Date.now(); if (!meta) { await st.put('meta', {created: now, seen: now, rev: 0}); return J({isNew: true, rev: 0}); } meta.seen = now; await st.put('meta', meta); return J({isNew: !meta.rev, rev: meta.rev, name: meta.name || ''}); }
    if (p === '/info') return J({exists: !!meta, rev: meta ? meta.rev : 0, name: meta && meta.name || ''});
    if (p === '/setname') { const {name} = await req.json(); const m = meta || {created: Date.now(), rev: 0}; m.name = name; await st.put('meta', m); return J({ok: true}); }
    if (p === '/get') return J({rev: meta ? meta.rev : 0, save: (await st.get('save')) || null, at: meta && meta.updated || 0});
    if (p === '/put') {
      let b; try { b = JSON.parse(await req.text()); } catch (e) { return J({err: 'bad_json'}, 400); }
      if (!b || typeof b.save !== 'object' || Array.isArray(b.save)) return J({err: 'bad_save'}, 400);
      const m = meta || {created: Date.now(), rev: 0}; if ((b.base | 0) !== (m.rev | 0)) return J({err: 'conflict', rev: m.rev}, 409);
      m.rev = (m.rev | 0) + 1; m.updated = Date.now(); m.seen = m.updated; await st.put('save', b.save); await st.put('meta', m); return J({ok: true, rev: m.rev});
    }
    if (p === '/delete') { await st.deleteAll(); return J({ok: true}); }
    return J({err: 'not_found'}, 404);
  }
}

// ================= Nutzernamen (einmalig) =================
const RESERVED = [   // nur das Besitzer-Konto (Admin) darf diese Namen nehmen
  'admin', 'administrator', 'deadline', 'host', 'moderator', 'mod', 'support', 'system', 'server', 'gast', 'guest', 'snakewitz'];
const BADW = ['nazi', 'hitler', 'fick', 'fotze', 'hure', 'nigger', 'neger', 'schwuchtel', 'wichser', 'arschloch', 'hurensohn', 'fuck', 'bitch', 'cunt', 'whore', 'porn', 'sex'];
const guestName = n => String(n).replace(/_guest$/i, '').trim().slice(0, 14) + '_guest';   // max. 20 Zeichen
function nameProblem(n) {
  if (typeof n !== 'string' || n.length < 3) return 'too_short'; if (n.length > 14) return 'too_long';
  if (!/^[A-Za-z0-9ÄÖÜäöüß][A-Za-z0-9ÄÖÜäöüß_.\-]*$/.test(n)) return 'bad_chars'; if (/_guest$/i.test(n)) return 'not_allowed';
  const l = n.toLowerCase(), flat = l.replace(/[_.\-]/g, '').replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e').replace(/4/g, 'a').replace(/5/g, 's');
  if (BADW.some(w => flat.includes(w))) return 'not_allowed'; return '';
}
export class Names { // Verzeichnis: name (klein) → Konto; ein einziges Durable Object → keine Doppelvergabe
  constructor(state, env) { this.state = state; this.env = env; }
  async fetch(req) {
    const u = new URL(req.url), st = this.state.storage;
    if (u.pathname === '/check') { const n = (u.searchParams.get('n') || '').toLowerCase(), uid = u.searchParams.get('uid'), owner = await st.get('n:' + n);
      const free = (!owner || owner === uid) && (!RESERVED.includes(n) || u.searchParams.get('adm') === '1' || owner === uid); return J({ok: free, err: free ? '' : 'taken'}); }
    const b = await req.json();
    if (u.pathname === '/claim') {
      const key = b.name.toLowerCase(), owner = await st.get('n:' + key);
      if ((owner && owner !== b.uid) || (RESERVED.includes(key) && !b.adm)) return J({err: 'taken'}, 409);
      const old = await st.get('u:' + b.uid); if (old && old !== key) await st.delete('n:' + old);
      await st.put('n:' + key, b.uid); await st.put('u:' + b.uid, key); return J({ok: true});
    }
    if (u.pathname === '/release') { const old = await st.get('u:' + b.uid); if (old) { await st.delete('n:' + old); await st.delete('u:' + b.uid); } return J({ok: true}); }
    return J({err: 'not_found'}, 404);
  }
}
