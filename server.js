// server.js — ShareChat (multi-chat), whitelist, uploads split (files/chat), preview, socket.io

const path    = require('path');
const fs      = require('fs');
const fsp     = require('fs/promises');
const http    = require('http');
const express = require('express');
const multer  = require('multer');

const app    = express();
const server = http.createServer(app);
const io     = require('socket.io')(server, { path: '/socket.io', cors: { origin: true, credentials: true } });

const PORT    = process.env.PORT || 3000;
const ROOT    = __dirname;
const PUBLIC  = path.join(ROOT, 'public');
const UPLOADS = path.join(ROOT, 'uploads');
// ❗ Разводим хранилища: обычные файлы vs картинки чата
const FILES_DIR = path.join(UPLOADS, 'files');
const CHAT_DIR  = path.join(UPLOADS, 'chat');
fs.mkdirSync(FILES_DIR, { recursive: true });
fs.mkdirSync(CHAT_DIR,  { recursive: true });

/* ---------- utils ---------- */
const textExts = new Set(['txt','md','json','csv','log','js','ts','py','html','css','xml','yml','yaml','sh','bat','conf','ini']);

/* ---------- whitelist: allowed_ips.txt ---------- */
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
  if (p.length !== 4 || p.some(n => isNaN(n) || n<0 || n>255)) return null;
  return ((p[0]<<24)>>>0) + (p[1]<<16) + (p[2]<<8) + p[3];
}
function parseEntry(entry) {
  if (entry === 'localhost') return { kind: 'exact', value: '127.0.0.1' };
  if (entry === '::1')       return { kind: 'exact', value: '::1' };
  if (entry.includes('/')) { // CIDR IPv4
    const [base, bitsStr] = entry.split('/'); const bits = Number(bitsStr);
    const baseInt = ipv4ToInt(base); if (baseInt == null || isNaN(bits) || bits<0 || bits>32) return null;
    const mask = bits===0 ? 0 : (~((1<<(32-bits))-1))>>>0;
    return { kind: 'cidr4', base: baseInt & mask, mask };
  }
  if (entry.includes('*')) {
    const rx = '^' + entry.replace(/\./g,'\\.').replace(/\*/g,'[^.]+') + '$';
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
  if (allowed.some(a => a.kind==='exact' && a.value===ip)) return true;
  if (allowed.some(a => a.kind==='wild'  && a.rx.test(ip))) return true;
  const ipInt = ipv4ToInt(ip);
  if (ipInt != null) for (const a of allowed) if (a.kind==='cidr4' && ((ipInt & a.mask)===a.base)) return true;
  return false;
}

/* ---------- middleware ---------- */
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use((req, res, next) => {
  if (req.path === '/api/health') return next();
  if (!isAllowed(req)) return res.status(403).send('<h1>403</h1>');
  next();
});

/* ---------- static ---------- */
app.use('/public',  express.static(PUBLIC,  { maxAge: 0 }));
app.use('/uploads', express.static(UPLOADS, { maxAge: 0 }));

/* ---------- uploads (раздельные стораджи) ---------- */
function maybeFixLatin1Utf8(name) {
  if (/[ÃÂÐÑ][\x80-\xBF]/.test(name)) { try { return Buffer.from(name, 'latin1').toString('utf8'); } catch {} }
  return name;
}
function makeDiskStorage(destDir) {
  return multer.diskStorage({
    destination: (_req,_file,cb)=>cb(null,destDir),
    filename: (_req,file,cb)=>{
      const raw = maybeFixLatin1Utf8(String(file.originalname||'file')).normalize('NFC');
      let safe = raw
        .replace(/[\\\/<>:"|?*\x00-\x1F]/g, '_')
        .replace(/[^\p{L}\p{N}\-_.+()\[\] ]/gu, '_')
        .replace(/\s+/g, ' ')
        .trim() || 'file';
      const target = path.join(destDir, safe);
      try { if (fs.existsSync(target)) fs.unlinkSync(target); } catch {}
      cb(null, safe);
    }
  });
}
const uploadFiles = multer({ storage: makeDiskStorage(FILES_DIR) });
const uploadChatImages = multer({
  storage: makeDiskStorage(CHAT_DIR),
  fileFilter: (_req, file, cb) => {
    if (/^image\//i.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only image uploads are allowed for chat'), false);
  }
});

/* обычные файлы -> uploads/files */
app.post('/api/upload', uploadFiles.single('file'), (req,res)=>{
  if(!req.file) return res.status(400).json({ok:false,error:'no file'});
  io.emit('files:update');
  res.json({ok:true,name:req.file.filename,size:req.file.size});
});

/* картинки чата -> uploads/chat (НЕ идут в список «Файлы») */
app.post('/api/upload-chat-image', uploadChatImages.single('image'), (req,res)=>{
  if(!req.file) return res.status(400).json({ok:false,error:'no file'});
  const url = `/uploads/chat/${encodeURIComponent(req.file.filename)}`;
  res.json({ ok:true, url, name:req.file.originalname, size:req.file.size, mime:req.file.mimetype });
});

/* ---------- files API — читает ТОЛЬКО uploads/files ---------- */
app.get('/api/files', (_req,res)=>{ try{
  const list=fs.readdirSync(FILES_DIR).map(n=>{
    const p=path.join(FILES_DIR,n); const st=fs.statSync(p);
    return {name:n,size:st.size,mtime:+st.mtime};
  }).sort((a,b)=>b.mtime-a.mtime);
  res.json({ok:true,files:list});
}catch(e){res.status(500).json({ok:false,error:String(e)})} });

app.delete('/api/files', (_req,res)=>{ try{
  let cnt=0; for(const n of fs.readdirSync(FILES_DIR)){ try{ fs.unlinkSync(path.join(FILES_DIR,n)); cnt++; }catch{} }
  io.emit('files:update'); res.json({ok:true,deleted:cnt});
}catch(e){ res.status(500).json({ok:false,error:String(e)}) } });

app.delete('/api/files/:name', (req,res)=>{ try{
  const p=path.join(FILES_DIR,path.basename(req.params.name));
  if(!fs.existsSync(p)) return res.status(404).json({ok:false,error:'not found'});
  fs.unlinkSync(p); io.emit('files:update'); res.json({ok:true});
}catch(e){res.status(500).json({ok:false,error:String(e)})} });

/* preview — только текстовые из uploads/files */
app.get('/preview/:name', (req,res)=>{
  const name=path.basename(req.params.name);
  const ext=(name.split('.').pop()||'').toLowerCase();
  if(!textExts.has(ext)) return res.status(415).send('Unsupported preview');
  const p=path.join(FILES_DIR,name); if(!fs.existsSync(p)) return res.status(404).send('Not found');
  res.setHeader('Content-Type','text/plain; charset=utf-8'); fs.createReadStream(p).pipe(res);
});

/* ---------- CHATS ---------- */
const chats = global._chats || new Map(); // { id -> { messages:[], names:Set } }
global._chats = chats;
function ensureChat(id) {
  if (!chats.has(id)) chats.set(id, { messages: [], names: new Set() });
}
function sortedIds() { return Array.from(chats.keys()).sort((a,b)=>a-b); }
function nextChatId() { return chats.size ? Math.max(...chats.keys()) + 1 : 1; }
ensureChat(1);

/* REST чаты */
app.get('/api/chats', (_req,res) => res.json({ ok:true, chats: sortedIds() }));
app.post('/api/chats', (_req,res) => {
  const id = nextChatId(); ensureChat(id);
  io.emit('chats:list', { chats: sortedIds() });
  res.status(201).json({ ok:true, id });
});
app.delete('/api/chats/:id', (_req,res) => {
  const id = Number(_req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ ok:false, error:'bad id' });
  if (!chats.has(id))      return res.sendStatus(204);
  chats.delete(id);
  if (chats.size === 0) ensureChat(1);
  io.emit('chats:list', { chats: sortedIds() });
  return res.sendStatus(204);
});
app.delete('/api/chats/:id/messages', (req,res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ ok:false, error:'bad id' });
  ensureChat(id);
  const c = chats.get(id);
  c.messages = [];
  c.names = new Set();
  io.emit('chat:cleared', { id, names: [] });
  res.sendStatus(204);
});

/* socket */
io.on('connection', (socket) => {
  socket.emit('chats:list', { chats: sortedIds() });
  {
    const id = sortedIds()[0] || 1;
    ensureChat(id);
    const c = chats.get(id);
    socket.emit('chat:init', { id, messages: c.messages.slice(-200), names: Array.from(c.names).slice(0,500) });
  }

  socket.on('chat:select', (payload) => {
    const id = Number(payload?.id);
    const ids = sortedIds();
    const selected = ids.includes(id) ? id : (ids[0] || 1);
    ensureChat(selected);
    const c = chats.get(selected);
    socket.emit('chat:init', { id: selected, messages: c.messages.slice(-200), names: Array.from(c.names).slice(0,500) });
  });

  socket.on('chat:clear', (payload) => {
    const id = Number(payload?.id);
    if (!Number.isInteger(id)) return;
    ensureChat(id);
    const c = chats.get(id);
    c.messages = [];
    c.names = new Set();
    io.emit('chat:cleared', { id, names: [] });
  });

  // Текст и/или Картинка (image = URL вида /uploads/chat/...)
  socket.on('chat:message', (m) => {
    try{
      const id   = Number(m?.id);
      const name = String(m?.name || 'Anon').slice(0,64);
      const text = typeof m?.text === 'string' ? String(m.text).slice(0,10000) : '';
      const image = (typeof m?.image === 'string' && m.image.startsWith('/uploads/chat/')) ? m.image : null;
      const mime  = (typeof m?.mime === 'string' ? m.mime : '');

      if (!Number.isInteger(id) || (!text && !image)) return;
      if (!chats.has(id)) return;
      const c = chats.get(id);

      const msg = { name, time: Date.now(), id };
      if (text)  msg.text  = text;
      if (image) { msg.image = image; if (mime) msg.mime = mime; }

      c.messages.push(msg);
      if (c.messages.length > 1000) c.messages.splice(0, c.messages.length - 1000);
      if (name.trim()) c.names.add(name.trim());

      io.emit('chat:message', msg);
      io.emit('chat:names', { id, names: Array.from(c.names).slice(0,500) });
    }catch{}
  });
});

/* ---------- index ---------- */
app.get('/', (_req,res)=> res.sendFile(path.join(PUBLIC,'index.html')));

server.listen(PORT, ()=>{ console.log('ShareChat listening on', PORT); });
