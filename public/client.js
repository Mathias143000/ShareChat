// public/client.js — мультичаты, файлы, mentions, тема (🌞/🌙 + "Тема")
// "Стереть чат" — очищает ТОЛЬКО сообщения текущего чата.
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
  const chatDelBtn   = $('#chatDel');     // маленькая "−" — удалить чат полностью
  const clearChatBtn = $('#clearChat');   // кнопка справа — СТЕРЕТЬ СООБЩЕНИЯ

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

  /* ---------- Авто-рост ОБОИХ полей и синхронизация высоты (макс. 5 строк) ---------- */
  const MIN_H    = 36;  // нативная "одна строка"
  const MAX_ROWS = 5;   // максимум строк при росте

  const px = v => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  };

  function rowHeight(el) {
    const cs = getComputedStyle(el);
    let lh = parseFloat(cs.lineHeight);
    if (!Number.isFinite(lh)) {
      const fs = parseFloat(cs.fontSize) || 16;
      lh = fs * 1.35;
    }
    return lh;
  }

  function measure(el) {
    if (!el) return null;
    const cs   = getComputedStyle(el);
    const padV = px(cs.paddingTop) + px(cs.paddingBottom);
    const minH = Math.max(MIN_H, px(cs.minHeight));
    const maxH = padV + rowHeight(el) * MAX_ROWS;

    const prevH = el.style.height;
    el.style.height = 'auto';
    const scrollH = el.scrollHeight;
    el.style.height = prevH;

    let needed = Math.max(scrollH, minH);
    const oneLine = needed <= minH + 1;
    if (!oneLine) needed = Math.min(needed, maxH);

    return { el, minH, maxH, padV, scrollH, needed, oneLine };
  }

  function apply(el, targetH, meta) {
    if (!el || !meta) return;
    const isOne = targetH <= meta.minH + 1;
    if (isOne) {
      const inner = Math.max(16, meta.minH - meta.padV);
      el.style.lineHeight = inner + 'px';
      el.style.overflowY  = 'hidden';
    } else {
      el.style.lineHeight = ''; // вернём нормальную межстрочку
      el.style.overflowY  = (meta.scrollH > meta.maxH) ? 'auto' : 'hidden';
    }
    el.style.height = targetH + 'px';
  }

  function autosizeBoth() {
    const m = measure(msgInput);
    const n = measure(nameInput);
    const hardMax = Math.min(m?.maxH ?? Infinity, n?.maxH ?? Infinity);
    const target  = Math.min(Math.max(m?.needed || MIN_H, n?.needed || MIN_H), hardMax);
    if (n) apply(nameInput, target, n);
    if (m) apply(msgInput,  target, m);
  }

  autosizeBoth();
  window.addEventListener('resize', autosizeBoth);
  nameInput?.addEventListener('input', autosizeBoth, { passive: true });
  msgInput?.addEventListener('input',  autosizeBoth, { passive: true });

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
      detectMentionHighlight(); autosizeBoth();
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
    chatEl.innerHTML = ''; msgs.forEach(renderMsg);
    chatEl.scrollTop = chatEl.scrollHeight;
    detectMentionHighlight(); autosizeBoth();
  });

  socket.on('chat:message', (m) => {
    if (Number(m?.id) !== currentChatId) return;
    renderMsg(m); chatEl.scrollTop = chatEl.scrollHeight;
  });

  socket.on('chat:names', (payload) => {
    if (Number(payload?.id) !== currentChatId) return;
    knownNames = Array.isArray(payload?.names) ? payload.names : [];
    detectMentionHighlight(); if (mentionOpen) renderNamesMenu(mentionFilter);
  });

  socket.on('chat:cleared', (payload) => {
    if (Number(payload?.id) !== currentChatId) return;
    chatEl.innerHTML = ''; knownNames = Array.isArray(payload?.names) ? payload.names : [];
    detectMentionHighlight(); autosizeBoth();
  });

  /* ---------- Отправка ---------- */
  function sendCurrentMessage() {
    const name = (nameInput?.value || '').trim() || 'Anon';
    const text = (msgInput?.value || '').trim();
    if (!text) return;
    sendBtn && (sendBtn.disabled = true);
    socket.emit('chat:message', { id: currentChatId, name, text });
    if (msgInput) msgInput.value = '';
    detectMentionHighlight(); autosizeBoth();
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
        closeMentionMenu(); return;
      }
      e.preventDefault(); sendCurrentMessage();
    }
  });
  msgInput?.addEventListener('input', () => {
    detectMentionHighlight(); autosizeBoth();
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
        chatEl.innerHTML = ''; knownNames = []; detectMentionHighlight(); autosizeBoth();
      } else { socket.emit('chat:clear', { id: currentChatId }); }
    } catch {
      chatEl.innerHTML = ''; knownNames = []; detectMentionHighlight(); autosizeBoth();
    } finally { clearChatBtn?.removeAttribute('disabled'); }
  }
  chatAddBtn?.addEventListener('click',  async () => {
    try { const r = await fetch('/api/chats', { method:'POST' }); const j = await r.json(); if (j?.ok && j?.id) setCurrentChat(Number(j.id), { emit:true, save:true }); } catch {}
  });
  chatDelBtn?.addEventListener('click',  () => deleteCurrentChatCompletely());
  clearChatBtn?.addEventListener('click', (e) => { e.preventDefault(); clearCurrentChatMessages(); });

  /* ---------- Files ---------- */
  async function loadFiles() {
    try { const r = await fetch('/api/files'); const j = await r.json(); if (!j.ok) throw new Error(j.error||'err'); renderFiles(j.files||[]); } catch {}
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
  deleteAllBtn?.addEventListener('click', async () => { try { await fetch('/api/files', { method: 'DELETE' }); } finally { loadFiles(); } });

  // dropzone
  dropzone?.addEventListener('click', () => fileInput && fileInput.click());
  dropzone?.addEventListener('dragover', (e)=>{ e.preventDefault(); dropzone.classList.add('dragover'); });
  dropzone?.addEventListener('dragleave', ()=> dropzone.classList.remove('dragover'));
  dropzone?.addEventListener('drop', async (e)=> {
    e.preventDefault(); dropzone.classList.remove('dragover');
    const file = e.dataTransfer.files?.[0]; if (file) await upload(file);
  });
  fileInput?.addEventListener('change', async () => { const file = fileInput.files?.[0]; if (file) await upload(file); fileInput.value = ''; });
  async function upload(file) {
    const fd = new FormData(); fd.append('file', file);
    try { const r = await fetch('/api/upload', { method: 'POST', body: fd }); const j = await r.json(); if (!j.ok) throw new Error(j.error||'upload failed'); }
    finally { loadFiles(); }
  }

  // старт
  socket.on('files:update', loadFiles);
  loadFiles();
})();
