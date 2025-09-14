// server.js — ShareChat (multi-chat), whitelist, uploads, preview, socket.io
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
fs.mkdirSync(UPLOADS, { recursive: true });

/* ---------- utils ---------- */
const textExts = new Set([
  'txt','md','json','csv','log','js','ts','py','html','css','xml','yml','yaml','sh','bat','conf','ini'
]);

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

/* ---------- uploads ---------- */
function maybeFixLatin1Utf8(name) {
  if (/[ÃÂÐÑ][\x80-\xBF]/.test(name)) { try { return Buffer.from(name, 'latin1').toString('utf8'); } catch {} }
  return name;
}
const multerStorage = multer.diskStorage({
  destination: (_req,_file,cb)=>cb(null,UPLOADS),
  filename: (_req,file,cb)=>{
    const raw = maybeFixLatin1Utf8(String(file.originalname||'file')).normalize('NFC');
    let safe = raw
      .replace(/[\\\/<>:"|?*\x00-\x1F]/g, '_')
      .replace(/[^\p{L}\p{N}\-_.+()\[\] ]/gu, '_')
      .replace(/\s+/g, ' ')
      .trim() || 'file';
    const target = path.join(UPLOADS, safe);
    try { if (fs.existsSync(target)) fs.unlinkSync(target); } catch {}
    cb(null, safe);
  }
});
const upload = multer({ storage: multerStorage });

app.post('/api/upload', upload.single('file'), (req,res)=>{
  if(!req.file) return res.status(400).json({ok:false,error:'no file'});
  io.emit('files:update');
  res.json({ok:true,name:req.file.filename,size:req.file.size});
});

app.get('/api/files', (_req,res)=>{ try{
  const list=fs.readdirSync(UPLOADS).map(n=>{
    const p=path.join(UPLOADS,n); const st=fs.statSync(p);
    return {name:n,size:st.size,mtime:+st.mtime};
  }).sort((a,b)=>b.mtime-a.mtime);
  res.json({ok:true,files:list});
}catch(e){res.status(500).json({ok:false,error:String(e)})} });

app.delete('/api/files', (_req,res)=>{ try{
  let cnt=0; for(const n of fs.readdirSync(UPLOADS)){ try{ fs.unlinkSync(path.join(UPLOADS,n)); cnt++; }catch{} }
  io.emit('files:update'); res.json({ok:true,deleted:cnt});
}catch(e){ res.status(500).json({ok:false,error:String(e)}) } });

app.delete('/api/files/:name', (req,res)=>{ try{
  const p=path.join(UPLOADS,path.basename(req.params.name));
  if(!fs.existsSync(p)) return res.status(404).json({ok:false,error:'not found'});
  fs.unlinkSync(p); io.emit('files:update'); res.json({ok:true});
}catch(e){res.status(500).json({ok:false,error:String(e)})} });

app.get('/preview/:name', (req,res)=>{
  const name=path.basename(req.params.name);
  const ext=(name.split('.').pop()||'').toLowerCase();
  if(!textExts.has(ext)) return res.status(415).send('Unsupported preview');
  const p=path.join(UPLOADS,name); if(!fs.existsSync(p)) return res.status(404).send('Not found');
  res.setHeader('Content-Type','text/plain; charset=utf-8'); fs.createReadStream(p).pipe(res);
});

/* ---------- CHATS (вместо legacy "rooms") ---------- */
const chats = global._chats || new Map(); // Map<number, {messages: Array, names: Set}>
global._chats = chats;

function ensureChat(idRaw) {
  const id = Number(idRaw) || 1;
  if (!chats.has(id)) chats.set(id, { messages: [], names: new Set() });
  return id;
}
function getChat(idRaw) {
  const id = ensureChat(idRaw);
  return chats.get(id);
}
function sortedIds() { return Array.from(chats.keys()).sort((a,b)=>a-b); }
function nextChatId() { return chats.size ? Math.max(...chats.keys()) + 1 : 1; }

// Минимум один чат всегда
ensureChat(1);

/* --- REST: список/создание/удаление чатов --- */
app.get('/api/chats', (_req,res) => {
  res.json({ ok:true, chats: sortedIds() });
});

app.post('/api/chats', (_req,res) => {
  const id = nextChatId();
  ensureChat(id);
  io.emit('chats:list', { chats: sortedIds() });
  res.status(201).json({ ok:true, id });
});

app.delete('/api/chats/:id', (req,res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ ok:false, error:'bad id' });
  if (!chats.has(id))      return res.sendStatus(204); // уже удалён — ок
  chats.delete(id);
  if (chats.size === 0) ensureChat(1);
  io.emit('chats:list', { chats: sortedIds() });
  return res.sendStatus(204);
});

/* --- NEW: стереть ТОЛЬКО сообщения выбранного чата --- */
app.delete('/api/chats/:id/messages', (req, res) => {
  try {
    const id = ensureChat(req.params.id);
    const c  = chats.get(id);
    c.messages.length = 0;
    c.names.clear();
    io.emit('chat:cleared', { id, names: [] }); // фронт очистит окно и подсветку @
    return res.sendStatus(204);
  } catch (e) {
    console.error('clear messages error:', e);
    return res.status(500).json({ ok: false, error: 'internal error' });
  }
});

/* --- Socket.IO: выбор чата, сообщения, фолбэк очистки --- */
io.on('connection', (socket) => {
  // список чатов и первичная инициализация первым по порядку
  socket.emit('chats:list', { chats: sortedIds() });
  {
    const id = sortedIds()[0] || 1;
    const c  = getChat(id);
    socket.emit('chat:init', { id, messages: c.messages.slice(-200), names: Array.from(c.names).slice(0,500) });
  }

  socket.on('chat:select', (payload) => {
    const want = Number(payload?.id);
    const ids  = sortedIds();
    const id   = ids.includes(want) ? want : (ids[0] || 1);
    const c    = getChat(id);
    socket.emit('chat:init', { id, messages: c.messages.slice(-200), names: Array.from(c.names).slice(0,500) });
  });

  socket.on('chat:message', (m) => {
    try{
      const id   = Number(m?.id);
      const name = String(m?.name || 'Anon').slice(0,64);
      const text = String(m?.text || '').slice(0,10000);
      if (!Number.isInteger(id) || !text) return;
      const c = getChat(id); // гарантируем наличие чата
      const msg = { name, text, time: Date.now(), id };
      c.messages.push(msg);
      if (c.messages.length > 1000) c.messages.splice(0, c.messages.length - 1000);
      if (name.trim()) c.names.add(name.trim());
      io.emit('chat:message', msg);
      io.emit('chat:names', { id, names: Array.from(c.names).slice(0,500) });
    }catch(e){
      console.error('chat:message error', e);
    }
  });

  // Фолбэк: очистка сообщений через сокет (если клиент так вызовет)
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

/* ---------- index ---------- */
app.get('/', (_req,res)=> res.sendFile(path.join(PUBLIC,'index.html')));

server.listen(PORT, ()=>{ console.log('ShareChat listening on', PORT); });
