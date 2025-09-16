// server.js — ShareChat: whitelist, static, uploads (multi + overwrite), files API,
// text preview, multi-chats, socket.io, paste-image support
// Запуск: node server.js   (или через systemd)
// Зависимости: npm i express socket.io multer

const path    = require('path');
const fs      = require('fs');
const http    = require('http');
const express = require('express');
const multer  = require('multer');

const app    = express();
const server = http.createServer(app);
const io     = require('socket.io')(server, {
  path: '/socket.io',
  cors: { origin: true, credentials: true }
});

const PORT    = process.env.PORT || 3000;
const ROOT    = __dirname;
const PUBLIC  = path.join(ROOT, 'public');
const UPLOADS = path.join(ROOT, 'uploads');
fs.mkdirSync(UPLOADS, { recursive: true });

// за прокси (для корректного X-Forwarded-For)
app.set('trust proxy', true);

/* =========================
   Utils / constants
========================= */
const textExts  = new Set(['txt','md','json','csv','log','js','ts','py','html','css','xml','yml','yaml','sh','bat','conf','ini']);
const imageExts = new Set(['jpg','jpeg','png','gif','webp','svg','bmp','ico','avif','heic','heif','tif','tiff']);

function safeBasename(name) { return path.basename(String(name || '')); }
function maybeFixLatin1Utf8(name) {
  if (/[ÃÂÐÑ][\x80-\xBF]/.test(name)) { try { return Buffer.from(name, 'latin1').toString('utf8'); } catch {} }
  return name;
}
function safeFileName(rawName) {
  const raw = maybeFixLatin1Utf8(String(rawName || 'file')).normalize('NFC');
  return (raw
    .replace(/[\\\/<>:"|?*\x00-\x1F]/g, '_')
    .replace(/[^\p{L}\p{N}\-_.+()\[\] ]/gu, '_')
    .replace(/\s+/g, ' ')
    .trim() || 'file');
}
function extOf(n){ return (n.split('.').pop() || '').toLowerCase(); }
function guessMime(n) {
  const e = extOf(n);
  if (['jpg','jpeg'].includes(e)) return 'image/jpeg';
  if (['png'].includes(e))       return 'image/png';
  if (['gif'].includes(e))       return 'image/gif';
  if (['webp'].includes(e))      return 'image/webp';
  if (['svg'].includes(e))       return 'image/svg+xml';
  if (['bmp'].includes(e))       return 'image/bmp';
  if (['ico'].includes(e))       return 'image/x-icon';
  if (['avif'].includes(e))      return 'image/avif';
  if (['heic','heif'].includes(e)) return 'image/heic';
  if (['mp4'].includes(e))       return 'video/mp4';
  if (['webm'].includes(e))      return 'video/webm';
  if (['mp3'].includes(e))       return 'audio/mpeg';
  if (['wav'].includes(e))       return 'audio/wav';
  if (['ogg'].includes(e))       return 'audio/ogg';
  if (['json'].includes(e))      return 'application/json; charset=utf-8';
  if (['csv'].includes(e))       return 'text/csv; charset=utf-8';
  if (textExts.has(e))           return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}
function fileUrl(fname){ return `/uploads/${encodeURIComponent(fname)}`; }

/* =========================
   IP whitelist (allowed_ips.txt)
========================= */
function getClientIP(req) {
  const xf = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  let ip = xf || req.socket?.remoteAddress || '';
  ip = ip.replace(/^::ffff:/, '').split('%')[0];
  if (ip.includes(':') && ip.includes('.')) ip = ip.split(':').pop();
  return ip;
}
const ALLOWED_FILE = path.join(ROOT, 'allowed_ips.txt');
function loadAllowedIPsRaw() {
  try {
    const s = fs.readFileSync(ALLOWED_FILE, 'utf8');
    return s.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  } catch { return []; }
}
function ipv4ToInt(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(n => isNaN(n) || n < 0 || n > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}
function parseEntry(entry) {
  if (entry === 'localhost') return { kind: 'exact', value: '127.0.0.1' };
  if (entry === '::1')       return { kind: 'exact', value: '::1' };
  if (entry.includes('/')) {
    const [base, bitsStr] = entry.split('/');
    const bits = Number(bitsStr);
    const baseInt = ipv4ToInt(base);
    if (baseInt == null || isNaN(bits) || bits < 0 || bits > 32) return null;
    const mask = bits === 0 ? 0 : (~((1 << (32 - bits)) - 1)) >>> 0;
    return { kind: 'cidr4', base: baseInt & mask, mask };
  }
  if (entry.includes('*')) {
    const rx = '^' + entry.replace(/\./g, '\\.').replace(/\*/g, '[^.]+') + '$';
    return { kind: 'wild', rx: new RegExp(rx) };
  }
  return { kind: 'exact', value: entry };
}
let allowedRaw = loadAllowedIPsRaw();
let allowed    = allowedRaw.map(parseEntry).filter(Boolean);
fs.watchFile(ALLOWED_FILE, () => { allowedRaw = loadAllowedIPsRaw(); allowed = allowedRaw.map(parseEntry).filter(Boolean); });

function isAllowed(req) {
  if (!allowed.length) return true;
  const ip = getClientIP(req);
  if (allowed.some(a => a.kind === 'exact' && a.value === ip)) return true;
  if (allowed.some(a => a.kind === 'wild'  && a.rx.test(ip))) return true;
  const ipInt = ipv4ToInt(ip);
  if (ipInt != null) for (const a of allowed) if (a.kind === 'cidr4' && ((ipInt & a.mask) === a.base)) return true;
  return false;
}

/* =========================
   Middleware
========================= */
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// health
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// глобальный пермишн для буфера обмена (инертный, но не мешает)
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'clipboard-write=(self)');
  next();
});

