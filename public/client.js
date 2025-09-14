(() => {
  const $ = sel => document.querySelector(sel);
  const chatEl = $('#chat');
  const filesEl = $('#files');
  const filesStatus = $('#filesStatus');
  const nameInput = $('#name');
  const msgInput = $('#message');
  const sendBtn = $('#sendBtn');
  const clearChatBtn = $('#clearChat');
  const dropzone = $('#dropzone');
  const fileInput = $('#fileInput');
  const deleteAllBtn = $('#deleteAll');
  const mentionMenu = $('#mentionMenu');
  const themeToggle = $('#themeToggle');

  const socket = io({ path: '/socket.io' });

  let names = [];
  let mentionIndex = 0;
  let mentionOpen = false;
  let mentionFilter = '';

  /* ---------- theme ---------- */
  const html = document.documentElement;
  const savedTheme = localStorage.getItem('theme');
  if (savedTheme === 'dark' || savedTheme === 'light') html.setAttribute('data-theme', savedTheme);
  const updateThemeBtn = () => { themeToggle.textContent = 'Тема'; };
  updateThemeBtn();
  themeToggle.addEventListener('click', () => {
    const cur = html.getAttribute('data-theme') || 'light';
    const next = cur === 'light' ? 'dark' : 'light';
    html.setAttribute('data-theme', next);
    localStorage.setItem('theme', next);
    updateThemeBtn();
  });

  /* ---------- helpers ---------- */
  const fmtTime = t => new Date(t).toLocaleString();
  const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  function renderMsg(m) {
    const div = document.createElement('div');
    div.className = 'msg';
    div.innerHTML = `<div class="head">${escapeHtml(m.name)} • ${fmtTime(m.time)}</div>${escapeHtml(m.text)}`;
    div.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(m.text); div.classList.add('copied'); setTimeout(()=>div.classList.remove('copied'), 650); } catch {}
    });
    chatEl.appendChild(div);
  }

  function renderNamesMenu(filter='') {
    const q = filter.trim().toLowerCase();
    const list = names.filter(n => n.toLowerCase().includes(q)).slice(0, 20);
    mentionMenu.innerHTML = list.map((n,i)=>`<div class="mention-item ${i===mentionIndex?'active':''}" data-name="${n}">@${escapeHtml(n)}</div>`).join('') || `<div class="mention-item muted">Нет совпадений</div>`;
    mentionMenu.querySelectorAll('.mention-item').forEach((el) => {
      const nm = el.getAttribute('data-name');
      if (!nm) return;
      el.addEventListener('mousedown', (e) => { e.preventDefault(); insertMention(nm, true); closeMentionMenu(); });
    });
  }
  function openMentionMenu(filter='') {
    mentionFilter = filter; mentionIndex = 0; mentionOpen = true;
    mentionMenu.hidden = false; renderNamesMenu(filter);
  }
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
    const has = names.some(n => new RegExp(`@${n}\\b`).test(val));
    msgInput.classList.toggle('has-mention', has);
  }

  /* ---------- socket: chat ---------- */
  socket.on('init', (payload) => {
    chatEl.innerHTML = '';
    const msgs = Array.isArray(payload) ? payload : (payload?.messages || []);
    names = payload?.names || [];
    msgs.forEach(renderMsg);
    chatEl.scrollTop = chatEl.scrollHeight;
  });
  socket.on('chat', (m) => { renderMsg(m); chatEl.scrollTop = chatEl.scrollHeight; });
  socket.on('chat:clear', () => { chatEl.innerHTML = ''; });
  socket.on('names', (arr) => {
    names = Array.isArray(arr) ? arr : [];
    detectMentionHighlight();
    if (mentionOpen) renderNamesMenu(mentionFilter);
  });

  /* ---------- отправка ---------- */
  function sendCurrentMessage() {
    const name = (nameInput.value || '').trim() || 'Anon';
    const text = (msgInput.value || '').trim();
    if (!text) return;
    sendBtn.disabled = true;
    socket.emit('chat', { name, text });
    msgInput.value = '';
    detectMentionHighlight();
    setTimeout(() => { sendBtn.disabled = false; }, 50);
  }

  // submit кнопкой тоже отправляет
  $('#chatForm').addEventListener('submit', (e) => { e.preventDefault(); sendCurrentMessage(); });

  // Enter — отправка, Shift+Enter — перенос
  // При открытом меню упоминаний Enter подставляет "@Ник: " без отправки
  msgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      if (mentionOpen) {
        e.preventDefault();
        const active = mentionMenu.querySelector('.mention-item.active');
        const nm = active?.getAttribute('data-name') ||
          (names.find(n => n.toLowerCase().includes((mentionFilter||'').toLowerCase())) || '');
        if (nm) insertMention(nm, true);
        closeMentionMenu();
        return;
      }
      e.preventDefault();
      sendCurrentMessage();
      return;
    }
  });

  /* ---------- mentions open/nav ---------- */
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

  /* ---------- files ---------- */
  async function loadFiles() {
    filesStatus.textContent = 'Загрузка...';
    try {
      const r = await fetch('/api/files'); const j = await r.json();
      if (!j.ok) throw new Error(j.error||'err');
      renderFiles(j.files||[]);
      filesStatus.textContent = j.files?.length ? `${j.files.length} шт.` : 'пусто';
    } catch {
      filesStatus.textContent = 'Ошибка загрузки';
    }
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
        try { await fetch('/api/files/' + encodeURIComponent(f.name), { method: 'DELETE' }); } catch {}
      });
      filesEl.appendChild(el);
    });
  }

  deleteAllBtn.addEventListener('click', async () => {
    if (!confirm('Удалить все файлы?')) return;
    try { await fetch('/api/files', { method: 'DELETE' }); } catch {}
  });

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
      filesStatus.textContent = 'Загрузка файла...';
      const r = await fetch('/api/upload', { method: 'POST', body: fd });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error||'upload failed');
      filesStatus.textContent = 'Готово';
    } catch {
      filesStatus.textContent = 'Ошибка загрузки';
    }
  }

  // realtime files refresh
  socket.on('files:update', loadFiles);
  loadFiles();
})();
