/**
 * Filotto — server per il gioco online.
 *
 * Fa due cose:
 *  1. serve i file statici dell'app (la cartella principale del progetto), così un solo
 *     deploy basta sia per giocare che per l'online;
 *  2. espone un relay WebSocket con stanze a codice: l'host crea una stanza, l'ospite entra
 *     con il codice e da lì in poi il server si limita a inoltrare i messaggi tra i due.
 *     Tutta la logica di gioco resta nel client dell'host.
 *
 * Avvio: `npm install && npm start` dentro la cartella server/ (porta da env PORT, default 8080).
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.PORT, 10) || 8080;
const ROOT = path.resolve(__dirname, '..');
const ROOM_TTL_MS = 30 * 60 * 1000;      // stanza in attesa dell'ospite: scade dopo 30 minuti
const HEARTBEAT_MS = 30 * 1000;
const MAX_MESSAGE_BYTES = 64 * 1024;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // niente I/O/0/1: si confondono

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
};

/* ---------- File statici ---------- */
function serveStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, rooms: rooms.size })); return; }
  if (urlPath.endsWith('/')) urlPath += 'index.html';
  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT) || filePath.startsWith(path.join(ROOT, 'server')) || filePath.includes(`${path.sep}.git`)) {
    res.writeHead(404); res.end('Not found'); return;
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': ext === '.html' || ext === '.js' ? 'no-cache' : 'public, max-age=3600'
    });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(filePath).pipe(res);
  });
}

/* ---------- Stanze ---------- */
const rooms = new Map(); // code -> { code, host, guest, hostName, createdAt }

function makeCode() {
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    if (!rooms.has(code)) return code;
  }
  return null;
}

function send(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch (e) { /* ignora */ }
  }
}

function cleanName(name) {
  return String(name || '').replace(/[\x00-\x1f<>]/g, '').trim().slice(0, 16) || 'Giocatore';
}

function leaveRoom(ws, notifyPeer) {
  const room = ws.room;
  if (!room) return;
  ws.room = null;
  const peer = room.host === ws ? room.guest : room.host;
  rooms.delete(room.code);
  if (peer) {
    peer.room = null;
    if (notifyPeer) send(peer, { t: 'peer_left' });
  }
}

function handleMessage(ws, msg) {
  switch (msg.t) {
    case 'create': {
      leaveRoom(ws, true);
      const code = makeCode();
      if (!code) { send(ws, { t: 'error', message: 'Troppe stanze aperte, riprova tra poco.' }); return; }
      const room = { code, host: ws, guest: null, hostName: cleanName(msg.name), createdAt: Date.now() };
      rooms.set(code, room);
      ws.room = room;
      send(ws, { t: 'created', code });
      break;
    }
    case 'join': {
      const code = String(msg.code || '').toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) { send(ws, { t: 'error', message: 'Stanza non trovata: controlla il codice.' }); return; }
      if (room.guest) { send(ws, { t: 'error', message: 'La stanza è già piena.' }); return; }
      if (room.host === ws) { send(ws, { t: 'error', message: 'Non puoi entrare nella tua stessa stanza.' }); return; }
      leaveRoom(ws, true);
      const guestName = cleanName(msg.name);
      room.guest = ws;
      ws.room = room;
      send(ws, { t: 'joined', code, peerName: room.hostName });
      send(room.host, { t: 'peer_joined', peerName: guestName });
      break;
    }
    case 'relay': {
      const room = ws.room;
      if (!room || msg.d === undefined) return;
      const peer = room.host === ws ? room.guest : room.host;
      send(peer, { t: 'relay', d: msg.d });
      break;
    }
    case 'leave':
      leaveRoom(ws, true);
      break;
    case 'ping':
      send(ws, { t: 'pong' });
      break;
    default:
      break;
  }
}

/* ---------- Avvio ---------- */
const server = http.createServer(serveStatic);
const wss = new WebSocketServer({ server, maxPayload: MAX_MESSAGE_BYTES });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.room = null;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    if (msg && typeof msg === 'object' && typeof msg.t === 'string') handleMessage(ws, msg);
  });
  ws.on('close', () => leaveRoom(ws, true));
  ws.on('error', () => leaveRoom(ws, true));
});

const heartbeat = setInterval(() => {
  const now = Date.now();
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) { leaveRoom(ws, true); ws.terminate(); return; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) { /* ignora */ }
  });
  for (const room of rooms.values()) {
    if (!room.guest && now - room.createdAt > ROOM_TTL_MS) {
      send(room.host, { t: 'error', message: 'Stanza scaduta: creane una nuova.' });
      leaveRoom(room.host, false);
    }
  }
}, HEARTBEAT_MS);
heartbeat.unref();

server.listen(PORT, () => {
  console.log(`Filotto in ascolto su http://localhost:${PORT} (relay WebSocket sulla stessa porta)`);
});
