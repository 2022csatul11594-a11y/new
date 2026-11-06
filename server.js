'use strict';
// Kubeship test application: a small web app and API with no dependencies.
// It exists to exercise what Kubeship shows: health, logs, metrics, CPU and memory use, restarts, env vars, storage.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.PORT || 8080);
const VERSION = process.env.APP_VERSION || '1.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(os.tmpdir(), 'kubeship-test-app');
const STARTED = Date.now();
const POD = process.env.HOSTNAME || os.hostname();

// ---------------------------------------------------------------- logging (one JSON line per event)
const log = (level, msg, extra = {}) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), level, msg, pod: POD, ...extra }));

// ---------------------------------------------------------------- metrics (Prometheus text format)
const counters = { requests: 0, errors: 0, todosCreated: 0 };
const byRoute = new Map();
const latency = { sum: 0, count: 0 };
const held = []; // memory held by /api/load/memory

// ---------------------------------------------------------------- storage: a to-do list, saved to a file when it can be
let todos = [];
let nextId = 1;
const FILE = path.join(DATA_DIR, 'todos.json');
let persisted = false;
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(FILE)) {
    const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    todos = saved.todos || [];
    nextId = saved.nextId || todos.length + 1;
  }
  fs.accessSync(DATA_DIR, fs.constants.W_OK);
  persisted = true;
} catch (e) {
  log('warn', 'storage is not writable; the to-do list will be lost on restart', { dir: DATA_DIR, error: String(e.message) });
}
const save = () => {
  if (!persisted) return;
  try { fs.writeFileSync(FILE, JSON.stringify({ todos, nextId })); } catch (e) { log('error', 'could not save', { error: String(e.message) }); }
};

// ---------------------------------------------------------------- helpers
const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};
const readJson = (req) =>
  new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 100_000) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('invalid JSON')); } });
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (n, lo, hi, d) => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d);

// Burns CPU for `seconds` without blocking the server for long: 50 ms of work, then yield.
function burnCpu(seconds) {
  const end = Date.now() + seconds * 1000;
  const tick = () => {
    const stop = Date.now() + 50;
    let x = 0;
    while (Date.now() < stop) x += Math.sqrt(Math.random() * 1e6);
    if (Date.now() < end) setImmediate(tick); else log('info', 'cpu load finished', { seconds });
  };
  tick();
}

// index.html may sit in ./public or next to this file; either works.
const PAGE = [path.join(__dirname, 'public', 'index.html'), path.join(__dirname, 'index.html')].find((f) => fs.existsSync(f));
const html = () => (PAGE ? fs.readFileSync(PAGE, 'utf8') : '<!doctype html><title>Kubeship test app</title><h1>It works 🚀</h1><p>index.html was not found, but the API is running.</p>');

