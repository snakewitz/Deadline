# Deadline – Projektregeln

Browser-Zombie-Wellen-Shooter in einer einzigen Datei (`index.html`, Three.js r160, PeerJS inline).
Live über GitHub Pages: https://snakewitz.github.io/Deadline/ (Push auf `main` = Update für alle Spieler).

## Feste Regeln (vom Besitzer gewünscht)

1. **Jedes neue Feature und jede Änderung muss auch im Koop-Multiplayer funktionieren** (bis zu 4 Spieler).
   Für jede neue Aktion klären: Sehen die anderen Spieler sie? Wer ist zuständig (Host oder jeder selbst)?
   Gibt es Sperren (z. B. Mystery Box, Schmiede)? Doppelter Schaden ausgeschlossen?
2. Hauptmenü: Liste `MM_NEWS` (Hauptmenü „NEU IN DER BETA“, zufällig gemischt) bei größeren Neuerungen ergänzen – sachlich formulieren, keine privaten Infos; Tastenbelegung (`#ctrlPanel`) bei neuen Tasten ergänzen.
2b. Benutzeroberfläche auf **Deutsch**, gute Laptop-Performance, poliertes Aussehen, keine fremden geschützten Inhalte.
3. Jede Version: `<title>` („Deadline Beta X.Y“), `<div class="ver">` („BETA X.Y“ – das Spiel ist bis zum späteren Full Release eine Beta) und `GAME_VER` hochzählen, Kopie als `/home/user/DeadlineX.Y.html` ablegen, committen und pushen.

## Multiplayer-Architektur (Kurzfassung)

- Stern-Netz: Gäste reden nur mit dem Host; `netHostData` setzt `m.from` und leitet Typen aus `RELAY` weiter.
  Neue Nachrichtentypen, die alle sehen sollen, in `RELAY` eintragen und in `netMsg` behandeln.
  Achtung: Nachrichtenfeld `t` ist der Typ – nie als Datenfeld verwenden.
- Host ist maßgeblich für Zombies, Wellen, Bosse und Events. Gäste haben Zombie-„Puppen“ (`z.net`) und melden Treffer per `hit`.
- Reine Effekte beim Empfänger als „Geister“ abspielen (`NET.ghostP` / `NET.ghostFx`) – sie dürfen keinen Schaden machen.
- Schaden durch Flächenangriffe läuft über `hurtAt` (Host sendet `ha`), Boss-Angriffe werden per `hz` nachgebaut.
- Geräusche anderer Spieler räumlich mit `sndAt(x, z, range, mul, fn)`.
- Verbindung: zuerst direkt (PeerJS/WebRTC); klappt das nach 5 s nicht, über den eigenen Relay-Server (`server/`, Cloudflare Worker + Durable Objects, `NET_RELAY` = wss://deadline-relay.snakewitz.workers.dev; deployen: `cd server && CLOUDFLARE_API_TOKEN=proxy-injected CLOUDFLARE_ACCOUNT_ID=4a3a3c21898f86b6274e4af1751b6400 npx wrangler deploy`).
  Relay-Verkehr wird gebündelt (max. 15 Pakete/s pro Spieler, `p`/`s` werden zusammengefasst) – wichtig fürs Gratis-Kontingent (eingehende WS-Nachrichten zählen 20:1).
  Öffentliche Lobbys kommen vom Server (`/lobbies`). Lokal testen: `cd server && npx wrangler dev`, Spiel mit `?relay=ws://127.0.0.1:8787` öffnen.
- Zombie-Snapshot `s`: Einträge `[nid, x, z, ry, sichtbar, bossAktion, bossLeben 0–1, Statusbits 1=gefroren 2=brennt 4=tanzt 8=zaubert 16=stürmt 32=getroffen, Sprunghöhe airY]`. Gast-Treffer (`hit`) tragen `fx` (Eis/Feuer/Element) – Effekte und Brennschaden rechnet nur der Host.
- Zombie-Geräusche aus der KI (`ZSND`-Liste) gehen als `zsnd` an die Gäste; `NET.zAI` ist während der Zombie-KI gesetzt.
- Beute (Munition/Rüstung/Medipack/Schrott) würfelt nur der Host (`pu`), Aufheben meldet `pc` – wer zuerst kommt, bekommt sie.
- Spielregeln: Einzelspieler-Profil (`uw_feats`/`uw_cfg`) und Koop-Lobby-Profil (`uw_feats_coop`/`uw_cfg_coop`). Der Host stellt das Lobby-Profil im KOOP-Menü ein (`editCoopRules`), es wird beim Start mit `start` (Felder `F`, `C`) an alle verteilt (`netProfileApply`) und danach zurückgesetzt (`netProfileRestore`). Grafik/HUD/Ton bleiben persönlich. Speichern immer über `saveFeats`/`saveCfg`.
- Spieler-Zustand geht über `netSendState` (`p`-Nachricht); neue sichtbare Zustände dort ergänzen und in `netAvatarOne` darstellen.

## Cheat-/Admin-Passwort

Im Code steht nur ein Fingerabdruck (`CHEAT_SALT`, `CHEAT_HASH`, 40 000-fach gestrecktes SHA-256, Funktion `pwDerive`). Neues Passwort: Hash mit derselben Funktion in Node berechnen und beide Konstanten ersetzen – das Klartext-Passwort nie committen.

## Testen

- Testseite bauen mit dem Hook aus dem Scratchpad (`mk5.py`), lokale Zwei-Fenster-Tests mit `?netloop` (BroadcastChannel statt Internet).
- Im Spiel: nach dem Cheat-Passwort (gilt nur für den aktuellen Tab, `sessionStorage`) gibt es im KOOP-Menü einen Admin-Kasten: Bot, „Testfenster als Gast“, Verbindungsweg und Server-Test. Für normale Spieler unsichtbar.
- Immer auch kurz den Einzelspieler prüfen.
