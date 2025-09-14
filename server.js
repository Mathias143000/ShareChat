// server.js — ShareChat (оформление, @mentions, Enter/Shift+Enter, whitelist, no-cache)
const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const io = require('socket.io')(server, { path: '/socket.io', cors: { origin: true, credentials: true } });

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const UPLOADS = path.join(ROOT, 'uploads');
fs.mkdirSync(UPLOADS, { recursive: true });

/* ---------- utils ---------- */
const textExts = new Set(['txt','md','json','csv','log','js','ts','py','html','css','xml','yml','yaml','sh','bat','conf','ini']);

// корректное извлечение IP (x-forwarded-for, ::ffff:)
function getClientIP(req) {
  const xf = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  let ip = xf || req.socket?.remoteAddress || '';
  ip = ip.replace(/^::ffff:/, '');
  ip = ip.split('%')[0];
  if (ip.includes(':') && ip.includes('.')) ip = ip.split(':').pop(); // убрать порт у IPv4
  return ip;
}

// чтение allowed_ips.txt
const ALLOWED_FILE = path.join(ROOT,'allowed_ips.txt');
function loadAllowedIPsRaw() {
  try {
    const s = fs.readFileSync(ALLOWED_FILE, 'utf8');
    return s.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  } catch { return []; }
}

// поддержка IPv4/IPv6 exact, wildcard (*), IPv4 CIDR
function ipv4ToInt(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(n => isNaN(n) || n<0 || n>255)) return null;
  return ((p[0]<<24)>>>0) + (p[1]<<16) + (p[2]<<8) + p[3];
}
function parseEntry(entry) {
  if (entry === 'localhost') return { kind: 'exact', value: '127.0.0.1' };
  if (entry === '::1')       return { kind: 'exact', value: '::1' };
  if (entry.includes('/')) { // CIDR IPv4
    const [base, bitsStr] = entry.split('/');
    const bits = Number(bitsStr);
    const baseInt = ipv4ToInt(base);
    if (baseInt == null || isNaN(bits) || bits<0 || bits>32) return null;
    const mask = bits===0 ? 0 : (~((1<<(32-bits))-1))>>>0;
    return { kind: 'cidr4', base: baseInt & mask, mask };
  }
  if (entry.includes('*')) { // wildcard
    const rx = '^' + entry.replace(/\./g,'\\.').replace(/\*/g,'[^.]+') + '$';
    return { kind: 'wild', rx: new RegExp(rx) };
  }
  return { kind: 'exact', value: entry };
}
let allowedRaw = loadAllowedIPsRaw();
let allowed = allowedRaw.map(parseEntry).filter(Boolean);
fs.watchFile(ALLOWED_FILE, () => { allowedRaw = loadAllowedIPsRaw(); allowed = allowedRaw.map(parseEntry).filter(Boolean); });

// пусто = всем можно
function isAllowed(req) {
  if (!allowed.length) return true;
  const ip = getClientIP(req);
  if (allowed.some(a => a.kind==='exact' && a.value===ip)) return true;
  if (allowed.some(a => a.kind==='wild' && a.rx.test(ip))) return true;
  const ipInt = ipv4ToInt(ip);
  if (ipInt != null) {
    for (const a of allowed) if (a.kind==='cidr4' && ((ipInt & a.mask)===a.base)) return true;
  }
  return false;
}

/* ---------- 403-заглушка ---------- */
const forbidPage = (ip) => `<!doctype html>
<html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Доступ запрещён — ShareChat</title>
<style>
:root{--bg:#0b1220;--card:#0f172a;--txt:#e5e7eb;--muted:#9aa4b2;--border:#334155;--accent:#ef4444}
@media (prefers-color-scheme: light){:root{--bg:#f3f4f6;--card:#fff;--txt:#111827;--muted:#6b7280;--border:#e5e7eb;--accent:#dc2626}}
*{box-sizing:border-box}html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--txt);font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif}
.wrap{min-height:100%;display:flex;align-items:center;justify-content:center;padding:24px}
.card{max-width:720px;width:100%;background:var(--card);border:1px solid var(--border);border-radius:16px;padding:28px;box-shadow:0 10px 30px rgba(0,0,0,.15)}
h1{margin:0 0 8px;font-size:28px}.muted{color:var(--muted)}.ip{border:1px dashed var(--border);border-radius:8px;padding:.2rem .5rem}
.btn{height:42px;padding:0 14px;border:1px solid var(--border);background:var(--card);color:var(--txt);border-radius:10px;font-weight:600;cursor:pointer}
.btn:hover{background:rgba(255,255,255,.04)}
</style>
<div class="wrap"><div class="card">
<h1>🔒 Доступ запрещён</h1>
<p>Ваш IP <span class="ip">${ip||'не распознан'}</span> не в списке разрешённых.</p>
<p class="muted">Добавьте IP/подсеть в <code>allowed_ips.txt</code> (поддерживает одиночные IP, <code>192.168.*.*</code>, <code>10.0.0.0/8</code>). Файл перечитывается автоматически.</p>
<button class="btn" onclick="location.reload()">Повторить</button>
</div></div>`;

/* ---------- middleware ---------- */
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use((req, res, next) => {
  if (req.path === '/api/health') return next();
  if (!isAllowed(req)) return res.status(403).send(forbidPage(getClientIP(req)));
  next();
});

/* ---------- static: без кэша ---------- */
app.use('/public', express.static(PUBLIC, { maxAge: 0 }));
app.use('/uploads', express.static(UPLOADS, { maxAge: 0 }));

/* ---------- upload: UTF-8 имена + перезапись ---------- */
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

/* ---------- files api ---------- */
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

/* ---------- preview ---------- */
app.get('/preview/:name', (req,res)=>{
  const name=path.basename(req.params.name);
  const ext=(name.split('.').pop()||'').toLowerCase();
  if(!textExts.has(ext)) return res.status(415).send('Unsupported preview');
  const p=path.join(UPLOADS,name); if(!fs.existsSync(p)) return res.status(404).send('Not found');
  res.setHeader('Content-Type','text/plain; charset=utf-8'); fs.createReadStream(p).pipe(res);
});

/* ---------- chat ---------- */
const messages = [];
const knownNames = new Set();
const currentNames = () => Array.from(knownNames).slice(0, 500);

io.on('connection',(socket)=>{
  socket.emit('init', { messages: messages.slice(-200), names: currentNames() });

  socket.on('chat',(m)=>{ try{
    const msg = {
      name: String(m?.name || 'Anon').slice(0,64),
      text: String(m?.text || '').slice(0,10000),
      time: Date.now()
    };
    messages.push(msg);
    if (messages.length > 1000) messages.splice(0, messages.length - 1000);
    if (msg.name.trim()) knownNames.add(msg.name.trim());
    io.emit('chat', msg);
    io.emit('names', currentNames());
  }catch{} });

  socket.on('chat:clear:ask', ()=>{
    messages.length = 0; knownNames.clear();
    io.emit('chat:clear'); io.emit('names', currentNames());
  });
});

app.delete('/api/chat', (_req,res)=>{ try{
  messages.length=0; knownNames.clear();
  io.emit('chat:clear'); io.emit('names', currentNames());
  res.json({ok:true});
} catch(e){ res.status(500).json({ok:false,error:String(e)}) } });

/* ---------- index ---------- */
app.get('/', (_req,res)=> res.sendFile(path.join(PUBLIC,'index.html')));

server.listen(PORT, ()=>{ console.log('ShareChat listening on', PORT); });
