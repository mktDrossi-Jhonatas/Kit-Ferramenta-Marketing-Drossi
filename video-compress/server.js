import express from 'express';
import multer from 'multer';
import cors from 'cors';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';

const execFileP = promisify(execFile);
const app = express();
app.use(cors());

const uploadDir = path.join(process.cwd(), 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });
const outputsDir = path.join(process.cwd(), 'outputs');
fs.mkdirSync(outputsDir, { recursive: true });
const logsDir = path.join(process.cwd(), 'logs');
fs.mkdirSync(logsDir, { recursive: true });
const logFile = path.join(logsDir, 'activity.log');

function logEvent(evt) {
  const entry = { ts: new Date().toISOString(), ...evt };
  fs.appendFile(logFile, JSON.stringify(entry) + '\n', () => {});
  console.log('[LOG]', entry.event, entry.ip || '', entry.file || '');
  return entry;
}

const storage = multer.diskStorage({ destination: uploadDir, filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/\s+/g,'_')) });
const upload = multer({ storage, limits: { fileSize: 600 * 1024 * 1024 } });

app.post('/compress', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded' });
    const originalName = req.file.originalname;
    const target_mb = Number(req.body.target_mb) || 30;
    const exact = String(req.body.exact) === 'true';
    const upload_size_mb = +(req.file.size / (1024*1024)).toFixed(2);
    logEvent({ event: 'compress_start', ip: req.ip, file: originalName, upload_size_mb, target_mb, exact });
    const inputPath = req.file.path;

    // get duration via ffprobe
    const ffprobeArgs = ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', inputPath];
    const { stdout } = await execFileP('ffprobe', ffprobeArgs);
    const duration = parseFloat(stdout) || 0;
    if (!duration || isNaN(duration)) {
      console.warn('Could not get duration, defaulting to 60s');
    }
    const dur = (duration && !isNaN(duration)) ? duration : 60;

    const targetBits = target_mb * 8 * 1024 * 1024;
    const audioBits = 128000; // 128 kbps
    let videoBits = Math.max(100000, Math.floor((targetBits / dur) - audioBits));
    if (videoBits < 100000) videoBits = 100000;
    const videoK = Math.floor(videoBits / 1000) + 'k';

    // build output
    const outName = path.basename(req.file.filename) + '.mp4';
    const outPath = path.join(outputsDir, outName);

    if (exact) {
      // two-pass encoding — first pass analyzes the video, second pass encodes using
      // that analysis so the final bitrate (and therefore size) actually lands on target.
      const passLogPrefix = path.join(outputsDir, path.basename(req.file.filename) + '.pass');
      const nullOut = process.platform === 'win32' ? 'NUL' : '/dev/null';
      const pass1Args = ['-y', '-i', inputPath, '-c:v', 'libx264', '-b:v', String(videoK), '-preset', 'medium', '-pass', '1', '-passlogfile', passLogPrefix, '-an', '-f', 'mp4', nullOut];
      const pass2Args = ['-y', '-i', inputPath, '-c:v', 'libx264', '-b:v', String(videoK), '-preset', 'medium', '-pass', '2', '-passlogfile', passLogPrefix, '-c:a', 'aac', '-b:a', '128k', outPath];
      console.log('Running ffmpeg (pass 1/2):', pass1Args.join(' '));
      try {
        await execFileP('ffmpeg', pass1Args);
      } catch (fferr) {
        console.error('ffmpeg pass 1 failed:', fferr);
        throw fferr;
      }
      console.log('Running ffmpeg (pass 2/2):', pass2Args.join(' '));
      try {
        await execFileP('ffmpeg', pass2Args);
      } catch (fferr) {
        console.error('ffmpeg pass 2 failed:', fferr);
        throw fferr;
      }
      for (const suffix of ['-0.log', '-0.log.mbtree']) {
        try { fs.unlinkSync(passLogPrefix + suffix); } catch (_) {}
      }
    } else {
      const ffmpegArgs = ['-y', '-i', inputPath, '-c:v', 'libx264', '-b:v', String(videoK), '-preset', 'medium', '-c:a', 'aac', '-b:a', '128k', outPath];
      console.log('Running ffmpeg:', ffmpegArgs.join(' '));
      try {
        await execFileP('ffmpeg', ffmpegArgs);
      } catch (fferr) {
        console.error('ffmpeg failed:', fferr);
        throw fferr;
      }
    }

    // remove uploaded file
    try { fs.unlinkSync(inputPath); } catch(e){}

    const stats = fs.statSync(outPath);
    const size_mb = +(stats.size / (1024*1024)).toFixed(2);
    const urlPath = '/outputs/' + path.basename(outPath);
    logEvent({ event: 'compress_done', ip: req.ip, file: originalName, upload_size_mb, target_mb, exact, size_mb, video_bitrate: videoK });
    res.json({ ok: true, url: urlPath, size_mb, target_mb, exact, video_bitrate: videoK, message: exact ? 'Comprimido com sucesso (2 passes)' : 'Comprimido com sucesso' });

  } catch (err) {
    logEvent({ event: 'compress_error', ip: req.ip, file: req.file ? req.file.originalname : undefined, error: String(err) });
    res.status(500).json({ ok: false, error: String(err) });
  }
});

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

app.use('/outputs', (req, res, next) => { logEvent({ event: 'download', ip: req.ip, file: req.path }); next(); }, express.static(outputsDir));
app.get(['/compress.html', '/video', '/logs.html'], (req, res, next) => { logEvent({ event: 'visit', ip: req.ip, file: req.path }); next(); });
app.get('/', (req, res) => res.redirect('/compress.html'));
app.get('/video', (req, res) => res.sendFile(path.join(process.cwd(), 'compress.html')));
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

const tryPorts = [3100, 3200, 3300, 3400, 3500, 3600, 3700, 3800, 3900, 4000, 0];
let idx = 0;
function listenNext() {
  const port = tryPorts[idx++] || 0;
  const server = app.listen(port, '0.0.0.0', () => {
    const p = server.address().port;
    const ip = getLocalIp();
    console.log('Server listening on 0.0.0.0:' + p);
    console.log('Open in browser from another machine on the same network:');
    console.log(`http://${ip}:${p}/compress.html`);
    console.log(`Or use this machine: http://localhost:${p}/compress.html`);
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