// ---------------------------------------------------------------- routes
const routes = {
  'GET /': (req, res) => send(res, 200, html(), 'text/html; charset=utf-8'),
  'GET /health': (req, res) => send(res, 200, 'ok', 'text/plain'),
  'GET /ready': (req, res) => send(res, 200, { ready: true }),

  'GET /api/info': (req, res) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('PUBLIC_') || k === 'APP_VERSION' || k === 'PORT'));
    send(res, 200, {
      app: 'kubeship-test-app', version: VERSION, pod: POD, node: process.version, port: PORT,
      uptimeSeconds: Math.round((Date.now() - STARTED) / 1000),
      memoryMb: Math.round(process.memoryUsage().rss / 1048576), heldMb: held.length,
      cpus: os.cpus().length, loadAvg: os.loadavg().map((n) => Number(n.toFixed(2))),
      storage: { dir: DATA_DIR, persisted },
      publicEnv: env, secretsHidden: Object.keys(process.env).filter((k) => !k.startsWith('PUBLIC_')).length,
    });
  },

  'GET /api/todos': (req, res) => send(res, 200, todos),
  'POST /api/todos': async (req, res) => {
    const body = await readJson(req);
    const text = String(body.text || '').trim().slice(0, 200);
    if (!text) return send(res, 400, { error: 'text is required' });
    const todo = { id: nextId++, text, done: false, createdAt: new Date().toISOString() };
    todos.push(todo); counters.todosCreated++; save();
    log('info', 'todo created', { id: todo.id });
    send(res, 201, todo);
  },

  'GET /api/slow': async (req, res, url) => {
    const ms = clamp(Number(url.searchParams.get('ms')), 0, 15000, 2000);
    await sleep(ms);
    send(res, 200, { sleptMs: ms });
  },
  'GET /api/error': (req, res) => { log('error', 'deliberate error requested'); send(res, 500, { error: 'deliberate error' }); },
  'GET /api/crash': (req, res) => {
    log('error', 'crash requested: exiting in 500 ms');
    send(res, 200, { crashing: true });
    setTimeout(() => process.exit(1), 500);
  },
  'GET /api/log': (req, res, url) => {
    const level = ['info', 'warn', 'error'].includes(url.searchParams.get('level')) ? url.searchParams.get('level') : 'info';
    const msg = String(url.searchParams.get('msg') || 'hello from the test app').slice(0, 200);
    log(level, msg, { source: 'api/log' });
    send(res, 200, { logged: level, msg });
  },
  'GET /api/load/cpu': (req, res, url) => {
    const seconds = clamp(Number(url.searchParams.get('seconds')), 1, 120, 20);
    log('info', 'cpu load started', { seconds });
    burnCpu(seconds);
    send(res, 200, { cpuLoadSeconds: seconds });
  },
  'GET /api/load/memory': (req, res, url) => {
    const mb = clamp(Number(url.searchParams.get('mb')), 1, 300, 50);
    for (let i = 0; i < mb; i++) held.push(Buffer.alloc(1048576, 1));
    log('info', 'memory held', { addedMb: mb, totalMb: held.length });
    send(res, 200, { heldMb: held.length });
  },
  'GET /api/load/release': (req, res) => {
    const was = held.length; held.length = 0; if (global.gc) global.gc();
    log('info', 'memory released', { releasedMb: was });
    send(res, 200, { releasedMb: was });
  },

  'GET /metrics': (req, res) => {
    const mem = process.memoryUsage();
    const lines = [
      '# TYPE app_http_requests_total counter', `app_http_requests_total ${counters.requests}`,
      '# TYPE app_http_errors_total counter', `app_http_errors_total ${counters.errors}`,
      '# TYPE app_todos_created_total counter', `app_todos_created_total ${counters.todosCreated}`,
      '# TYPE app_todos gauge', `app_todos ${todos.length}`,
      '# TYPE app_uptime_seconds gauge', `app_uptime_seconds ${Math.round((Date.now() - STARTED) / 1000)}`,
      '# TYPE app_memory_rss_bytes gauge', `app_memory_rss_bytes ${mem.rss}`,
      '# TYPE app_held_memory_bytes gauge', `app_held_memory_bytes ${held.length * 1048576}`,
      '# TYPE app_request_seconds_sum counter', `app_request_seconds_sum ${latency.sum.toFixed(4)}`,
      '# TYPE app_request_seconds_count counter', `app_request_seconds_count ${latency.count}`,
      ...[...byRoute].map(([r, n]) => `app_route_requests_total{route="${r}"} ${n}`),
    ];
    send(res, 200, lines.join('\n') + '\n', 'text/plain; version=0.0.4');
  },
};

// /api/todos/:id  (PATCH toggles or edits, DELETE removes)
async function todoById(req, res, id) {
  const i = todos.findIndex((t) => t.id === id);
  if (i < 0) return send(res, 404, { error: 'not found' });
  if (req.method === 'DELETE') { todos.splice(i, 1); save(); return send(res, 200, { deleted: id }); }
  if (req.method === 'PATCH') {
    const b = await readJson(req);
    if (typeof b.done === 'boolean') todos[i].done = b.done;
    if (typeof b.text === 'string' && b.text.trim()) todos[i].text = b.text.trim().slice(0, 200);
    save();
    return send(res, 200, todos[i]);
  }
  return send(res, 405, { error: 'method not allowed' });
}

const server = http.createServer(async (req, res) => {
  const t0 = process.hrtime.bigint();
  const url = new URL(req.url, 'http://x');
  const key = `${req.method} ${url.pathname}`;
  const route = /^\/api\/todos\/\d+$/.test(url.pathname) ? 'todo-by-id' : routes[key] ? url.pathname : 'other';
  res.on('finish', () => {
    const sec = Number(process.hrtime.bigint() - t0) / 1e9;
    counters.requests++; latency.sum += sec; latency.count++;
    if (res.statusCode >= 500) counters.errors++;
    byRoute.set(route, (byRoute.get(route) || 0) + 1);
    if (url.pathname !== '/health' && url.pathname !== '/ready' && url.pathname !== '/metrics')
      log(res.statusCode >= 500 ? 'error' : 'info', 'request', { method: req.method, path: url.pathname, status: res.statusCode, ms: Math.round(sec * 1000) });
  });
  try {
    const m = /^\/api\/todos\/(\d+)$/.exec(url.pathname);
    if (m) return await todoById(req, res, Number(m[1]));
    const handler = routes[key];
    if (!handler) return send(res, 404, { error: 'not found', path: url.pathname });
    await handler(req, res, url);
  } catch (e) {
    log('error', 'unhandled', { error: String(e.message) });
    if (!res.headersSent) send(res, e.message === 'invalid JSON' || e.message === 'body too large' ? 400 : 500, { error: String(e.message) });
  }
});

server.listen(PORT, '0.0.0.0', () => log('info', 'listening', { port: PORT, version: VERSION, storage: persisted ? DATA_DIR : 'memory only' }));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { log('info', `${sig} received, shutting down`); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000); });
