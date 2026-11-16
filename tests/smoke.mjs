// Deadline – Schnelltest (läuft vor jedem Push und automatisch auf GitHub)
// Startet das Spiel in einem Browser ohne Bildschirm, spielt alle Karten kurz an, prüft die Hauptquest der
// Goldenen Maske und eine Koop-Runde (Host + Gast über ?netloop). Ausgabe: kurze Zusammenfassung, Exit-Code 1 bei Fehlern.
// Aufruf: node tests/smoke.mjs   (optional THREE_DIR=… für eine lokale Kopie von three@0.160.0)
import { createRequire } from 'module';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let chromium;
for (const base of [ROOT, '/opt/node-tools/node_modules/']) { try { ({chromium} = createRequire(path.join(base, 'x.js'))('playwright')); break; } catch (e) {} }
if (!chromium) { console.error('Playwright fehlt (npm i playwright)'); process.exit(2); }
const THREE_DIR = process.env.THREE_DIR || path.join(ROOT, 'node_modules', 'three');
if (!fs.existsSync(path.join(THREE_DIR, 'build', 'three.module.js'))) { console.error('three@0.160.0 fehlt (npm i three@0.160.0) oder THREE_DIR setzen'); process.exit(2); }

// --- kleiner Webserver: Spiel + Test-Haken (window.EV) + three lokal statt CDN ---
const TYPES = {'.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript', '.json':'application/json', '.png':'image/png', '.mp3':'audio/mpeg', '.svg':'image/svg+xml', '.css':'text/css'};
const srv = http.createServer((rq, rs) => {
  let u = decodeURIComponent(rq.url.split('?')[0]); if (u === '/') u = '/index.html';
  let f = u.startsWith('/three/') ? path.join(THREE_DIR, u.slice(7)) : path.join(ROOT, u);
  if (!f.startsWith(ROOT) && !f.startsWith(THREE_DIR)) { rs.writeHead(403); return rs.end(); }
  fs.readFile(f, (e, d) => {
    if (e) { rs.writeHead(404); return rs.end(); }
    if (u === '/index.html') { let s = d.toString('utf8').replaceAll('https://cdn.jsdelivr.net/npm/three@0.160.0/', '/three/'); const i = s.lastIndexOf('</script>'); s = s.slice(0, i) + '\nwindow.EV = c => eval(c);\n' + s.slice(i); d = Buffer.from(s); }
    rs.writeHead(200, {'Content-Type':TYPES[path.extname(f)] || 'application/octet-stream'}); rs.end(d);
  });
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const URL0 = `http://127.0.0.1:${srv.address().port}/`;

const W = ms => new Promise(r => setTimeout(r, ms));
const results = [], errs = [];
const ok = (name, cond, info = '') => { results.push([!!cond, name, info]); console.log(`${cond ? '✓' : '✗'} ${name}${info ? ' – ' + info : ''}`); };
const browser = await chromium.launch({args:['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required']});
const ctx = await browser.newContext({viewport:{width:800, height:480}});
const open = async (q, tag) => {
  const p = await ctx.newPage(); p.on('pageerror', e => errs.push(`${tag}: ${e.message} ${(e.stack || '').split('\n')[1] || ''}`.trim()));
  await p.goto(URL0 + q, {waitUntil:'domcontentloaded', timeout:240000}); await p.waitForFunction(() => window.EV, null, {timeout:240000});
  return {p, E:c => p.evaluate(c => window.EV(c), c)};
};
const sim = (E, sec) => E(`(() => { const n = Math.round(${sec}/.05); for (let i = 0; i < n; i++) update(.05); return 1; })()`);
const startMap = async ({p, E}, id) => {
  await E(`selMap = '${id}'; $('startBtn').click(); 1`); await W(2500);
  for (let i = 0; i < 8 && (await E('state')) !== 'playing'; i++) { await p.keyboard.press('Enter'); await W(1500); }
  return E('state');
};

try {
  // ---------- Einzelspieler: alle Karten ----------
  const S = await open('', 'SP'); await W(1500); await S.p.mouse.click(400, 240); await W(800);
  ok('Hauptmenü lädt', await S.E(`state === 'menu' && !!$('startBtn')`), 'Version ' + await S.E('GAME_VER'));
  const wbad = await S.E(`ORDER.filter(k => !WEAPONS[k] || !models[k] || (!WEAPONS[k].melee && WEAPONS[k].mag && SIGHTS[k] && !SIGHTS[k].iron)).join(', ')`);
  ok('Alle Waffen haben Werte, Modell und Visier', !wbad, wbad);
  for (const id of await S.E('Object.keys(MAPS)')) {
    const st = await startMap(S, id);
    await S.E('C.god = true; breakT = .1; 1'); await sim(S.E, 25);
    const r = JSON.parse(await S.E(`JSON.stringify({w:wave, z:zombies.length, k:kills, box:BOX_SPOTS.length, mq:!!MQO, ped:!MQO || !MQO.ped || !MQO.ped.col || MQO.ped.col.minX > 9000})`));
    await S.E('for (const z of [...zombies]) damageZombie(z, 1e9, z.g.position.clone().setY(1)); 1'); await sim(S.E, 2);
    ok(`Karte ${id}`, st === 'playing' && r.w >= 1 && (r.z > 0 || r.k > 0) && r.box === 6 && r.mq && r.ped, `Welle ${r.w}, ${r.z} Zombies, ${r.box} Box-Plätze${r.ped ? '' : ', UNSICHTBARER SOCKEL-BLOCK'}`);
    if (id === 'theater') {
      await S.E('for (const D of DOORS) if (!D.open) thOpenDoor(D, 0, true); 1'); await sim(S.E, 6);
      const stuck = await S.E('zombies.filter(z => z.win < 0 && !thOpenAt(z.g.position.x, z.g.position.z, 0)).length');
      ok('Goldene Maske: alle Türen offen, keine Zombies im Abseits', stuck === 0, `${stuck} außerhalb`);
      // Platzierungen: nichts (Box-Plätze, Box-Karten, Perks, Stände, Tresor, Spielautomat, Deko) steht vor Türen, Fenstern, Treppen oder Bögen
      const block = await S.E(`(() => { const Z = [], F = [], out = [];
        for (const D of DOORS) { const hw = D.w/2 + .9; Z.push(D.ax === 'x' ? {n:'Tür ' + D.name, a:D.x - hw, b:D.x + hw, c:D.z - 2.6, d:D.z + 2.6, y:D.y} : {n:'Tür ' + D.name, a:D.x - 2.6, b:D.x + 2.6, c:D.z - hw, d:D.z + hw, y:D.y}); }
        for (const w of WINS) if (!w.hatch) Z.push({n:'Fenster ' + w.i, a:w.inP.x - 1.3, b:w.inP.x + 1.3, c:w.inP.z - 1.3, d:w.inP.z + 1.3, y:w.y});
        for (const r of RAMPS) { const L = 1.6; if (r.ax === 'x') Z.push({n:'Treppe', a:r.minX - L, b:r.minX, c:r.minZ, d:r.maxZ}, {n:'Treppe', a:r.maxX, b:r.maxX + L, c:r.minZ, d:r.maxZ}); else Z.push({n:'Treppe', a:r.minX, b:r.maxX, c:r.minZ - L, d:r.minZ}, {n:'Treppe', a:r.minX, b:r.maxX, c:r.maxZ, d:r.maxZ + L}); }
        for (const z of [4, 22]) Z.push({n:'Bogen', a:-22.6, b:-17.4, c:z - 2.9, d:z + 2.9, y:0});
        const fp = (x, z, ry, w, d, n) => { const c = Math.abs(Math.cos(ry)), sn = Math.abs(Math.sin(ry)), hx = (w*c + d*sn)/2, hz = (w*sn + d*c)/2; F.push({n, a:x - hx, b:x + hx, c:z - hz, d:z + hz}); };
        (curMap.boxSpots || []).forEach(([x, z, ry], i) => { fp(x, z, ry, 2.6, 1.4, 'Box-Platz ' + i); const c = Math.cos(ry), sn = Math.sin(ry); fp(x + 2.05*c - .35*sn, z - 2.05*sn - .35*c, ry, .9, .5, 'Box-Karte ' + i); });
        for (const [k, v] of Object.entries(curMap.perkAt || {})) fp(v[0], v[1], v[2], 1.3, 1.1, 'Perk ' + k);
        (curMap.marketSpots || []).forEach(([x, z, ry], i) => fp(x, z, ry || 0, 3.6, 2.2, 'Stand ' + i));
        if (curMap.vaultAt) fp(curMap.vaultAt[0], curMap.vaultAt[1], curMap.vaultAt[2], 1.6, 1.2, 'Tresor'); if (curMap.slotAt) fp(curMap.slotAt[0], curMap.slotAt[1], curMap.slotAt[2] || 0, 1.4, 1.2, 'Spielautomat');
        for (const o of obstacles) { if (o.h >= 50 || o.fl) continue; const w = o.maxX - o.minX, d = o.maxZ - o.minZ; if (Math.min(w, d) <= .45 && Math.max(w, d) <= 2) continue; F.push({n:'Hindernis ' + ((o.minX + o.maxX)/2).toFixed(1) + '/' + ((o.minZ + o.maxZ)/2).toFixed(1), a:o.minX, b:o.maxX, c:o.minZ, d:o.maxZ, o}); }
        for (const f of F) for (const z of Z) if (f.b > z.a && f.a < z.b && f.d > z.c && f.c < z.d && (z.y === undefined || Math.abs(gyAt((f.a + f.b)/2, (f.c + f.d)/2) - z.y) < 1)) out.push(z.n + ' ← ' + f.n);
        return [...new Set(out)].join(', '); })()`);
      ok('Goldene Maske: nichts blockiert Türen, Fenster, Treppen oder Bögen', !block, block);
      await S.E(`mqAdmin('mqboss'); 1`); await sim(S.E, 8);
      const qb = await S.E(`!!zombies.find(z => z.bossKind === 'qb_theater')`);
      await S.E(`mqAdmin('mqwin'); 1`); await sim(S.E, 1);
      ok('Goldene Maske: Quest-Boss erscheint und Quest lässt sich abschließen', qb && await S.E('MQS.done'));
    }
    await S.E(`state = 'over'; showMenu(); 1`); await W(800);
  }
  // ---------- 4.72: Tägliche Herausforderung + Schneemann-Attacke ----------
  await S.E(`openMapSel(); 1`); await W(500);
  const I = JSON.parse(await S.E('JSON.stringify(dailyInfo(dayKey()))'));
  await S.E(`$('dailyGo').click(); 1`); await W(3000);
  for (let i = 0; i < 6 && (await S.E('state')) !== 'playing'; i++) { await S.p.keyboard.press('Enter'); await W(1500); }
  const dr = JSON.parse(await S.E(`JSON.stringify({on:DAILY.on, map:curMap.id, own:!!owned[DAILY.I.w], cust:lbCustom()})`));
  ok('Tägliche Herausforderung startet (Karte, Tageswaffe, Regeln zählen für die Rangliste)', dr.on && dr.map === I.map && dr.own && !dr.cust, `${I.map}, ${I.w}, ${I.mods.join('/')}`);
  await S.E(`C.god = true; SPR.force = 'snow'; breakT = .1; 1`); await sim(S.E, 8);
  const sn = await S.E(`zombies.filter(z => z.type === 'snowman').length`);
  await S.E('for (const z of [...zombies]) damageZombie(z, 1e9, z.g.position.clone().setY(1)); 1'); await sim(S.E, 3);
  ok('Spezialrunde: Schneemann-Attacke mit 50 Schneemännern, danach Pause', sn === 50 && await S.E(`waveState === 'break' && !SPR.cur`), `${sn} Schneemänner`);
  await S.E(`state = 'over'; showMenu(); 1`); await W(500);
  ok('Nach der Herausforderung sind die Spielregeln wieder Standard', await S.E(`!DAILY.on && Object.keys(CFG_DEF).every(k => cfg[k] === CFG_DEF[k])`));
  await S.p.close();

  // ---------- Koop: Host + Gast ----------
  const H = await open('?netloop', 'Host');
  await H.E(`openCoop(); $('coopName').value = 'Host'; netHost(); 1`); await W(1500); const code = await H.E('NET.code');
  const G = await open('?netloop', 'Gast');
  await G.E(`openCoop(); $('coopName').value = 'Gast'; $('coopCode').value = '${code}'; netJoin(); 1`); await W(5000);
  ok('Koop: Gast tritt der Lobby bei', await H.E('NET.pl.size') === 1);
  await H.E(`netStart('theater'); 1`); await W(10000);
  ok('Koop: beide im Spiel', await H.E('state') === 'playing' && await G.E('state') === 'playing');
  await H.E('C.god = true; breakT = .1; 1'); await G.E('C.god = true; 1');
  for (let i = 0; i < 10; i++) { await sim(H.E, 1.5); await W(300); }
  await W(1500);
  const hz = await H.E('zombies.length'), gz = await G.E('zombies.length');
  ok('Koop: Gast sieht die Zombies des Hosts', hz > 0 && gz > 0, `Host ${hz}, Gast ${gz}`);
  await G.E('score = 5000; thBuyDoor(DOORS[0]); 1'); await W(3000);
  const gs = await G.E('score');
  ok('Koop: Gast kauft eine Tür – Host öffnet sie für alle, nur der Gast zahlt', await H.E('DOORS[0].open') && await G.E('DOORS[0].open') && gs === 5000 - await G.E('DOORS[0].cost'), `Gast-Geld ${gs}`);
  await H.E(`SPR.force = 'run'; netSend({t:'wfx', k:'spf', y:'run'}); for (const z of [...zombies]) damageZombie(z, 1e9, z.g.position.clone().setY(1)); toSpawn = 0; 1`);
  for (let i = 0; i < 6; i++) { await sim(H.E, 1); await W(300); }
  await H.E('breakT = .1; 1'); for (let i = 0; i < 4; i++) { await sim(H.E, 1); await W(400); }
  ok('Koop: Spezialrunde läuft auch beim Gast', await H.E(`SPR.cur`) === 'run' && await G.E(`SPR.cur`) === 'run');
} catch (e) { ok('Testlauf ohne Absturz', false, e.message.split('\n')[0]); }

await browser.close(); srv.close();
ok('Keine Skriptfehler im Spiel', errs.length === 0, errs.length ? errs.slice(0, 5).join(' | ') : '');
const bad = results.filter(r => !r[0]).length;
console.log(bad ? `\n${bad} von ${results.length} Prüfungen FEHLGESCHLAGEN` : `\nAlle ${results.length} Prüfungen bestanden`);
process.exit(bad ? 1 : 0);
