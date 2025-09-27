// public/client.js — ShareChat фронт (эфемерные скриншоты как data:URL + умное копирование)
// Обновления:
// 1) Изображения в чате не обрезаются: масштабирование внутри сообщения + Shift-клик = полноэкранный просмотр.
// 2) Клик по картинке → копируем картинку как PNG в буфер (Clipboard API). Alt-клик → копируем короткий текст вместо огромного data:URL.
// 3) Паста/дроп скриншотов не грузит их на сервер (эфемерные data:URL). Перед отправкой — мягкое даунскейление до 1920px по большей стороне.

(() => {
  const $ = sel => document.querySelector(sel);

  /* ---------- DOM ---------- */
  const chatEl       = $('#chat');
  const filesEl      = $('#files');
  let   nameInput    = $('#name');
  let   msgInput     = $('#message');
  const sendBtn      = $('#sendBtn');
  const dropzone     = $('#dropzone');
  const fileInput    = $('#fileInput');
  const mentionMenu  = $('#mentionMenu');
  const themeToggle  = $('#themeToggle');

  const chatSelect   = $('#chatSelect');
  const chatAddBtn   = $('#chatAdd');
  const chatDelBtn   = $('#chatDel');
  const clearChatBtn = $('#clearChat');

  fileInput?.setAttribute('multiple', '');

  /* ---------- socket ---------- */
  const socket = io({ path: '/socket.io' });

  /* ---------- Runtime CSS (чтобы точно не резало изображение) ---------- */
  (function injectStyles(){
    if (document.getElementById('chat-runtime-styles')) return;
    const css = `
      .msg { position: relative; }
      .msg.msg-image img.chat-img{
        max-width: min(100%, 90vw);
        max-height: 70vh;
        height: auto;
        object-fit: contain;
        object-position: center center;
        display: block;
        border-radius: 6px;
      }
      /* эффект "скопировано" */
      .msg.copied::after{
        content:"Скопировано";
        position:absolute; right:8px; top:8px;
        background:rgba(0,0,0,.6); color:#fff; padding:2px 6px; border-radius:4px; font-size:12px;
      }
      /* лайтбокс */
      .lightbox-backdrop{
        position:fixed; inset:0; background:rgba(0,0,0,.8); z-index:9999; display:flex; align-items:center; justify-content:center;
      }
      .lightbox-img{
        max-width: 98vw; max-height: 98vh; object-fit: contain; border-radius:8px;
      }
    `;
    const st = document.createElement('style'); st.id='chat-runtime-styles'; st.textContent = css;
    document.head.appendChild(st);
  })();

  /* ---------- Тема ---------- */
  const html = document.documentElement;
  const sysPrefDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const savedTheme = localStorage.getItem('theme');
  const initialTheme = (savedTheme === 'dark' || savedTheme === 'light') ? savedTheme : (sysPrefDark ? 'dark' : 'light');
  html.setAttribute('data-theme', initialTheme);
  function updateThemeBtn() {
    const cur = html.getAttribute('data-theme') || 'light';
    const icon = (cur === 'light') ? '🌞' : '🌙';
    if (themeToggle) themeToggle.innerHTML = `<span class="icon" aria-hidden="true">${icon}</span><span class="label">Тема</span>`;
  }
  updateThemeBtn();
  themeToggle?.addEventListener('click', () => {
    const cur = html.getAttribute('data-theme') || 'light';
    const next = (cur === 'light') ? 'dark' : 'light';
    html.setAttribute('data-theme', next);
    localStorage.setItem('theme', next);
    updateThemeBtn();
  });

  /* ---------- Разметка формы ---------- */
  const form = $('#chatForm');
  if (form) {
    form.style.display = 'grid';
    form.style.gridTemplateColumns = '160px 1fr';
    form.style.gridTemplateAreas = '"name msg" "send send"';
    form.style.gap = '8px';
  }

  /* ---------- Имя как textarea (связка высот) ---------- */
  if (nameInput && nameInput.tagName !== 'TEXTAREA') {
    const ta = document.createElement('textarea');
    ta.id = nameInput.id;
    ta.className = 'name-input';
    ta.placeholder = nameInput.getAttribute('placeholder') || 'Имя';
    ta.value = nameInput.value || '';
    ta.rows = 1;
    ta.style.resize = 'none';
    nameInput.replaceWith(ta);
    nameInput = ta;
  }
  if (nameInput) nameInput.style.gridArea = 'name';
  if (msgInput)  msgInput.style.gridArea  = 'msg';
  if (sendBtn)   { sendBtn.style.gridArea = 'send'; sendBtn.style.width = '100%'; }

  /* ---------- Авто-рост обоих полей ---------- */
  const LINE = 22;
  const MAX_H = LINE * 5 + 22; // ~5 строк + паддинги
  const MIN_H = LINE + 14;
  const px = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
  function measure(el) {
    if (!el) return null;
    el.style.minHeight = MIN_H + 'px';
    el.setAttribute('rows', '1');
    el.style.resize = 'none';
    const cs = getComputedStyle(el);
    const minH = Math.max(MIN_H, px(cs.minHeight));
    const padV = px(cs.paddingTop) + px(cs.paddingBottom);
    const prevH = el.style.height;
    el.style.height = 'auto';
    const scrollH = el.scrollHeight;
    el.style.height = prevH;
    let needed = Math.max(scrollH, minH);
    const oneLine = needed <= minH + 1;
    if (!oneLine) needed = Math.min(needed, MAX_H);
    return { el, minH, padV, scrollH, needed, oneLine };
  }
  function apply(el, targetH, meta) {
    if (!el || !meta) return;
    const isOne = targetH <= meta.minH + 1;
    if (isOne) { el.style.lineHeight = Math.max(16, meta.minH - meta.padV) + 'px'; el.style.overflowY = 'hidden'; }
    else       { el.style.lineHeight = ''; el.style.overflowY = (meta.scrollH > MAX_H) ? 'auto' : 'hidden'; }
    el.style.height = targetH + 'px';
  }
  function autosizeBoth() {
    const m = measure(msgInput);
    const n = measure(nameInput);
    const finalH = Math.max(m?.needed || 0, n?.needed || 0, MIN_H);
    if (n) apply(nameInput, finalH, n);
    if (m) apply(msgInput,  finalH, m);
  }
  autosizeBoth();
  window.addEventListener('resize', autosizeBoth);
  nameInput?.addEventListener('input', autosizeBoth, { passive: true });
  msgInput?.addEventListener('input',  autosizeBoth, { passive: true });

  /* ---------- Чаты: состояние ---------- */
  let currentChatId = Number(localStorage.getItem('chatId') || '1') || 1;
  let knownNames = [];
  function setCurrentChat(id, { emit=true, save=true } = {}) {
    id = Number(id) || 1;
    currentChatId = id;
    if (save) { try { localStorage.setItem('chatId', String(id)); } catch {} }
    if (chatSelect) chatSelect.value = String(id);
    if (emit) socket.emit('chat:select', { id });
    if (chatEl) chatEl.innerHTML = '';
    autosizeBoth();
  }
  function rebuildChatSelect(ids) {
    if (!chatSelect) return;
    ids = (ids || []).map(Number).filter(Number.isFinite).sort((a,b)=>a-b);
    const old = Number(chatSelect.value || currentChatId || 1);
    chatSelect.innerHTML = ids.map(id => `<option value="${id}">${id}</option>`).join('');
    let next = old;
    if (!ids.includes(old)) {
      const lower = ids.filter(n => n < old);
      next = lower.length ? lower[lower.length - 1] : (ids[0] || 1);
    }
    setCurrentChat(next, { emit:true, save:true });
  }

  /* ---------- Utils ---------- */
  const fmtTime = t => new Date(t).toLocaleString();
  const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const isImageFile = (f) => !!f && /^image\//i.test(f.type);
  const imageExts = new Set(['png','jpg','jpeg','gif','webp','bmp','svg','heic','heif','avif']);
  const isImageName = (name='') => imageExts.has(String(name).split('.').pop()?.toLowerCase());
  const isTextName  = (name='') => /\.(txt|md|json|csv|log|js|ts|py|html|css|xml|yml|yaml|sh|bat|conf|ini)$/i.test(name);
  const isAudioName = (name='') => /\.(mp3|wav|ogg|m4a|flac)$/i.test(name);
  const isVideoName = (name='') => /\.(mp4|webm|mkv|mov)$/i.test(name);
  const formatBytes = (bytes) => {
    const b = Number(bytes)||0, u=['байт','KB','MB','GB','TB'];
    if (b < 1024) return `${b} байт`;
    let i=0, n=b; while (n>=1024 && i<u.length-1){ n/=1024; i++; }
    return `${n.toFixed(n<10?1:0)} ${u[i]}`;
  };

  async function copyPlainText(text) {
    try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; } } catch {}
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.readOnly = true;
      ta.style.position='fixed'; ta.style.top='-2000px'; ta.style.opacity='0';
      document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, ta.value.length);
      const ok = document.execCommand('copy'); document.body.removeChild(ta); return ok;
    } catch { return false; }
  }

  const blobToDataURL = (blob) => new Promise((res, rej) => { const fr=new FileReader(); fr.onload=()=>res(fr.result); fr.onerror=rej; fr.readAsDataURL(blob); });
  function loadImage(src){ return new Promise((res,rej)=>{ const im=new Image(); im.onload=()=>res(im); im.onerror=rej; im.src=src; }); }
  function canvasToBlob(canvas,type='image/png',quality=0.92){ return new Promise(res=>canvas.toBlob(b=>res(b),type,quality)); }

  // Мягкое даунскейление больших скриншотов (до 1920 по большей стороне), сохраняем резкость
  async function downscaleDataURL(dataURL, maxSide=1920, outType='image/png', outQuality=0.92){
    const img = await loadImage(dataURL);
    const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    const scale = Math.min(1, maxSide/Math.max(w,h));
    if (scale >= 1) return dataURL; // и так ок
    const cw = Math.max(1, Math.round(w*scale)), ch = Math.max(1, Math.round(h*scale));
    const canvas = document.createElement('canvas'); canvas.width=cw; canvas.height=ch;
    const ctx = canvas.getContext('2d');
    // чуть лучше качество на downscale
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0,0, cw,ch);
    const blob = await canvasToBlob(canvas, outType, outQuality);
    return await blobToDataURL(blob);
  }

  // Преобразуем Blob → data:URL и при необходимости уменьшаем
  async function prepareDataURLForChat(file){
    const orig = await blobToDataURL(file);
    // GIF/SVG не трогаем (анимация/вектор)
    const t = (file.type||'').toLowerCase();
    if (t.includes('gif') || t.includes('svg')) return orig;
    return await downscaleDataURL(orig, 1920, 'image/png', 0.92);
  }

  /* ---------- РЕНДЕР СООБЩЕНИЙ ---------- */
  function renderMsg(m) {
    if (!m) return;
    const name = escapeHtml(m.name || 'Anon');
    const time = fmtTime(m.time || Date.now());

    const wrap = document.createElement('div');
    if (m.image) {
      wrap.className = 'msg msg-image';
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = `${name} • ${time}`;

      const img = document.createElement('img');
      img.className = 'chat-img';
      img.alt = name;
      img.src = m.image;           // может быть data: или /uploads/…
      // страховка, если внешние стили переопределят
      img.style.maxWidth = 'min(100%, 90vw)';
      img.style.maxHeight = '70vh';
      img.style.height = 'auto';
      img.style.objectFit = 'contain';
      img.style.objectPosition = 'center center';
      img.decoding = 'async';
      img.loading  = 'lazy';

      wrap.appendChild(meta);
      wrap.appendChild(img);
    } else {
      wrap.className = 'msg msg-text';
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = `${name} • ${time}`;

      const text = document.createElement('div');
      text.className = 'text';
      text.innerHTML = (m.text ? escapeHtml(m.text) : '');

      wrap.appendChild(meta);
      wrap.appendChild(text);
    }

    chatEl.appendChild(wrap);
  }

  /* ---------- Лайтбокс для полноэкранного просмотра (Shift-клик) ---------- */
  function openLightbox(src){
    const back = document.createElement('div'); back.className='lightbox-backdrop';
    const img  = document.createElement('img'); img.className='lightbox-img'; img.src=src; img.alt='';
    back.appendChild(img);
    back.addEventListener('click', () => document.body.removeChild(back), { once:true });
    document.addEventListener('keydown', function onEsc(e){ if(e.key==='Escape'){ try{document.body.removeChild(back);}catch{} document.removeEventListener('keydown', onEsc);} });
    document.body.appendChild(back);
  }

  /* ---------- КОПИРОВАНИЕ: клик по картинке ---------- */
  chatEl?.addEventListener('click', async (e) => {
    const msg = e.target.closest('.msg.msg-image');
    if (!msg) return;
    const img = msg.querySelector('img.chat-img');
    if (!img) return;
    const src = img.getAttribute('src') || '';
    if (!src) return;

    // Shift-клик → открыть полноэкранный просмотр
    if (e.shiftKey) { openLightbox(src); return; }

    // Alt-клик → копируем "короткий текст" вместо длинного data:URL
    if (e.altKey) {
      // попробуем определить размер
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      const label = `[Скриншот • ${w && h ? `${w}×${h}` : 'изображение'}]`;
      const ok = await copyPlainText(label);
      if (ok) { msg.classList.add('copied'); setTimeout(()=>msg.classList.remove('copied'), 700); }
      return;
    }

    // Обычный клик → копируем саму картинку в буфер (PNG) через Async Clipboard API
    try {
      let blob;
      if (src.startsWith('data:')) blob = await fetch(src).then(r=>r.blob());
      else {
        const abs = (src.startsWith('http') || src.startsWith('blob:')) ? src : (location.origin + src);
        blob = await fetch(abs, { cache: 'no-store' }).then(r=>r.blob());
      }
      // если браузер умеет ClipboardItem — пишем PNG/исходный тип
      if (window.ClipboardItem && navigator.clipboard?.write) {
        const type = (blob.type && blob.type !== 'application/octet-stream') ? blob.type : 'image/png';
        await navigator.clipboard.write([ new ClipboardItem({ [type]: blob }) ]);
        msg.classList.add('copied'); setTimeout(()=>msg.classList.remove('copied'), 700);
      } else {
        // фолбэк: выделение элемента + execCommand('copy') (может сработать в некоторых браузерах)
        const sel = window.getSelection(); const range = document.createRange();
        sel.removeAllRanges(); range.selectNode(img); sel.addRange(range);
        const ok = document.execCommand('copy'); sel.removeAllRanges();
        if (!ok) await copyPlainText('[Скриншот скопирован]');
        msg.classList.add('copied'); setTimeout(()=>msg.classList.remove('copied'), 700);
      }
    } catch {
      // финальный фолбэк — короткая подпись
      await copyPlainText('[Скриншот]');
      msg.classList.add('copied'); setTimeout(()=>msg.classList.remove('copied'), 700);
    }
  });

  /* ---------- Отправка текста ---------- */
  function sendCurrentMessage() {
    const name = (nameInput?.value || '').trim() || 'Anon';
    const text = (msgInput?.value || '').trim();
    if (!text) return;
    if (sendBtn) sendBtn.disabled = true;
    socket.emit('chat:message', { id: currentChatId, name, text });
    if (msgInput) msgInput.value = '';
    detectMentionHighlight();
    autosizeBoth();
    setTimeout(() => { if (sendBtn) sendBtn.disabled = false; }, 50);
  }
  $('#chatForm')?.addEventListener('submit', (e) => { e.preventDefault(); sendCurrentMessage(); });

  /* ---------- Mentions ---------- */
  let mentionIndex = 0, mentionOpen = false, mentionFilter = '';
  function renderNamesMenu(filter='') {
    if (!mentionMenu) return;
    const q = filter.trim().toLowerCase();
    const list = (knownNames||[]).filter(n => n.toLowerCase().includes(q)).slice(0,20);
    mentionMenu.innerHTML = list.map((n,i)=>`<div class="mention-item ${i===mentionIndex?'active':''}" data-name="${n}">@${escapeHtml(n)}</div>`).join('') || `<div class="mention-item muted">Нет совпадений</div>`;
    mentionMenu.querySelectorAll('.mention-item').forEach((el) => {
      const nm = el.getAttribute('data-name'); if (!nm) return;
      el.addEventListener('mousedown', (e) => { e.preventDefault(); insertMention(nm, true); closeMentionMenu(); });
    });
  }
  function openMentionMenu(filter=''){ if(!mentionMenu) return; mentionFilter=filter; mentionIndex=0; mentionOpen=true; mentionMenu.hidden=false; renderNamesMenu(filter); }
  function closeMentionMenu(){ if(!mentionMenu) return; mentionOpen=false; mentionMenu.hidden=true; }
  function insertMention(nm, withColon=false){
    if (!msgInput) return;
    const val = msgInput.value; const caret = msgInput.selectionStart ?? val.length; const upto = val.slice(0, caret);
    const at = upto.lastIndexOf('@');
    if (at >= 0) {
      const before = val.slice(0, at), after = val.slice(caret);
      const mention='@'+nm+(withColon?': ':' ');
      msgInput.value = before+mention+after;
      const pos=(before+mention).length; msgInput.setSelectionRange(pos,pos);
      detectMentionHighlight(); autosizeBoth();
    }
  }
  function detectMentionHighlight(){
    if (!msgInput) return;
    const val = msgInput.value;
    const has = /@([^\s:]{1,64}):/u.test(val) || (knownNames||[]).some(n => new RegExp(`@${n}\\b`).test(val));
    msgInput.classList.toggle('has-mention', has);
  }

  msgInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      if (mentionOpen) {
        e.preventDefault();
        const active = mentionMenu?.querySelector('.mention-item.active');
        const nm = active?.getAttribute('data-name') || (knownNames||[]).find(n => n.toLowerCase().includes((mentionFilter||'').toLowerCase())) || '';
        if (nm) insertMention(nm, true);
        closeMentionMenu();
        return;
      }
      e.preventDefault();
      sendCurrentMessage();
    }
  });

  msgInput?.addEventListener('input', () => {
    detectMentionHighlight();
    autosizeBoth();
    const caret = msgInput.selectionStart || msgInput.value.length;
    const upto = msgInput.value.slice(0, caret);
    const at = upto.lastIndexOf('@');
    if (at >= 0) {
      const afterAt = upto.slice(at+1);
      if (/^[^\s@]{0,32}$/.test(afterAt)) { openMentionMenu(afterAt); return; }
    }
    closeMentionMenu();
  });

  document.addEventListener('click', (e) => {
    if (!mentionOpen) return;
    if (!mentionMenu?.contains(e.target) && e.target !== msgInput) closeMentionMenu();
  });

  /* ---------- ЭФЕМЕРНЫЕ СКРИНШОТЫ/КАРТИНКИ: paste + drop в поле сообщения ---------- */
  msgInput?.addEventListener('paste', async (e) => {
    const items = e.clipboardData?.items || [];
    const images = [];
    for (const it of items) {
      if (it.kind === 'file') {
        const f = it.getAsFile();
        if (f && isImageFile(f)) images.push(f);
      }
    }
    if (!images.length) return;

    e.preventDefault();
    const name = (nameInput?.value || '').trim() || 'Anon';
    for (const f of images) {
      try {
        const dataURL = await prepareDataURLForChat(f); // data:image/*;base64,... (возможен даунскейл)
        socket.emit('chat:message', { id: currentChatId, name, image: dataURL, mime: f.type || 'image/png' });
      } catch {}
    }
  });

  msgInput?.addEventListener('dragover', (e) => { e.preventDefault(); });
  msgInput?.addEventListener('drop', async (e) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer?.files || []).filter(isImageFile);
    if (!files.length) return;
    const name = (nameInput?.value || '').trim() || 'Anon';
    for (const f of files) {
      try {
        const dataURL = await prepareDataURLForChat(f);
        socket.emit('chat:message', { id: currentChatId, name, image: dataURL, mime: f.type || 'image/png' });
      } catch {}
    }
  });

  /* ---------- Очередь загрузок: dropzone / fileInput (обычные файлы на сервер) ---------- */
  const queue = [];
  let uploading = false;
  async function uploadEnqueue(files) {
    if (!files || !files.length) return;
    for (const f of files) queue.push({ file: f });
    if (uploading) return;
    uploading = true;
    while (queue.length) {
      const { file } = queue.shift();
      await uploadOne(file);
    }
    uploading = false;
  }
  async function uploadOne(file) {
    const fd = new FormData();
    fd.append('files', file, file.name || `file-${Date.now()}`);
    try {
      const r = await fetch('/api/upload?overwrite=true', { method: 'POST', body: fd });
      const j = await r.json();
      if (Array.isArray(j?.files)) { /* ничего: список обновим ниже */ }
    } catch (e) {
      console.warn('upload error', e);
    } finally {
      loadFiles();
    }
  }

  /* ---------- Рекурсивный сбор файлов из dropzone ---------- */
  async function entriesToFiles(entry) {
    if (entry.isFile) {
      const file = await new Promise((res) => entry.file(res));
      return [file];
    }
    if (entry.isDirectory) {
      const dirReader = entry.createReader();
      const out = [];
      async function readBatch() {
        const entries = await new Promise(res => dirReader.readEntries(res));
        if (!entries.length) return;
        for (const e of entries) out.push(...await entriesToFiles(e));
        await readBatch();
      }
      await readBatch();
      return out;
    }
    return [];
  }
  async function dataTransferToFiles(dt) {
    const items = dt?.items;
    if (!items || !items.length) return Array.from(dt?.files || []);
    const withEntries = [];
    for (const it of items) {
      const entry = it.webkitGetAsEntry?.();
      if (entry) withEntries.push(...await entriesToFiles(entry));
    }
    return withEntries.length ? withEntries : Array.from(dt.files || []);
  }

  /* ---------- Dropzone (общая загрузка) ---------- */
  dropzone?.addEventListener('click', () => fileInput && fileInput.click());
  dropzone?.addEventListener('dragover', (e)=>{ e.preventDefault(); dropzone.classList.add('dragover'); });
  dropzone?.addEventListener('dragleave', ()=> dropzone.classList.remove('dragover'));
  dropzone?.addEventListener('drop', async (e)=> {
    e.preventDefault(); dropzone.classList.remove('dragover');
    const files = await dataTransferToFiles(e.dataTransfer);
    if (files.length) uploadEnqueue(files);
  });
  fileInput?.addEventListener('change', async () => {
    const files = Array.from(fileInput.files || []);
    if (files.length) uploadEnqueue(files);
    fileInput.value = '';
  });

  /* ---------- Files (список БЕЗ изображений) ---------- */
  async function loadFiles() {
    try {
      const r = await fetch('/api/files');
      const j = await r.json();
      if (!j.ok) throw new Error(j.error||'err');
      const onlyNonImages = (j.files||[]).filter(f => !isImageName(f.name));
      renderFiles(onlyNonImages);
    } catch {}
  }

  const MEDIA_MIN_WIDTH_PX = 110;
  function renderFiles(list) {
    if (!filesEl) return;
    filesEl.innerHTML = '';
    list.forEach(f => {
      const isText  = isTextName(f.name);
      const isAudio = isAudioName(f.name);
      const isVideo = isVideoName(f.name);

      const previewHref = isText
        ? `/preview/${encodeURIComponent(f.name)}`
        : `/uploads/${encodeURIComponent(f.name)}`;

      const previewLabel = isText ? 'Читать' :
                           isAudio ? 'Слушать' :
                           isVideo ? 'Смотреть' : 'Открыть';

      const el = document.createElement('div');
      el.className = 'file';
      el.innerHTML = `
        <div>
          <div class="name">${escapeHtml(f.name)}</div>
          <div class="meta">${formatBytes(f.size||0)} • ${fmtTime(f.mtime)}</div>
        </div>
        <div class="actions">
          <a class="btn media" href="${previewHref}" target="_blank" rel="noopener">${previewLabel}</a>
          <a class="btn download" href="/uploads/${encodeURIComponent(f.name)}" download>Скачать</a>
          <button class="btn del" title="Удалить" aria-label="Удалить файл">🗑️</button>
        </div>
      `;
      const mediaBtn = el.querySelector('.btn.media');
      if (mediaBtn) mediaBtn.style.minWidth = MEDIA_MIN_WIDTH_PX + 'px';

      el.querySelector('.btn.del').addEventListener('click', async () => {
        try { await fetch('/api/files/' + encodeURIComponent(f.name), { method: 'DELETE' }); }
        finally { loadFiles(); }
      });
      filesEl.appendChild(el);
    });
  }

  /* ---------- Socket ---------- */
  socket.on('chats:list', (payload) => {
    const ids = (payload?.chats || []).map(Number).sort((a,b)=>a-b);
    if (!ids.length) ids.push(1);
    rebuildChatSelect(ids);
  });

  socket.on('chat:init', (payload) => {
    const id   = Number(payload?.id) || 1;
    const msgs = Array.isArray(payload?.messages) ? payload.messages : [];
    knownNames = Array.isArray(payload?.names) ? payload.names : [];
    if (id !== currentChatId) setCurrentChat(id, { emit:false, save:true });
    if (chatEl) {
      chatEl.innerHTML = '';
      msgs.forEach(renderMsg);
      chatEl.scrollTop = chatEl.scrollHeight;
    }
    detectMentionHighlight();
    autosizeBoth();
  });

  socket.on('chat:message', (m) => {
    if (Number(m?.id) !== currentChatId) return;
    renderMsg(m);
    if (chatEl) chatEl.scrollTop = chatEl.scrollHeight;
  });

  socket.on('chat:names', (payload) => {
    if (Number(payload?.id) !== currentChatId) return;
    knownNames = Array.isArray(payload?.names) ? payload.names : [];
    detectMentionHighlight();
    if (mentionOpen) renderNamesMenu(mentionFilter);
  });

  socket.on('chat:cleared', (payload) => {
    if (Number(payload?.id) !== currentChatId) return;
    if (chatEl) chatEl.innerHTML = '';
    knownNames = Array.isArray(payload?.names) ? payload.names : [];
    detectMentionHighlight();
    autosizeBoth();
  });

  /* ---------- Управление чатами ---------- */
  async function deleteCurrentChatCompletely() {
    if (!confirm(`Удалить чат «${currentChatId}» полностью?`)) return;
    try { await fetch('/api/chats/' + encodeURIComponent(String(currentChatId)), { method: 'DELETE' }); } catch {}
  }
  async function clearCurrentChatMessages() {
    clearChatBtn?.setAttribute('disabled','');
    try {
      const r = await fetch('/api/chats/'+encodeURIComponent(String(currentChatId))+'/messages', { method:'DELETE' });
      if (r.ok || r.status === 204) {
        if (chatEl) chatEl.innerHTML = '';
        knownNames = [];
        detectMentionHighlight();
        autosizeBoth();
      } else {
        socket.emit('chat:clear', { id: currentChatId });
      }
    } catch {
      if (chatEl) chatEl.innerHTML = '';
      knownNames = [];
      detectMentionHighlight();
      autosizeBoth();
    } finally {
      clearChatBtn?.removeAttribute('disabled');
    }
  }
  chatAddBtn?.addEventListener('click',  async () => {
    try {
      const r = await fetch('/api/chats', { method:'POST' });
      const j = await r.json();
      if (j?.ok && j?.id) setCurrentChat(Number(j.id), { emit:true, save:true });
    } catch {}
  });
  chatDelBtn?.addEventListener('click',  () => deleteCurrentChatCompletely());
  clearChatBtn?.addEventListener('click', (e) => { e.preventDefault(); clearCurrentChatMessages(); });

  if (chatSelect) {
    chatSelect.addEventListener('change', (e) => {
      const id = Number(e.target.value);
      if (id && id !== currentChatId) {
        setCurrentChat(id, { emit: true, save: true });
      }
    });
  }

  /* ---------- Старт ---------- */
  loadFiles();
})();
