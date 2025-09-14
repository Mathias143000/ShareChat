// public/client.js — мультичаты, файлы, mentions, тема (🌞/🌙 + "Тема")
// "Стереть чат" очищает ТОЛЬКО сообщения текущего чата.
(() => {
  const $ = sel => document.querySelector(sel);

  /* ---------- DOM ---------- */
  const chatEl       = $('#chat');
  const filesEl      = $('#files');
  const nameInput    = $('#name');
  const msgInput     = $('#message');
  const sendBtn      = $('#sendBtn');
  const dropzone     = $('#dropzone');
  const fileInput    = $('#fileInput');
  const deleteAllBtn = $('#deleteAll');
  const mentionMenu  = $('#mentionMenu');
  const themeToggle  = $('#themeToggle');

  // управление чатами
  const chatSelect   = $('#chatSelect');
  const chatAddBtn   = $('#chatAdd');
  const chatDelBtn   = $('#chatDel');     // маленькая "−" — удалить чат (весь)
  const clearChatBtn = $('#clearChat');   // большая справа — стереть СООБЩЕНИЯ

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

  /* ---------- ЖЁСТКО фиксируем раскладку формы (кнопка под обоими полями) ---------- */
  const form = $('#chatForm');
  if (form) {
    form.style.display = 'grid';
    form.style.gridTemplateColumns = '160px 1fr';
    form.style.gridTemplateAreas = '"name msg" "send send"';
    form.style.gap = '8px';
  }
  if (nameInput) {
    nameInput.classList.add('name-input');
    nameInput.style.gridArea = 'name';
  }
  if (msgInput) {
    msgInput.classList.add('message-input');
    msgInput.style.gridArea = 'msg';
  }
  if (sendBtn) {
    sendBtn.classList.add('send-btn');
    sendBtn.style.gridArea = 'send';
    sendBtn.style.width = '100%';
  }

  /* ---------- Авто-рост textarea + связка высот с «Имя» ---------- */
  // Лимит роста (должен совпадать с CSS, но тут задаём принудительно)
  const MAX_MSG_H = 200;

  // Стартуем строго с одной строки, даже если в HTML rows="3"
  if (msgInput) {
    try { msgInput.setAttribute('rows', '1'); } catch {}
    // гарантируем минимальную однострочную высоту
    msgInput.style.minHeight = '36px';
  }
  if (nameInput) {
    nameInput.style.minHeight = '36px';
  }

  const px = v => {
    const n = parseFloat(v); return Number.isFinite(n) ? n : 0;
  };

  function syncNameHeight(h) {
    if (!nameInput) return;
    nameInput.style.height = h + 'px';
    // Центровка текста/плейсхолдера у input "Имя"
    const cs = getComputedStyle(nameInput);
    const inner = Math.max(16, h - px(cs.paddingTop) - px(cs.paddingBottom));
    nameInput.style.lineHeight = inner + 'px';
  }

  function autosizeMessage() {
    if (!msgInput) return;

    const cs = getComputedStyle(msgInput);
    const minH = Math.max(36, px(cs.minHeight));
    const padV = px(cs.paddingTop) + px(cs.paddingBottom);

    // Сброс на авто и измерение фактической высоты
    msgInput.style.height = 'auto';
    let needed = Math.max(msgInput.scrollHeight, minH);

    // Однострочный режим?
    const isOneLine = needed <= minH + 1;

    if (isOneLine) {
      // Выравниваем плейсхолдер как у input: точный line-height = внутренняя высота
      const inner = Math.max(16, minH - padV);
      msgInput.style.lineHeight = inner + 'px';
      msgInput.style.overflowY  = 'hidden';
      needed = minH;
    } else {
      // Многострочный режим — нормальный line-height и рост до лимита
      msgInput.style.lineHeight = '';
      needed = Math.min(needed, MAX_MSG_H);
      msgInput.style.overflowY  = (msgInput.scrollHeight > MAX_MSG_H) ? 'auto' : 'hidden';
    }

    msgInput.style.height = needed + 'px';
    syncNameHeight(needed);
  }

  // Инициализация авто-роста и синхронизации высот
  if (msgInput) {
    // первый рендер после размещения на странице
    requestAnimationFrame(autosizeMessage);
    msgInput.addEventListener('input', autosizeMessage, { passive: true });
    window.addEventListener('resize', autosizeMessage);
  }

  /* ---------- Чаты: состояние и helpers ---------- */
  let currentChatId = Number(localStorage.getItem('chatId') || '1') || 1;
  let knownNames = [];

  function setCurrentChat(id, { emit=true, save=true } = {}) {
    id = Number(id) || 1;
    currentChatId = id;
    if (save) { try { localStorage.setItem('chatId', String(id)); } catch {} }
    if (chatSelect) chatSelect.value = String(id);
    if (emit) socket.emit('chat:select', { id });
    if (chatEl) chatEl.innerHTML = '';
    autosizeMessage();
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

  /* ---------- Рендер сообщений ---------- */
  function renderMsg(m) {
    const div = document.createElement('div');
    div.className = 'msg';
    div.title = 'Нажмите, чтобы скопировать сообщение';

    const safeName = escapeHtml(m.name ?? 'Anon');
    const safeTime = fmtTime(m.time ?? Date.now());
    const rawText  = String(m.text ?? '');
    let safeText   = escapeHtml(rawText);

    // подсветка @Никнейм:
    safeText = safeText.replace(/@([^\s:]{1,64}):/gu, '<span class="mention">@$1:</span>');

    div.innerHTML = `<div class="head">${safeName} • ${safeTime}</div>${safeText}`;
    div.addEventListener('click', async () => {
      const ok = await copyPlainText(rawText);
      if (ok) { div.classList.add('copied'); setTimeout(() => div.classList.remove('copied'), 650); }
    });
    chatEl.appendChild(div);
  }

  /* ---------- Mentions (ввод) ---------- */
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
    const val = msgInput.value; const caret = msgInput.selectionStart ?? val.length; const upto = val.slice(0, caret);
    const at = upto.lastIndexOf('@');
    if (at >= 0) {
      const before = val.slice(0, at), after = val.slice(caret);
      const mention='@'+nm+(withColon?': ':' ');
      msgInput.value = before+mention+after;
      const pos=(before+mention).length; msgInput.setSelectionRange(pos,pos);
      detectMentionHighlight(); autosizeMessage();
    }
  }
  function detectMentionHighlight(){
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
    autosizeMessage();
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
    autosizeMessage();
  });

  /* ---------- Отправка ---------- */
  function sendCurrentMessage() {
    const name = (nameInput?.value || '').trim() || 'Anon';
    const text = (msgInput?.value || '').trim();
    if (!text) return;
    if (sendBtn) sendBtn.disabled = true;
    socket.emit('chat:message', { id: currentChatId, name, text });
    if (msgInput) msgInput.value = '';
    detectMentionHighlight();
    autosizeMessage();
    setTimeout(() => { if (sendBtn) sendBtn.disabled = false; }, 50);
  }
  $('#chatForm')?.addEventListener('submit', (e) => { e.preventDefault(); sendCurrentMessage(); });

  // Enter — отправка; Shift+Enter — перенос; Enter при открытом меню — подстановка
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
    autosizeMessage();
    const caret = msgInput.selectionStart || msgInput.value.length;
    const upto = msgInput.value.slice(0, caret);
    const at = upto.lastIndexOf('@');
    if (at >= 0) {
      const afterAt = upto.slice(at+1);
      if (/^[^\s@]{0,32}$/.test(afterAt)) { openMentionMenu(afterAt); return; }
    }
    closeMentionMenu();
  });

  msgInput?.addEventListener('keydown', (e) => {
    if (!mentionOpen) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); mentionIndex = Math.min(mentionIndex+1, Math.max(0, (mentionMenu?.children.length||1)-1)); renderNamesMenu(mentionFilter); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); mentionIndex = Math.max(0, mentionIndex-1); renderNamesMenu(mentionFilter); }
    else if (e.key === 'Escape') { closeMentionMenu(); }
  });

  document.addEventListener('click', (e) => {
    if (!mentionOpen) return;
    if (!mentionMenu?.contains(e.target) && e.target !== msgInput) closeMentionMenu();
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
        autosizeMessage();
      } else {
        socket.emit('chat:clear', { id: currentChatId });
      }
    } catch {
      chatEl.innerHTML = '';
      knownNames = [];
      detectMentionHighlight();
      autosizeMessage();
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

  /* ---------- Files ---------- */
  async function loadFiles() {
    try {
      const r = await fetch('/api/files');
      const j = await r.json();
      if (!j.ok) throw new Error(j.error||'err');
      renderFiles(j.files||[]);
    } catch {}
  }

  function renderFiles(list) {
    filesEl.innerHTML = '';
    list.forEach(f => {
      const el = document.createElement('div');
      el.className = 'file';
      el.innerHTML = `
        <div>
          <div class="name">${escapeHtml(f.name)}</div>
          <div class="meta">${(f.size||0).toLocaleString()} байт • ${fmtTime(f.mtime)}</div>
        </div>
        <div class="actions">
          <a class="btn" href="/preview/${encodeURIComponent(f.name)}" target="_blank" rel="noopener">Предпросмотр</a>
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

  // dropzone
  dropzone?.addEventListener('click', () => fileInput && fileInput.click());
  dropzone?.addEventListener('dragover', (e)=>{ e.preventDefault(); dropzone.classList.add('dragover'); });
  dropzone?.addEventListener('dragleave', ()=> dropzone.classList.remove('dragover'));
  dropzone?.addEventListener('drop', async (e)=> {
    e.preventDefault(); dropzone.classList.remove('dragover');
    const file = e.dataTransfer.files?.[0]; if (file) await upload(file);
  });

  fileInput?.addEventListener('change', async () => {
    const file = fileInput.files?.[0]; if (file) await upload(file);
    fileInput.value = '';
  });

  async function upload(file) {
    const fd = new FormData(); fd.append('file', file);
    try {
      const r = await fetch('/api/upload', { method: 'POST', body: fd });
      const j = await r.json(); if (!j.ok) throw new Error(j.error||'upload failed');
    } finally {
      loadFiles();
    }
  }

  // старт
  socket.on('files:update', loadFiles);
  loadFiles();
})();
