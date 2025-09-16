// public/client.js — ShareChat фронт
// Копирование картинки по клику по сообщению (работает на HTTP):
// A) oncopy + text/html (<img src="dataURL">)
// B) Selection API: клон <img> через hidden contentEditable
// C) Фолбэк: копируем URL
//
// Остальное: мультичаты, mentions, авто-рост (ограничение ~5 строк),
// paste/drag&drop, очередь загрузок (поле 'files'), список файлов (без картинок), тема.

(() => {
  const $ = sel => document.querySelector(sel);

  /* ---------- DOM ---------- */
  const chatEl       = $('#chat');
  const filesEl      = $('#files');
  let   nameInput    = $('#name');
  let   msgInput     = $('#message');
  const sendBtn      = $('#sendBtn');
  const dropzone     = $('#dropzone');
  const fileInput    = $('#fileInput'); // <input type="file" multiple>
  const deleteAllBtn = $('#deleteAll');
  const mentionMenu  = $('#mentionMenu');
  const themeToggle  = $('#themeToggle');

  const chatSelect   = $('#chatSelect');
  const chatAddBtn   = $('#chatAdd');
  const chatDelBtn   = $('#chatDel');
  const clearChatBtn = $('#clearChat');

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
  const LINE = 22;             // ориентировочная высота строки (px)
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

  // распознавание типов файлов по имени
  function isTextName(name=''){
    return /\.(txt|md|json|csv|log|js|ts|py|html|css|xml|yml|yaml|sh|bat|conf|ini)$/i.test(name);
  }
  function isAudioName(name=''){ return /\.(mp3|wav|ogg|m4a|flac)$/i.test(name); }
  function isVideoName(name=''){ return /\.(mp4|webm|mkv|mov)$/i.test(name); }

  // человекочитаемые размеры
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

  // oncopy (+text/html)
  function copyViaOnCopy(htmlMarkup, plain = '') {
    return new Promise((resolve) => {
      let handled = false;
      const onCopy = (ev) => {
        try {
          ev.preventDefault();
          ev.clipboardData.setData('text/html', htmlMarkup);
          ev.clipboardData.setData('text/plain', plain);
          handled = true;
          resolve(true);
        } catch { resolve(false); }
      };
      document.addEventListener('copy', onCopy, { once: true });

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
      const ok = document.execCommand('copy');
      sel.removeAllRanges();
      saved.forEach(rr => sel.addRange(rr));
      document.body.removeChild(dummy);

      if (!handled) resolve(!!ok);
    });
  }

  /* ---------- КОПИРОВАНИЕ КАРТИНКИ ПО КЛИКУ (без canvas, через fetch->FileReader) ---------- */
  chatEl?.addEventListener('click', (e) => {
    const msg = e.target.closest('.msg.msg-image');
    if (!msg) return;
    const img = msg.querySelector('img.chat-img');
    if (!img) return;

    const src = img.getAttribute('src') || '';
    const abs = src.startsWith('http') ? src : (location.origin + src);

    (async () => {
      try {
        const blob = await fetch(abs, { cache: 'no-store' }).then(r => r.blob());
        const dataURL = await new Promise((res, rej) => {
          const fr = new FileReader();
          fr.onload = () => res(fr.result);
          fr.onerror = rej;
          fr.readAsDataURL(blob);
        });
        const ok = await copyViaOnCopy(`<img src="${dataURL}">`, '');
        if (ok) {
          msg.classList.add('copied'); setTimeout(()=>msg.classList.remove('copied'), 700);
          return;
        }
      } catch(_) {}

      // Фолбэк: Selection API с клоном <img>
      const okNode = (() => {
        try {
          const holder = document.createElement('div');
          holder.contentEditable = 'true';
          Object.assign(holder.style, { position:'fixed', left:'-99999px', top:'0', opacity:'0', pointerEvents:'none' });
          const ghost = img.cloneNode(true);
          ghost.alt = ''; ghost.draggable = false;
          holder.appendChild(ghost);
          document.body.appendChild(holder);
          const sel = window.getSelection(); const range = document.createRange();
          sel.removeAllRanges(); range.selectNode(ghost); sel.addRange(range);
          const ok = document.execCommand('copy');
          sel.removeAllRanges(); document.body.removeChild(holder);
          return ok;
        } catch { return false; }
      })();
      if (okNode) {
        msg.classList.add('copied'); setTimeout(()=>msg.classList.remove('copied'), 700);
        return;
      }

      // Ещё фолбэк — просто URL
      const okUrl = await copyPlainText(abs);
      msg.classList.add(okUrl ? 'copied' : 'downloaded');
      setTimeout(()=>msg.classList.remove('copied','downloaded'), 700);
      if (!okUrl) {
        try {
          const a = document.createElement('a');
          a.href = abs; a.download = abs.split('/').pop() || 'image';
          document.body.appendChild(a); a.click(); document.body.removeChild(a);
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
  });

  socket.on('chat:message', (m) => {
    if (Number(m?.id) !== currentChatId) return;
    renderMsg(m);
    chatEl.scrollTop = chatEl.scrollHeight;
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

  /* ---------- Изображения (paste / drop в поле «Сообщение») ---------- */
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

  /* ---------- Кнопки чатов ---------- */
  chatSelect?.addEventListener('change', () => {
    setCurrentChat(Number(chatSelect.value || '1'), { emit:true, save:true });
  });

  async function deleteCurrentChatCompletely() {
    if (!confirm(`Удалить чат «${currentChatId}» полностью?`)) return;
    try { await fetch('/api/chats/'+encodeURIComponent(String(currentChatId)), { method:'DELETE' }); } catch {}
  }

  async function clearCurrentChatMessages() {
    clearChatBtn?.setAttribute('disabled','');
    try {
      const r = await fetch('/api/chats/'+encodeURIComponent(String(currentChatId))+'/messages', { method:'DELETE' });
      if (r.ok || r.status === 204) {
        chatEl.innerHTML = '';
        knownNames = [];
        detectMentionHighlight();
        autosizeBoth();
      } else {
        socket.emit('chat:clear', { id: currentChatId });
      }
    } catch {
      chatEl.innerHTML = '';
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
          <a class="btn" href="/uploads/${encodeURIComponent(f.name)}" download>Скачать</a>
          <button class="btn del" title="Удалить" aria-label="Удалить файл">🗑️</button>
        </div>
      `;
      el.querySelector('.btn.del').addEventListener('click', async () => {
        try { await fetch('/api/files/' + encodeURIComponent(f.name), { method: 'DELETE' }); }
        finally { loadFiles(); }
      });
      filesEl.appendChild(el);
    });
  }

  deleteAllBtn?.addEventListener('click', async () => {
    try { await fetch('/api/files', { method: 'DELETE' }); }
    finally { loadFiles(); }
  });

  // dropzone (общая загрузка, можно multiple)
  dropzone?.addEventListener('click', () => fileInput && fileInput.click());
  dropzone?.addEventListener('dragover', (e)=>{ e.preventDefault(); dropzone.classList.add('dragover'); });
  dropzone?.addEventListener('dragleave', ()=> dropzone.classList.remove('dragover'));
  dropzone?.addEventListener('drop', async (e)=> {
    e.preventDefault(); dropzone.classList.remove('dragover');
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length) uploadEnqueue(files, { toChat: false });
  });
  fileInput?.addEventListener('change', async () => {
    const files = Array.from(fileInput.files || []);
    if (files.length) uploadEnqueue(files, { toChat: false });
    fileInput.value = '';
  });

  /* ---------- Серверные события файлов ---------- */
  socket.on('files:update', loadFiles);
  socket.on('file:new',    loadFiles);

  // старт
  loadFiles();
})();
