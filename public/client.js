// public/client.js — ShareChat фронт
// Копирование картинки по клику по сообщению (HTTP-friendly):
// 1) oncopy + text/html с <img src="dataURL"> и попыткой положить бинарный image/png в clipboardData.items
// 2) Selection API: клон <img> в скрытом contentEditable
// 3) Фолбэк: копируем URL / скачиваем
//
// Источники подхода к буферу обмена:
// - Статья на Хабре о работе с буфером (oncopy/clipboardData + HTML/PNG). :contentReference[oaicite:0]{index=0}
// - MDN: Document.execCommand (устаревший, но всё ещё поддерживается), Clipboard API write/ClipboardItem и secure context. :contentReference[oaicite:1]{index=1}
// - web.dev: копирование изображений (Async Clipboard + классический способ), поведение браузеров. :contentReference[oaicite:2]{index=2}

(() => {
  const $ = sel => document.querySelector(sel);

  /* ---------- DOM ---------- */
  const chatEl       = $('#chat');
  const filesEl      = $('#files');
  let   nameInput    = $('#name');
  let   msgInput     = $('#message');
  const sendBtn      = $('#sendBtn');
  const dropzone     = $('#dropzone');
  const fileInput    = $('#fileInput'); // <input type="file">
  const deleteAllBtn = $('#deleteAll');
  const mentionMenu  = $('#mentionMenu');
  const themeToggle  = $('#themeToggle');
  const testCopyBtn  = $('#testCopy');
  const testCopyBtn2 = $('#testCopy2');

  const chatSelect   = $('#chatSelect');
  const chatAddBtn   = $('#chatAdd');
  const chatDelBtn   = $('#chatDel');
  const clearChatBtn = $('#clearChat');

  // Разрешаем множественный выбор в инпуте
  fileInput?.setAttribute('multiple', '');

  /* ---------- socket ---------- */
  const socket = io({ path: '/socket.io' });

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

  /* ---------- Авто-рост обоих полей (макс. ~5 строк) ---------- */
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

  // Распознавание типов файлов по имени
  function isTextName(name=''){
    return /\.(txt|md|json|csv|log|js|ts|py|html|css|xml|yml|yaml|sh|bat|conf|ini)$/i.test(name);
  }
  function isAudioName(name=''){ return /\.(mp3|wav|ogg|m4a|flac)$/i.test(name); }
  function isVideoName(name=''){ return /\.(mp4|webm|mkv|mov)$/i.test(name); }

  // Человекочитаемые размеры
  function formatBytes(bytes){
    const b = Number(bytes)||0;
    const u = ['байт','KB','MB','GB','TB'];
    if (b < 1024) return `${b} ${b===1?'байт':'байт'}`;
    let i = 0, n = b;
    while (n >= 1024 && i < u.length-1){ n /= 1024; i++; }
    return `${n.toFixed(n<10 ? 1 : 0)} ${u[i]}`;
  }

  async function copyPlainText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
    } catch {}
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.readOnly = true;
      ta.style.position='fixed'; ta.style.top='-2000px'; ta.style.opacity='0';
      document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, ta.value.length);
      const ok = document.execCommand('copy'); document.body.removeChild(ta); return ok;
    } catch { return false; }
  }

  // Преобразование Blob → PNG Blob через canvas (для совместимости копирования)
  async function blobToPngBlob(inputBlob){
    try {
      if ((inputBlob?.type || '').toLowerCase() === 'image/png') return inputBlob;
      const dataURL = await new Promise((res, rej) => {
        const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(inputBlob);
      });
      const img = await new Promise((res, rej) => {
        const im = new Image();
        im.crossOrigin = 'anonymous';
        im.onload = () => res(im);
        im.onerror = rej;
        im.src = dataURL;
      });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, img.naturalWidth || img.width || 1);
      canvas.height = Math.max(1, img.naturalHeight || img.height || 1);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const pngBlob = await new Promise(res => canvas.toBlob(b => res(b || inputBlob), 'image/png'));
      return pngBlob || inputBlob;
    } catch { return inputBlob; }
  }

  // oncopy (+text/html, +binary image если возможно)
  function copyViaOnCopy(htmlMarkup, plain = '', imageBlob = null) {
    return new Promise((resolve) => {
      let handled = false;
      const onCopy = (ev) => {
        try {
          ev.preventDefault();
          ev.clipboardData.setData('text/html', htmlMarkup);
          ev.clipboardData.setData('text/plain', plain);
          // Положим PNG в буфер для приложений (Word/Docs), кто умеет
          if (imageBlob && ev.clipboardData?.items?.add) {
            try { ev.clipboardData.items.add(imageBlob, imageBlob.type || 'image/png'); } catch {}
          }
          handled = true;
          resolve(true);
        } catch { resolve(false); }
      };
      document.addEventListener('copy', onCopy, { once: true });

      // Триггер копирования жестом пользователя (execCommand) — классический способ
      const sel = window.getSelection();
      const saved = [];
      for (let i = 0; i < sel.rangeCount; i++) saved.push(sel.getRangeAt(i));
      const dummy = document.createElement('span');
      dummy.textContent = '.';
      Object.assign(dummy.style, { position:'fixed', left:'-99999px', top:'0', opacity:'0' });
      document.body.appendChild(dummy);
      const r = document.createRange();
      r.selectNodeContents(dummy);
      sel.removeAllRanges();
      sel.addRange(r);
      const ok = document.execCommand('copy'); // MDN: execCommand copy (устаревший, но работает в event handlers). :contentReference[oaicite:3]{index=3}
      sel.removeAllRanges();
      saved.forEach(rr => sel.addRange(rr));
      document.body.removeChild(dummy);

      if (!handled) resolve(!!ok);
    });
  }

  const imageCache = new WeakMap(); // imgEl -> { blob, dataURL }

  async function prewarmImgElement(imgEl){
    if (!imgEl || imageCache.has(imgEl)) return;
    try {
      const src = imgEl.getAttribute('src') || '';
      if (!src) return;
      const abs = src.startsWith('http') ? src : (location.origin + src);
      const origBlob = await fetch(abs, { cache: 'no-store' }).then(r => r.blob());
      const blob = await blobToPngBlob(origBlob);
      const dataURL = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload=()=>res(fr.result); fr.onerror=rej; fr.readAsDataURL(blob); });
      imageCache.set(imgEl, { blob, dataURL });
    } catch {}
  }

  /* ---------- КОПИРОВАНИЕ КАРТИНКИ ПО КЛИКУ ---------- */
  chatEl?.addEventListener('click', (e) => {
    const msg = e.target.closest('.msg.msg-image');
    if (!msg) return;
    const img = msg.querySelector('img.chat-img');
    if (!img) return;

    const src = img.getAttribute('src') || '';
    const abs = src.startsWith('http') ? src : (location.origin + src);

    // 1) Прямое выделение исходного IMG (работает по тесту)
    try {
      const sel = window.getSelection();
      const range = document.createRange();
      sel.removeAllRanges();
      range.selectNode(img);
      sel.addRange(range);
      const ok = document.execCommand('copy');
      sel.removeAllRanges();
      if (ok) {
        msg.classList.add('copied');
        setTimeout(() => msg.classList.remove('copied'), 700);
        return;
      }
    } catch {}

    // 2) Клон IMG в contentEditable (работает по тесту)
    try {
      const holder = document.createElement('div');
      holder.contentEditable = 'true';
      holder.style.position = 'fixed';
      holder.style.left = '-9999px';
      holder.style.top = '0';
      holder.style.opacity = '0';
      holder.style.pointerEvents = 'none';
      
      const ghost = img.cloneNode(true);
      ghost.alt = '';
      ghost.draggable = false;
      holder.appendChild(ghost);
      document.body.appendChild(holder);
      
      const sel = window.getSelection();
      const range = document.createRange();
      sel.removeAllRanges();
      range.selectNode(ghost);
      sel.addRange(range);
      const ok = document.execCommand('copy');
      sel.removeAllRanges();
      document.body.removeChild(holder);
      
      if (ok) {
        msg.classList.add('copied');
        setTimeout(() => msg.classList.remove('copied'), 700);
        return;
      }
    } catch {}

    // 3) oncopy с dataURL (работает по тесту)
    (async () => {
      try {
        const blob = await fetch(abs, { cache: 'no-store' }).then(r => r.blob());
        const pngBlob = await blobToPngBlob(blob);
        const dataURL = await new Promise((res, rej) => {
          const fr = new FileReader();
          fr.onload = () => res(fr.result);
          fr.onerror = rej;
          fr.readAsDataURL(pngBlob);
        });
        const ok = await copyViaOnCopy(`<img src="${dataURL}">`, '', pngBlob);
        if (ok) {
          msg.classList.add('copied');
          setTimeout(() => msg.classList.remove('copied'), 700);
          return;
        }
      } catch {}

      // Фолбэк - копируем URL
      const okUrl = await copyPlainText(abs);
      msg.classList.add(okUrl ? 'copied' : 'downloaded');
      setTimeout(() => msg.classList.remove('copied', 'downloaded'), 700);
      if (!okUrl) {
        try {
          const a = document.createElement('a');
          a.href = abs;
          a.download = abs.split('/').pop() || 'image';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
        } catch {}
      }
    })();
  });

  /* ---------- Рендер сообщений ---------- */
  function renderMsg(m) {
    const div = document.createElement('div');
    div.className = 'msg';
    const safeName = escapeHtml(m.name ?? 'Anon');
    const safeTime = fmtTime(m.time ?? Date.now());

    if (m.image) {
      const url = String(m.image);
      div.classList.add('msg-image');
      div.innerHTML = `
        <div class="head">${safeName} • ${safeTime}</div>
        <img class="chat-img" src="${url}" alt="">
      `;
      // Прогрев сразу после вставки
      const imgEl = div.querySelector('img.chat-img');
      if (imgEl) prewarmImgElement(imgEl);
    } else {
      const rawText  = String(m.text ?? '');
      let safeText   = escapeHtml(rawText);
      safeText = safeText.replace(/@([^\s:]{1,64}):/gu, '<span class="mention">@$1:</span>');
      div.title = 'Нажмите, чтобы скопировать сообщение';
      div.innerHTML = `<div class="head">${safeName} • ${safeTime}</div>${safeText}`;
      div.addEventListener('click', async () => {
        const ok = await copyPlainText(rawText);
        if (ok) { div.classList.add('copied'); setTimeout(() => div.classList.remove('copied'), 650); }
      });
    }

    chatEl.appendChild(div);
  }

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

  /* ---------- Очередь загрузок (многократные файлы) ---------- */
  const queue = [];
  let uploading = false;

  async function uploadEnqueue(files, { toChat = false } = {}) {
    if (!files || !files.length) return;
    for (const f of files) queue.push({ file: f, toChat });
    if (uploading) return;
    uploading = true;
    while (queue.length) {
      const { file, toChat: chatFlag } = queue.shift();
      await uploadOne(file, { toChat: chatFlag });
    }
    uploading = false;
  }

  // /api/upload принимает 'files' (array). Шлём по одному — проще обеспечить замену и прогресс.
  async function uploadOne(file, { toChat = false } = {}) {
    const fd = new FormData();
    fd.append('files', file, file.name);
    try {
      const r = await fetch('/api/upload?overwrite=true', { method: 'POST', body: fd });
      const j = await r.json();
      if (Array.isArray(j?.files)) {
        j.files.forEach(meta => {
          if (toChat && /^image\//i.test(meta.type || '')) {
            const name = (nameInput?.value || '').trim() || 'Anon';
            socket.emit('chat:message', { id: currentChatId, name, image: meta.url, mime: meta.type || '' });
          }
        });
      }
    } catch (e) {
      console.warn('upload error', e);
    } finally {
      // список обновится также по событиям сервера, но вручную обновим для надёжности
      loadFiles();
    }
  }

  /* ---------- Дроп/паста в поле «Сообщение» (только изображения) ---------- */
  msgInput?.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items || [];
    const files = [];
    for (const it of items) {
      if (it.kind === 'file') {
        const f = it.getAsFile();
        if (f && isImageFile(f)) files.push(f);
      }
    }
    if (files.length) {
      e.preventDefault();
      uploadEnqueue(files, { toChat: true });
    }
  });
  msgInput?.addEventListener('dragover', (e) => { e.preventDefault(); });
  msgInput?.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer?.files || []).filter(isImageFile);
    if (files.length) uploadEnqueue(files, { toChat: true });
  });

  /* ---------- Рекурсивный сбор файлов из dropzone (папки + много файлов) ---------- */
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

  /* ---------- Dropzone (общая загрузка, multiple + папки) ---------- */
  dropzone?.addEventListener('click', () => fileInput && fileInput.click());
  dropzone?.addEventListener('dragover', (e)=>{ e.preventDefault(); dropzone.classList.add('dragover'); });
  dropzone?.addEventListener('dragleave', ()=> dropzone.classList.remove('dragover'));
  dropzone?.addEventListener('drop', async (e)=> {
    e.preventDefault(); dropzone.classList.remove('dragover');
    const files = await dataTransferToFiles(e.dataTransfer);
    if (files.length) uploadEnqueue(files, { toChat: false });
  });
  fileInput?.addEventListener('change', async () => {
    const files = Array.from(fileInput.files || []);
    if (files.length) uploadEnqueue(files, { toChat: false });
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

  const MEDIA_MIN_WIDTH_PX = 110; // ширина под слово «Смотреть»

  function renderFiles(list) {
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

      // Делаем кнопку предпросмотра одинаковой ширины (как «Смотреть»)
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
    chatEl.innerHTML = '';
    msgs.forEach(renderMsg);
    chatEl.scrollTop = chatEl.scrollHeight;
    detectMentionHighlight();
    autosizeBoth();
    // Прогрев всех изображений на экране
    try { chatEl.querySelectorAll('img.chat-img').forEach(img => prewarmImgElement(img)); } catch {}
  });

  socket.on('chat:message', (m) => {
    if (Number(m?.id) !== currentChatId) return;
    renderMsg(m);
    chatEl.scrollTop = chatEl.scrollHeight;
    // Прогрев для только что пришедшего изображения
    try {
      if (m && m.image) {
        const lastImg = chatEl.querySelector('.msg.msg-image:last-child img.chat-img');
        if (lastImg) prewarmImgElement(lastImg);
      }
    } catch {}
  });

  socket.on('chat:names', (payload) => {
    if (Number(payload?.id) !== currentChatId) return;
    knownNames = Array.isArray(payload?.names) ? payload.names : [];
    detectMentionHighlight();
    if (mentionOpen) renderNamesMenu(mentionFilter);
  });

  socket.on('chat:cleared', (payload) => {
    if (Number(payload?.id) !== currentChatId) return;
    chatEl.innerHTML = '';
    knownNames = Array.isArray(payload?.names) ? payload.names : [];
    detectMentionHighlight();
    autosizeBoth();
  });

  /* ---------- Тест копирования ---------- */
  const runCopyTest = async () => {
    // Создаем тестовое изображение
    const canvas = document.createElement('canvas');
    canvas.width = 100;
    canvas.height = 100;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(0, 0, 100, 100);
    ctx.fillStyle = '#ffffff';
    ctx.font = '16px Arial';
    ctx.fillText('TEST', 30, 55);
    
    const testImg = document.createElement('img');
    testImg.src = canvas.toDataURL('image/png');
    testImg.style.position = 'fixed';
    testImg.style.left = '-9999px';
    testImg.style.top = '0';
    testImg.style.opacity = '0';
    document.body.appendChild(testImg);
    
    const results = [];
    
    // Тест 1: Прямое выделение
    try {
      const sel = window.getSelection();
      const range = document.createRange();
      sel.removeAllRanges();
      range.selectNode(testImg);
      sel.addRange(range);
      const ok = document.execCommand('copy');
      sel.removeAllRanges();
      results.push(`1. Прямое выделение: ${ok ? '✅' : '❌'}`);
    } catch (e) {
      results.push(`1. Прямое выделение: ❌ (${e.message})`);
    }
    
    // Тест 2: Клон в contentEditable
    try {
      const holder = document.createElement('div');
      holder.contentEditable = 'true';
      holder.style.position = 'fixed';
      holder.style.left = '-9999px';
      holder.style.top = '0';
      holder.style.opacity = '0';
      holder.style.pointerEvents = 'none';
      
      const ghost = testImg.cloneNode(true);
      holder.appendChild(ghost);
      document.body.appendChild(holder);
      
      const sel = window.getSelection();
      const range = document.createRange();
      sel.removeAllRanges();
      range.selectNode(ghost);
      sel.addRange(range);
      const ok = document.execCommand('copy');
      sel.removeAllRanges();
      document.body.removeChild(holder);
      results.push(`2. Клон в contentEditable: ${ok ? '✅' : '❌'}`);
    } catch (e) {
      results.push(`2. Клон в contentEditable: ❌ (${e.message})`);
    }
    
    // Тест 3: Clipboard API
    try {
      if (window.ClipboardItem && navigator.clipboard && window.isSecureContext) {
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        const item = new ClipboardItem({ 'image/png': blob });
        await navigator.clipboard.write([item]);
        results.push(`3. Clipboard API: ✅`);
      } else {
        results.push(`3. Clipboard API: ❌ (недоступен в HTTP)`);
      }
    } catch (e) {
      results.push(`3. Clipboard API: ❌ (${e.message})`);
    }
    
    // Тест 4: oncopy с dataURL
    try {
      const dataURL = canvas.toDataURL('image/png');
      const ok = await copyViaOnCopy(`<img src="${dataURL}">`, '', null);
      results.push(`4. oncopy с dataURL: ${ok ? '✅' : '❌'}`);
    } catch (e) {
      results.push(`4. oncopy с dataURL: ❌ (${e.message})`);
    }
    
    document.body.removeChild(testImg);
    
    // Показываем результаты
    alert('Результаты теста копирования:\n\n' + results.join('\n') + '\n\nПопробуйте вставить в Paint или другой редактор.');
  };

  testCopyBtn?.addEventListener('click', runCopyTest);
  testCopyBtn2?.addEventListener('click', runCopyTest);

  // старт
  loadFiles();
})();