// whitelist
app.use((req, res, next) => {
  if (req.path === '/api/health') return next();
  if (!isAllowed(req)) return res.status(403).send('<h1>403</h1>');
  next();
});

/* =========================
   Static
========================= */
app.use('/public', express.static(PUBLIC, { maxAge: 0 }));

// /uploads: заголовки для корректного fetch→blob/clipboard и без кэша
app.use('/uploads', express.static(UPLOADS, {
  maxAge: 0,
  setHeaders(res, filePath) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
    if (/\.(svg)$/i.test(filePath)) {
      res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    }
  }
}));

/* =========================
   Uploads (multer)
========================= */
// overwrite-on-same-name (опционально отключаем через overwrite=false)
const multerStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS),
  filename: (req, file, cb) => {
    const overwrite = String(req.query.overwrite ?? req.body?.overwrite ?? 'true') !== 'false';
    const safe = safeFileName(file.originalname || 'file');
    const target = path.join(UPLOADS, safe);
    try { if (overwrite && fs.existsSync(target)) fs.unlinkSync(target); } catch {}
    cb(null, safe);
  }
});

// Принимаем любые формы: и single 'file', и 'files[]'
const uploadAny = multer({
  storage: multerStorage,
  limits: { fileSize: 200 * 1024 * 1024 } // 200MB
}).any();

// MULTI upload: принимает и 'files', и одиночный 'file'. Шлём file:new и files:update.
app.post('/api/upload', (req, res) => {
  uploadAny(req, res, (err) => {
    if (err) return res.status(400).json({ ok: false, error: String(err) });

    const files = (req.files || []).map(f => ({
      name: f.filename,
      size: f.size,
      type: guessMime(f.filename),
      url:  fileUrl(f.filename),
    }));

    files.forEach(m => io.emit('file:new', m)); // для карточек/превью
    io.emit('files:update');                    // гарантированное обновление списка

    return res.json({ ok: true, files });
  });
});

