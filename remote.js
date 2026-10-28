// Phone control over the local network. Plain HTTP + Server-Sent Events, no
// framework: phones POST commands, and get every state snapshot back over an
// SSE stream. The control window stays the single owner of state — this
// module only relays commands in and snapshots out.

const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');

const BASE_PORT = 4747;
const PORT_ATTEMPTS = 10;
const MAX_BODY = 64 * 1024;
const MAX_PIN_FAILURES = 5;
const LOCKOUT_MS = 30000;
const HEARTBEAT_MS = 15000;

// Whitelist only — nothing else in the app directory is ever served.
const STATIC_FILES = {
  '/': ['remote.html', 'text/html; charset=utf-8'],
  '/remote.css': ['remote.css', 'text/css; charset=utf-8'],
  '/remote-client.js': ['remote-client.js', 'text/javascript; charset=utf-8'],
  '/shared.js': ['shared.js', 'text/javascript; charset=utf-8']
};

const COMMANDS = new Set([
  'toggle', 'reset', 'nudge', 'setDuration', 'setMode',
  'next', 'previous', 'jump', 'editProgram', 'message', 'clearMessage'
]);

let server = null;
let info = null;            // { url, pin, qrDataUrl } while running
let tokens = new Set();
let clients = new Set();    // open SSE responses
let latestState = null;
let heartbeat = null;
const failures = new Map(); // ip -> { count, lockedUntil }

let onCommand = () => {};
let onStatus = () => {};

function init(handlers) {
  onCommand = handlers.onCommand || onCommand;
  onStatus = handlers.onStatus || onStatus;
}

// First real IPv4 on the machine — skips loopback and self-assigned
// (169.254.x.x) addresses, which a phone could never reach.
function lanAddress() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) return a.address;
    }
  }
  return null;
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function snapshot() {
  return `data: ${JSON.stringify({ state: latestState, serverNow: Date.now() })}\n\n`;
}

function reportStatus() {
  onStatus(clients.size);
}

function serveStatic(req, res) {
  const entry = STATIC_FILES[req.url.split('?')[0]];
  if (!entry) return false;
  fs.readFile(path.join(__dirname, entry[0]), (err, data) => {
    if (err) {
      res.writeHead(500);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': entry[1], 'Cache-Control': 'no-cache' });
    res.end(data);
  });
  return true;
}

async function handleAuth(req, res) {
  const ip = req.socket.remoteAddress;
  const record = failures.get(ip) || { count: 0, lockedUntil: 0 };
  if (record.lockedUntil > Date.now()) {
    sendJson(res, 429, { error: 'Too many wrong PINs — wait 30 seconds.' });
    return;
  }
  let body;
  try {
    body = await readJson(req);
  } catch {
    sendJson(res, 400, { error: 'Bad request' });
    return;
  }
  if (!info || String(body.pin || '') !== info.pin) {
    record.count += 1;
    if (record.count >= MAX_PIN_FAILURES) {
      record.count = 0;
      record.lockedUntil = Date.now() + LOCKOUT_MS;
    }
    failures.set(ip, record);
    sendJson(res, 401, { error: 'Wrong PIN' });
    return;
  }
  failures.delete(ip);
  const token = crypto.randomBytes(16).toString('hex');
  tokens.add(token);
  sendJson(res, 200, { token });
}

function handleEvents(req, res) {
  const token = new URL(req.url, 'http://x').searchParams.get('token');
  if (!tokens.has(token)) {
    res.writeHead(401);
    res.end();
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.write('retry: 2000\n\n');
  if (latestState) res.write(snapshot());
  clients.add(res);
  reportStatus();
  req.on('close', () => {
    clients.delete(res);
    reportStatus();
  });
}

async function handleCommand(req, res) {
  if (!tokens.has(req.headers['x-remote-token'])) {
    sendJson(res, 401, { error: 'Not signed in' });
    return;
  }
  let cmd;
  try {
    cmd = await readJson(req);
  } catch {
    sendJson(res, 400, { error: 'Bad request' });
    return;
  }
  if (!cmd || !COMMANDS.has(cmd.type)) {
    sendJson(res, 400, { error: 'Unknown command' });
    return;
  }
  onCommand(cmd);
  res.writeHead(204);
  res.end();
}

function handleRequest(req, res) {
  const url = req.url.split('?')[0];
  if (req.method === 'GET' && serveStatic(req, res)) return;
  if (req.method === 'POST' && url === '/api/auth') return handleAuth(req, res);
  if (req.method === 'GET' && url === '/api/events') return handleEvents(req, res);
  if (req.method === 'POST' && url === '/api/command') return handleCommand(req, res);
  res.writeHead(404);
  res.end();
}

function listenOn(srv, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      srv.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      srv.off('error', onError);
      resolve(port);
    };
    srv.once('error', onError);
    srv.once('listening', onListening);
    srv.listen(port, '0.0.0.0');
  });
}

async function start() {
  if (info) return info;
  const address = lanAddress();
  if (!address) throw new Error('Not connected to a network.');

  const srv = http.createServer(handleRequest);
  let port = null;
  for (let p = BASE_PORT; p < BASE_PORT + PORT_ATTEMPTS && port === null; p++) {
    try {
      port = await listenOn(srv, p);
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
    }
  }
  if (port === null) throw new Error('No free port for phone control.');

  server = srv;
  tokens = new Set();
  failures.clear();
  const url = `http://${address}:${port}`;
  const pin = String(crypto.randomInt(0, 10000)).padStart(4, '0');
  const qrDataUrl = await QRCode.toDataURL(url, { margin: 1, width: 320 });
  info = { url, pin, qrDataUrl };
  heartbeat = setInterval(() => {
    clients.forEach((res) => res.write(': ping\n\n'));
  }, HEARTBEAT_MS);
  return info;
}

function stop() {
  if (!server) return;
  clearInterval(heartbeat);
  heartbeat = null;
  // Tell phones explicitly, so they show "turned off" instead of retrying.
  clients.forEach((res) => {
    res.write('event: closed\ndata: {}\n\n');
    res.end();
  });
  clients.clear();
  tokens.clear();
  server.closeAllConnections();
  server.close();
  server = null;
  info = null;
  reportStatus();
}

function broadcast(state) {
  latestState = state;
  if (!clients.size) return;
  const msg = snapshot();
  clients.forEach((res) => res.write(msg));
}

module.exports = { init, start, stop, broadcast };
