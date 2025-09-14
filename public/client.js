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

  // новое для чатов
  const chatSelect   = $('#chatSelect');
  const chatAddBtn   = $('#chatAdd');
  const chatDelBtn   = $('#chatDel');

  /* ---------- socket ---------- */
  const socket = io({ path: '/socket.io' });

  /* ---------- theme (эмодзи + "Тема") ---------- */
  const html = document.documentElement;
  const sysPrefDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const savedTheme = localStorage.getItem('theme');
  const initial = (savedTheme === 'dark' || savedTheme === 'light') ? savedTheme : (sysPrefDark ? 'dark' : 'light');
  html.setAttribute('data-theme', initial);
  function updateThemeBtn() {
    const cur = html.getAttribute('data-theme') || 'light';
    const icon = (cur === 'light') ? '🌞' : '🌙';
    themeToggle.innerHTML = `<span class="icon" aria-hidden="true">${icon}</span><span class="label">Тема</span>`;
    themeToggle.setAttribute('aria-label', 'Переключить тему');
    themeToggle.setAttribute('title', 'Переключить тему');
  }
  updateThemeBtn();
  themeToggle.addEventListener('click', () => {
    const cur = html.getAttribute('data-theme') || 'light';
    const next = (cur === 'light') ? 'dark' : 'light';
    html.setAttribute('data-theme', next);
    localStorage.setItem('theme', next);
    updateThemeBtn();
  });

  /* ---------- chat state ---------- */
  let currentChatId = Number(localStorage.getItem('chatId') || '1') || 1;
  let knownNames = []; // для подсветки @

  function setCurrentChat(id, { emit=true, save=true } = {}) {
    id = Number(id) || 1;
    currentChatId = id;
    if (save) { try { localStorage.setItem('chatId', String(id)); } catch {} }
    if (chatSelect) chatSelect.value = String(id);
    if (emit) socket.emit('chat:select', { id });
    chatEl.innerHTML = '';
  }

  function rebuildChatSelect(ids) {
    if (!chatSelect) return;
    const old = Number(chatSelect.value || currentChatId || 1);
    chatSelect.innerHTML = ids.map(id => `<option value="${id}">${id}</option>`).join('');
    // если текущего нет — переключаемся на предыдущий по номеру (или минимальный)
    let next = old;
    if (!ids.includes(old)) {
      const lower = ids.filter(n => n < old);
      next = lower.length ? lower[lower.length - 1] : (ids[0] || 1);
    }
    setCurrentChat(next, { emit:true, save:true });
  }

  /* ---------- utils ---------- */
  const fmtTime = t => new Date(t).toLocaleString();
  const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  /* ---------- render messages ---------- */
  function renderMsg(m) {
    const div = document.createElement('div');
    div.className = 'msg';
    const safeName = escapeHtml(m.name ?? 'Anon');
    const safeText = escapeHtml(m.text ?? '');
    const safeTime = fmtTime(m.time ?? Date.now());
    div.innerHTML = `<div class="head">${safeName} • ${safeTime}</div>${safeText}`;
    div.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(m.text || ''); div.classList.add('copied'); setTimeout(()=>div.classList.remove('copied'), 650); } catch {}
    });
    chatEl.appendChild(div);
  }

  /* ---------- mentions ---------- */
  let mentionIndex = 0;
  let mentionOpen = false;
  let mentionFilter = '';
  function renderNamesMenu(filter='') {
    const q = filter.trim().toLowerCase();
    const list = (knownNames || []).filter(n => n.toLowerCase().includes(q)).slice(0, 20);
    mentionMenu.innerHTML = list.map((n,i)=>`<div class="mention-item ${i===mentionIndex?'active':''}" data-name="${n}">@${escapeHtml(n)}</div>`).join('') || `<div class="mention-item muted">Нет совпадений</div>`;
    mentionMenu.querySelectorAll('.mention-item').forEach((el) => {
      const nm = el.getAttribute('data-name');
      if (!nm) return;
      el.addEventListener('mousedown', (e) => { e.preventDefault(); insertMention(nm, true); closeMentionMenu(); });
    });
  }
  function openMentionMenu(filter='') { mentionFilter = filter; mentionIndex = 0; mentionOpen = true; mentionMenu.hidden = false; renderNamesMenu(filter); }
  function closeMentionMenu() { mentionOpen = false; mentionMenu.hidden = true; }
  function insertMention(nm, withColon=false) {
    const val = msgInput.value;
    const caret = msgInput.selectionStart ?? val.length;
    const upto = val.slice(0, caret);
    const at = upto.lastIndexOf('@');
    if (at >= 0) {
      const before = val.slice(0, at);
      const after = val.slice(caret);
      const mention = '@' + nm + (withColon ? ': ' : ' ');
      msgInput.value = before + mention + after;
      const pos = (before + mention).length;
      msgInput.setSelectionRange(pos, pos);
      detectMentionHighlight();
    }
  }
  function detectMentionHighlight() {
    const val = msgInput.value;
    const has = (knownNames||[]).some(n => new RegExp(`@${n}\\b`).test(val));
    msgInput.classList.toggle('has-mention', has);
  }

  /* ---------- socket: списки, init, сообщения ---------- */
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
  });

  socket.on('chat:message', (m) => {
    if (Number(m?.id) !== currentChatId) return;
    renderMsg(m); chatEl.scrollTop = chatEl.scrollHeight;
  });

  socket.on('chat:names', (payload) => {
    if (Number(payload?.id) !== currentChatId) return;
    knownNames = Array.isArray(payload?.names) ? payload.names : [];
    detectMentionHighlight();
    if (mentionOpen) renderNamesMenu(mentionFilter);
  });

  /* ---------- отправка сообщений ---------- */
  function sendCurrentMessage() {
    const name = (nameInput.value || '').trim() || 'Anon';
    const text = (msgInput.value || '').trim();
    if (!text) return;
    sendBtn.disabled = true;
    socket.emit('chat:message', { id: currentChatId, name, text });
    msgInput.value = '';
    detectMentionHighlight();
    setTimeout(() => { sendBtn.disabled = false; }, 50);
  }
  $('#chatForm').addEventListener('submit', (e) => { e.preventDefault(); sendCurrentMessage(); });

  // Enter — отправка; Shift+Enter — перенос; Enter при меню — подстановка
  msgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      if (mentionOpen) {
        e.preventDefault();
        const active = mentionMenu.querySelector('.mention-item.active');
        const nm = active?.getAttribute('data-name') ||
          ((knownNames||[]).find(n => n.toLowerCase().includes((mentionFilter||'').toLowerCase())) || '');
        if (nm) insertMention(nm, true);
        closeMentionMenu();
        return;
      }
      e.preventDefault(); sendCurrentMessage();
    }
  });
  msgInput.addEventListener('input', () => {
    detectMentionHighlight();
    const caret = msgInput.selectionStart || msgInput.value.length;
    const upto = msgInput.value.slice(0, caret);
    const at = upto.lastIndexOf('@');
    if (at >= 0) {
      const afterAt = upto.slice(at+1);
      if (/^[^\s@]{0,32}$/.test(afterAt)) { openMentionMenu(afterAt); return; }
    }
    closeMentionMenu();
  });
  msgInput.addEventListener('keydown', (e) => {
    if (!mentionOpen) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); mentionIndex = Math.min(mentionIndex+1, Math.max(0, mentionMenu.children.length-1)); renderNamesMenu(mentionFilter); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); mentionIndex = Math.max(0, mentionIndex-1); renderNamesMenu(mentionFilter); }
    else if (e.key === 'Escape') { closeMentionMenu(); }
  });
  document.addEventListener('click', (e) => {
    if (!mentionOpen) return;
    if (!mentionMenu.contains(e.target) && e.target !== msgInput) closeMentionMenu();
  });

  /* ---------- селектор и кнопки чатов ---------- */
  if (chatSelect) chatSelect.addEventListener('change', () => {
    setCurrentChat(Number(chatSelect.value || '1'), { emit:true, save:true });
  });
  if (chatAddBtn) chatAddBtn.addEventListener('click', async () => {
    try {
      const r = await fetch('/api/chats', { method:'POST' });
      const j = await r.json();
      if (j?.ok && j?.id) setCurrentChat(Number(j.id), { emit:true, save:true });
    } catch {}
  });
  if (chatDelBtn) chatDelBtn.addEventListener('click', async () => {
    try {
      await fetch('/api/chats/' + encodeURIComponent(String(currentChatId)), { method:'DELETE' });
      // сервер пришлёт chats:list → выполним переключение на предыдущий
    } catch {}
  });

  /* ---------- files ---------- */
  async function loadFiles() {
    try {
      const r = await fetch('/api/files'); const j = await r.json();
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
          <button class="btn del" title="Удалить">🗑</button>
        </div>
      `;
      el.querySelector('.btn.del').addEventListener('click', async () => {
        try { await fetch('/api/files/' + encodeURIComponent(f.name), { method: 'DELETE' }); }
        finally { loadFiles(); }
      });
      filesEl.appendChild(el);
    });
  }

  // dropzone
  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('dragover', (e)=>{ e.preventDefault(); dropzone.classList.add('dragover'); });
  dropzone.addEventListener('dragleave', ()=> dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', async (e)=> {
    e.preventDefault(); dropzone.classList.remove('dragover');
    const file = e.dataTransfer.files?.[0]; if (file) await upload(file);
  });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0]; if (file) await upload(file);
    fileInput.value = '';
  });
  async function upload(file) {
    const fd = new FormData(); fd.append('file', file);
    try {
      const r = await fetch('/api/upload', { method: 'POST', body: fd });
      const j = await r.json(); if (!j.ok) throw new Error(j.error||'upload failed');
    } finally { loadFiles(); }
  }

  // старт
  socket.on('files:update', loadFiles);
  loadFiles();
})();