/* =========================
   Files API (list/delete/preview)
========================= */
// Список: только обычные файлы и НЕ изображения
app.get('/api/files', (_req, res) => {
  try {
    const list = fs.readdirSync(UPLOADS).map(n => {
      const p = path.join(UPLOADS, n);
      const st = fs.statSync(p);
      return { name: n, p, st };
    })
    .filter(x => x.st.isFile())
    .filter(x => !imageExts.has(extOf(x.name)))
    .map(x => ({ name: x.name, size: x.st.size, mtime: +x.st.mtime }))
    .sort((a, b) => b.mtime - a.mtime);

    res.json({ ok: true, files: list });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Удалить ВСЁ (и файлы, и папки)
app.delete('/api/files', (_req, res) => {
  try {
    let cnt = 0;
    for (const n of fs.readdirSync(UPLOADS)) {
      const p = path.join(UPLOADS, n);
      try { fs.rmSync(p, { recursive: true, force: true }); cnt++; } catch {}
    }
    io.emit('files:update');
    res.json({ ok: true, deleted: cnt });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Удалить конкретное имя (файл или папку)
app.delete('/api/files/:name', (req, res) => {
  try {
    const p = path.join(UPLOADS, safeBasename(req.params.name));
    if (!fs.existsSync(p)) return res.status(404).json({ ok: false, error: 'not found' });
    const st = fs.statSync(p);
    if (st.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
    else                  fs.unlinkSync(p);
    io.emit('files:update');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Текстовый предпросмотр
app.get('/preview/:name', (req, res) => {
  const name = safeBasename(req.params.name);
  const ext  = extOf(name);
  if (!textExts.has(ext)) return res.status(415).send('Unsupported preview');
  const p = path.join(UPLOADS, name);
  if (!fs.existsSync(p)) return res.status(404).send('Not found');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  fs.createReadStream(p).pipe(res);
});

/* =========================
   Chats (Map в памяти) + REST
========================= */
const chats = global._chats || new Map(); // Map<number, {messages: Array, names: Set}>
global._chats = chats;

function ensureChat(idRaw) {
  const id = Number(idRaw) || 1;
  if (!chats.has(id)) chats.set(id, { messages: [], names: new Set() });
  return id;
}
function getChat(idRaw) { return chats.get(ensureChat(idRaw)); }
function sortedIds()    { return Array.from(chats.keys()).sort((a, b) => a - b); }
function nextChatId()   { return chats.size ? Math.max(...chats.keys()) + 1 : 1; }
ensureChat(1);

// Список чатов
app.get('/api/chats', (_req, res) => res.json({ ok: true, chats: sortedIds() }));

// Создать чат
app.post('/api/chats', (_req, res) => {
  const id = nextChatId();
  ensureChat(id);
  io.emit('chats:list', { chats: sortedIds() });
  res.status(201).json({ ok: true, id });
});

// Удалить чат целиком
app.delete('/api/chats/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: 'bad id' });
  if (!chats.has(id)) return res.sendStatus(204);
  chats.delete(id);
  if (chats.size === 0) ensureChat(1);
  io.emit('chats:list', { chats: sortedIds() });
  res.sendStatus(204);
});

// Очистить только сообщения выбранного чата
app.delete('/api/chats/:id/messages', (req, res) => {
  try {
    const id = ensureChat(req.params.id);
    const c  = chats.get(id);
    c.messages.length = 0;
    c.names.clear();
    io.emit('chat:cleared', { id, names: [] });
    res.sendStatus(204);
  } catch (e) {
    res.status(500).json({ ok: false, error: 'internal error' });
  }
});

/* =========================
   Socket.IO
========================= */
io.on('connection', (socket) => {
  // список чатов и начальная инициализация
  socket.emit('chats:list', { chats: sortedIds() });
  {
    const id = sortedIds()[0] || 1;
    const c  = getChat(id);
    socket.emit('chat:init', {
      id,
      messages: c.messages.slice(-200),
      names: Array.from(c.names).slice(0, 500)
    });
  }

  socket.on('chat:select', (payload) => {
    const want = Number(payload?.id);
    const ids  = sortedIds();
    const id   = ids.includes(want) ? want : (ids[0] || 1);
    const c    = getChat(id);
    socket.emit('chat:init', {
      id,
      messages: c.messages.slice(-200),
      names: Array.from(c.names).slice(0, 500)
    });
  });

  // Текст / картинка (как URL из /uploads)
  socket.on('chat:message', (m = {}) => {
    try {
      const id    = Number(m.id);
      const name  = String(m.name || 'Anon').slice(0, 64);
      const text  = (m.text  != null) ? String(m.text ).slice(0, 10000) : '';
      const image = (m.image != null) ? String(m.image).slice(0, 2048)   : '';
      if (!Number.isInteger(id)) return;
      if (!text && !image) return;

      const c = getChat(id);
      const msg = { id, name, time: Date.now() };
      if (image) msg.image = image; else msg.text = text;

      c.messages.push(msg);
      if (c.messages.length > 1000) c.messages.splice(0, c.messages.length - 1000);
      if (name.trim()) c.names.add(name.trim());

      io.emit('chat:message', msg);
      io.emit('chat:names', { id, names: Array.from(c.names).slice(0, 500) });
    } catch (e) {
      console.error('chat:message error', e);
    }
  });

  // ПРИЁМ картинок из буфера обмена: { name?, type?, base64: "data:image/png;base64,..." }
  socket.on('image:upload', (payload = {}) => {
    try {
      const dataURL = String(payload.base64 || '');
      const nameRaw = String(payload.name || '');
      const type    = String(payload.type || '');
      if (!dataURL.startsWith('data:') || !dataURL.includes('base64,')) {
        return socket.emit('image:uploaded', { ok: false, error: 'bad data url' });
      }
      const base64 = dataURL.split('base64,').pop();
      const buf = Buffer.from(base64, 'base64');

      const ext = extOf(nameRaw) || (type.split('/')[1] || 'png');
      const fname = safeFileName(nameRaw) || `image-${Date.now()}.${ext}`;
      const fpath = path.join(UPLOADS, fname);
      try { if (fs.existsSync(fpath)) fs.unlinkSync(fpath); } catch {}
      fs.writeFileSync(fpath, buf);

      const meta = { name: fname, size: buf.length, type: guessMime(fname), url: fileUrl(fname) };
      io.emit('file:new', meta);
      io.emit('files:update');
      socket.emit('image:uploaded', { ok: true, ...meta });
    } catch (e) {
      socket.emit('image:uploaded', { ok: false, error: e.message });
    }
  });

  // Фолбэк очистки через сокет
  socket.on('chat:clear', (payload = {}) => {
    try {
      const id = ensureChat(payload.id);
      const c  = chats.get(id);
      c.messages.length = 0;
      c.names.clear();
      io.emit('chat:cleared', { id, names: [] });
    } catch (e) {
      console.error('socket chat:clear error', e);
    }
  });
});

/* =========================
   Index
========================= */
app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));

server.listen(PORT, () => {
  console.log('ShareChat listening on', PORT);
});
