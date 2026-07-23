import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import os from 'os';

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' })); // base64 images are chunky

const MAGNIFIC_API_KEY = process.env.MAGNIFIC_API_KEY || '';
// Each generation type ("flow") on the page maps to a Magnific flow id here.
// New generation types just need a new entry + a new front-end page — the
// /generate and /status routes below are generic and work for any of them.
const MAGNIFIC_FLOWS = {
  ambiente: process.env.MAGNIFIC_FLOW_ID_AMBIENTE || process.env.MAGNIFIC_FLOW_ID || '',
  cor_textura: process.env.MAGNIFIC_FLOW_ID_COR_TEXTURA || '',
};
const CREDIT_COST_PER_RUN = Number(process.env.CREDIT_COST_PER_RUN) || 87;
const DEFAULT_CREDIT_LIMIT = process.env.DEFAULT_CREDIT_LIMIT === '' || process.env.DEFAULT_CREDIT_LIMIT == null
  ? null
  : Number(process.env.DEFAULT_CREDIT_LIMIT);

if (!MAGNIFIC_API_KEY) {
  console.warn('⚠️  MAGNIFIC_API_KEY não definida. Copie .env.example para .env e preencha a chave.');
}
for (const [key, id] of Object.entries(MAGNIFIC_FLOWS)) {
  if (!id) console.warn(`⚠️  Flow "${key}" sem ID configurado no .env — a geração desse tipo vai falhar.`);
}

const dataDir = path.join(process.cwd(), 'data');
fs.mkdirSync(dataDir, { recursive: true });
const creditsFile = path.join(dataDir, 'credits.json');

const logsDir = path.join(process.cwd(), 'logs');
fs.mkdirSync(logsDir, { recursive: true });
const logFile = path.join(logsDir, 'activity.log');

const libraryDir = path.join(process.cwd(), 'library');
fs.mkdirSync(libraryDir, { recursive: true });
function sanitizeIpForPath(ip) { return String(ip).replace(/[^a-zA-Z0-9.]/g, '_'); }

function logEvent(evt) {
  const entry = { ts: new Date().toISOString(), ...evt };
  fs.appendFile(logFile, JSON.stringify(entry) + '\n', () => {});
  console.log('[LOG]', entry.event, entry.ip || '');
  return entry;
}

// ── Credits store (simple JSON file — one process, low write volume) ──
function loadCredits() {
  try {
    return JSON.parse(fs.readFileSync(creditsFile, 'utf8'));
  } catch (_) {
    return {};
  }
}
function saveCredits(data) {
  fs.writeFileSync(creditsFile, JSON.stringify(data, null, 2));
}
function getIpEntry(credits, ip) {
  if (!credits[ip]) {
    credits[ip] = { limit: DEFAULT_CREDIT_LIMIT, usedCredits: 0, usedRuns: 0, firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString() };
  }
  return credits[ip];
}

function getClientIp(req) {
  let ip = req.ip || req.connection.remoteAddress || '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip;
}

// ── Magnific proxy ──
app.post('/generate', async (req, res) => {
  const ip = getClientIp(req);
  try {
    if (!MAGNIFIC_API_KEY) {
      return res.status(500).json({ ok: false, error: 'Servidor sem MAGNIFIC_API_KEY configurada.' });
    }
    const flow = req.body?.flow || 'ambiente';
    const flowId = MAGNIFIC_FLOWS[flow];
    if (!flowId) return res.status(400).json({ ok: false, error: `Flow desconhecido: ${flow}` });

    // Back-compat: the original single-flow client sent { imageDataUrl } directly.
    const inputs = req.body?.inputs || (req.body?.imageDataUrl ? { image_2: req.body.imageDataUrl } : null);
    if (!inputs) return res.status(400).json({ ok: false, error: 'Nenhuma imagem/entrada enviada.' });

    const credits = loadCredits();
    const entry = getIpEntry(credits, ip);
    if (entry.limit != null && entry.usedCredits + CREDIT_COST_PER_RUN > entry.limit) {
      logEvent({ event: 'generate_blocked', ip, usedCredits: entry.usedCredits, limit: entry.limit });
      return res.status(403).json({ ok: false, error: 'limit_reached', message: `Limite de créditos atingido para este IP (${entry.usedCredits}/${entry.limit}).`, usedCredits: entry.usedCredits, usedRuns: entry.usedRuns, limit: entry.limit, costPerRun: CREDIT_COST_PER_RUN });
    }

    const magRes = await fetch(`https://api.magnific.com/v1/ai/flows/${flowId}/run`, {
      method: 'POST',
      headers: { 'x-magnific-api-key': MAGNIFIC_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs }),
    });
    const magJson = await magRes.json().catch(() => ({}));
    if (!magRes.ok) {
      logEvent({ event: 'generate_error', ip, flow, status: magRes.status, error: magJson });
      return res.status(502).json({ ok: false, error: 'magnific_error', message: magJson.message || 'Falha ao iniciar a geração no Magnific.', detail: magJson });
    }

    // Magnific charges credits per run attempt, so count it as soon as the run starts.
    entry.usedCredits += CREDIT_COST_PER_RUN;
    entry.usedRuns += 1;
    entry.lastSeen = new Date().toISOString();
    saveCredits(credits);

    const runId = magJson.workflow_run_identifier || magJson.id || magJson.run_id || magJson.runId || magJson.uuid
      || magJson.data?.id || magJson.run?.id || magJson.result?.id;
    // TEMP DEBUG: log the raw Magnific response so we can see the real field name
    // if runId extraction ever comes up empty again. Safe to remove once confirmed stable.
    logEvent({ event: 'generate_start', ip, flow, runId, usedCredits: entry.usedCredits, limit: entry.limit, raw: runId ? undefined : magJson });
    if (!runId) {
      // The run genuinely started on Magnific's side (credits already charged above), we
      // just couldn't find its id in the response shape — check server logs/activity.log
      // for the "raw" field to see what Magnific actually sent back.
      return res.json({ ok: true, runId: null, warning: 'Geração iniciada, mas não consegui identificar o ID do run na resposta do Magnific. Confira o painel do Magnific.', usedCredits: entry.usedCredits, usedRuns: entry.usedRuns, limit: entry.limit, costPerRun: CREDIT_COST_PER_RUN });
    }
    res.json({ ok: true, runId, usedCredits: entry.usedCredits, usedRuns: entry.usedRuns, limit: entry.limit, costPerRun: CREDIT_COST_PER_RUN });
  } catch (err) {
    logEvent({ event: 'generate_error', ip, error: String(err) });
    res.status(500).json({ ok: false, error: String(err) });
  }
});

app.get('/status/:runId', async (req, res) => {
  try {
    if (!MAGNIFIC_API_KEY) return res.status(500).json({ ok: false, error: 'Servidor sem MAGNIFIC_API_KEY configurada.' });
    // Magnific's status endpoint occasionally returns a transient 502 with an empty body
    // even when the run itself is healthy — retry a couple times before surfacing an error.
    let magRes, magJson;
    for (let attempt = 0; attempt < 3; attempt++) {
      magRes = await fetch(`https://api.magnific.com/v1/ai/flows/runs/${req.params.runId}`, {
        headers: { 'x-magnific-api-key': MAGNIFIC_API_KEY },
      });
      magJson = await magRes.json().catch(() => ({}));
      if (magRes.ok) break;
      if (attempt < 2) await new Promise(r => setTimeout(r, 800));
    }
    if (!magRes.ok) {
      logEvent({ event: 'status_error', ip: getClientIp(req), runId: req.params.runId, status: magRes.status, error: magJson });
      return res.status(502).json({ ok: false, error: 'magnific_error', message: magJson.message, detail: magJson });
    }
    // Magnific wraps the actual run info inside a top-level "data" object.
    const run = magJson.data || magJson;
    res.json({ ok: true, ...run });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// Proxies a generated image through our own origin so the browser can draw it on a
// <canvas> (for client-side resize/compress on download) without hitting cross-origin
// tainting if the result CDN doesn't send permissive CORS headers.
app.get('/proxy-image', async (req, res) => {
  try {
    const target = req.query.url;
    if (!target || !/^https:\/\//i.test(target)) return res.status(400).json({ ok: false, error: 'URL inválida.' });
    const imgRes = await fetch(target);
    if (!imgRes.ok) return res.status(502).json({ ok: false, error: 'Falha ao baixar a imagem de origem.' });
    res.set('Content-Type', imgRes.headers.get('content-type') || 'image/png');
    res.set('Cache-Control', 'no-store');
    const buf = Buffer.from(await imgRes.arrayBuffer());
    res.send(buf);
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// Called by the client right after it resizes/compresses a finished generation —
// persists the already-optimized JPEG so it shows up in the logs.html library.
// Library layout: library/<ip>/<flow>/<file>.jpg — flow subfolder lets each
// generation page show only its own gallery, while logs.html can still show everything.
app.post('/save-result', (req, res) => {
  try {
    const ip = getClientIp(req);
    const { imageDataUrl, runId, width, height, flow } = req.body || {};
    if (!imageDataUrl) return res.status(400).json({ ok: false, error: 'Nenhuma imagem enviada.' });
    const flowKey = flow || 'ambiente';
    const base64 = imageDataUrl.replace(/^data:image\/\w+;base64,/, '');
    const buf = Buffer.from(base64, 'base64');
    const flowDir = path.join(libraryDir, sanitizeIpForPath(ip), sanitizeIpForPath(flowKey));
    fs.mkdirSync(flowDir, { recursive: true });
    const filename = `${Date.now()}_${String(runId || 'run').slice(0, 20)}.jpg`;
    fs.writeFileSync(path.join(flowDir, filename), buf);
    logEvent({ event: 'generate_done', ip, flow: flowKey, runId, file: filename, size: buf.length, width, height });
    res.json({ ok: true, url: `/library/${sanitizeIpForPath(ip)}/${sanitizeIpForPath(flowKey)}/${filename}` });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

function listFlowFiles(ip, flowKey) {
  const dir = path.join(libraryDir, sanitizeIpForPath(ip), sanitizeIpForPath(flowKey));
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => /\.(jpe?g|png)$/i.test(f))
    .map(f => {
      const stat = fs.statSync(path.join(dir, f));
      return { name: f, url: `/library/${sanitizeIpForPath(ip)}/${sanitizeIpForPath(flowKey)}/${f}`, size: stat.size, mtime: stat.mtimeMs, flow: flowKey };
    });
}

app.get('/library', (req, res) => {
  try {
    const ipDirs = fs.readdirSync(libraryDir, { withFileTypes: true }).filter(d => d.isDirectory());
    const groups = ipDirs.map(d => {
      const flowDirs = fs.readdirSync(path.join(libraryDir, d.name), { withFileTypes: true }).filter(f => f.isDirectory());
      const files = flowDirs.flatMap(fd => listFlowFiles(d.name, fd.name)).sort((a, b) => b.mtime - a.mtime);
      return { ip: d.name, count: files.length, files };
    }).filter(g => g.count > 0)
      .sort((a, b) => (b.files[0]?.mtime || 0) - (a.files[0]?.mtime || 0));
    res.json({ ok: true, groups });
  } catch (e) {
    res.json({ ok: true, groups: [] });
  }
});
app.get('/library/me', (req, res) => {
  try {
    const ip = getClientIp(req);
    const flowKey = req.query.flow || 'ambiente';
    const files = listFlowFiles(ip, flowKey).sort((a, b) => b.mtime - a.mtime);
    res.json({ ok: true, files });
  } catch (e) {
    res.json({ ok: true, files: [] });
  }
});
app.use('/library', express.static(libraryDir));

// ── Logs & credits admin (used by logs.html) ──
app.get('/logs', (req, res) => {
  try {
    const raw = fs.readFileSync(logFile, 'utf8').trim();
    const lines = raw ? raw.split('\n') : [];
    const limit = Math.min(Number(req.query.limit) || 300, 1000);
    const entries = lines.slice(-limit).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean).reverse();
    res.json({ ok: true, entries });
  } catch (e) {
    res.json({ ok: true, entries: [] });
  }
});

app.get('/credits/me', (req, res) => {
  const ip = getClientIp(req);
  const credits = loadCredits();
  // Read-only lookup — don't create/persist an entry just because someone visited the page.
  const entry = credits[ip] || { limit: DEFAULT_CREDIT_LIMIT, usedCredits: 0, usedRuns: 0 };
  res.json({ ok: true, ip, usedCredits: entry.usedCredits, usedRuns: entry.usedRuns, limit: entry.limit, costPerRun: CREDIT_COST_PER_RUN });
});

app.get('/credits', (req, res) => {
  const credits = loadCredits();
  const list = Object.entries(credits).map(([ip, v]) => ({ ip, ...v, costPerRun: CREDIT_COST_PER_RUN }));
  list.sort((a, b) => (b.lastSeen || '').localeCompare(a.lastSeen || ''));
  res.json({ ok: true, entries: list, costPerRun: CREDIT_COST_PER_RUN, defaultLimit: DEFAULT_CREDIT_LIMIT });
});

app.post('/credits/:ip/limit', (req, res) => {
  const { ip } = req.params;
  const { limit } = req.body || {};
  const credits = loadCredits();
  const entry = getIpEntry(credits, ip);
  entry.limit = (limit === null || limit === '' || limit === undefined) ? null : Number(limit);
  saveCredits(credits);
  logEvent({ event: 'limit_updated', ip, limit: entry.limit });
  res.json({ ok: true, entry: { ip, ...entry } });
});

app.post('/credits/:ip/reset', (req, res) => {
  const { ip } = req.params;
  const credits = loadCredits();
  const entry = getIpEntry(credits, ip);
  entry.usedCredits = 0;
  entry.usedRuns = 0;
  saveCredits(credits);
  logEvent({ event: 'credits_reset', ip });
  res.json({ ok: true, entry: { ip, ...entry } });
});

app.get(['/index.html', '/logs.html', '/catalogo.html', '/cor-textura.html', '/'], (req, res, next) => { logEvent({ event: 'visit', ip: getClientIp(req), file: req.path }); next(); });
app.use('/', express.static(process.cwd()));

function getLocalIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

const tryPorts = [Number(process.env.PORT) || 3500, 3501, 3502, 3503, 3504, 0];
let idx = 0;
function listenNext() {
  const port = tryPorts[idx++] || 0;
  const server = app.listen(port, '0.0.0.0', () => {
    const p = server.address().port;
    const ip = getLocalIp();
    console.log('Server listening on 0.0.0.0:' + p);
    console.log('Open in browser from another machine on the same network:');
    console.log(`http://${ip}:${p}/index.html`);
    console.log(`Or use this machine: http://localhost:${p}/index.html`);
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn('Port in use, trying next...');
      listenNext();
    } else {
      console.error('Server error', err);
      process.exit(1);
    }
  });
}
listenNext();
