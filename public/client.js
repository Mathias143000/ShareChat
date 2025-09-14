/* =========================
   ShareChat – client.js (full)
   ========================= */

   (function () {
    /* ---------- Helpers ---------- */
    const $ = (sel, root = document) => root.querySelector(sel);
    const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
    const q = (options) => {
      // ищем по первому найденному селектору из списка
      for (const sel of options) {
        const el = $(sel);
        if (el) return el;
      }
      return null;
    };
  
    /* ---------- DOM refs (универсальные селекторы) ---------- */
    const nameField = q(['#name', '#username', 'input[name="name"]', '.input-name']);
    const msgField  = q(['#message', '#msg', 'textarea[name="message"]', '.textarea-message']);
    const sendBtn   = q(['#send', '#sendBtn', '.btn-send', '[data-action="send"]']);
    const messagesEl= q(['#messages', '.messages', '#chat-messages']);
    const formEl    = q(['#composerForm', '.composer', 'form#composer', 'form[data-role="composer"]']);
  
    /* ---------- Socket.IO ---------- */
    let socket = null;
    try {
      // /socket.io транспорт по умолчанию
      socket = io();
    } catch (e) {
      console.warn('Socket.IO is not available yet. Make sure socket.io.min.js is loaded.');
    }
  
    /* ---------- State ---------- */
    const state = {
      users: new Set(),   // имена, замеченные в чате
      mention: {
        open: false,
        anchorIndex: -1, // индекс '@' в тексте
        query: '',
        menuEl: null,
        items: [],
        activeIndex: 0,
      }
    };
  
    /* ---------- Height sync & autosize ---------- */
    function autosize(el) {
      if (!el) return;
      el.style.height = 'auto';
      // не выше 40% окна — удобно в маленьких экранах
      const maxPx = Math.round(window.innerHeight * 0.4);
      el.style.height = Math.min(el.scrollHeight, maxPx) + 'px';
    }
  
    function syncBaseHeight() {
      if (!msgField) return;
      const cs = getComputedStyle(msgField);
      const line = parseFloat(cs.lineHeight);
      const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      const brdY = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
      const one = Math.ceil(line + padY + brdY);
      document.documentElement.style.setProperty('--input-h', one + 'px');
  
      if (nameField) nameField.style.height = 'var(--input-h)';
      msgField.style.minHeight = 'var(--input-h)';
      autosize(msgField);
    }
  
    /* ---------- Mentions UI ---------- */
    function ensureMentionMenu() {
      if (state.mention.menuEl) return state.mention.menuEl;
      const el = document.createElement('div');
      el.className = 'mention-menu card';
      Object.assign(el.style, {
        position: 'absolute',
        zIndex: 999,
        minWidth: '180px',
        maxHeight: '220px',
        overflowY: 'auto',
        borderRadius: '12px',
        border: '1px solid var(--border)',
        background: 'var(--card)',
        boxShadow: 'var(--shadow)',
        padding: '6px',
        display: 'none'
      });
      document.body.appendChild(el);
      state.mention.menuEl = el;
      return el;
    }
  
    function closeMention() {
      state.mention.open = false;
      state.mention.anchorIndex = -1;
      state.mention.query = '';
      state.mention.items = [];
      state.mention.activeIndex = 0;
      if (state.mention.menuEl) state.mention.menuEl.style.display = 'none';
      if (msgField) msgField.classList.remove('mentioning');
    }
  
    function openMention(anchorIndex) {
      state.mention.open = true;
      state.mention.anchorIndex = anchorIndex;
      state.mention.query = '';
      state.mention.activeIndex = 0;
      renderMentionMenu();
      if (msgField) msgField.classList.add('mentioning');
    }
  
    function getCaretClientRect(textarea) {
      // простая оценка позиции меню — возле нижнего края поля
      const r = textarea.getBoundingClientRect();
      return { left: r.left + 16, top: r.bottom - 8 };
    }
  
    function updateMentionCandidates() {
      const q = state.mention.query.toLowerCase();
      const all = Array.from(state.users).sort((a, b) => a.localeCompare(b, 'ru'));
      state.mention.items = all.filter(n => n.toLowerCase().includes(q)).slice(0, 30);
      if (state.mention.activeIndex >= state.mention.items.length) {
        state.mention.activeIndex = 0;
      }
    }
  
    function renderMentionMenu() {
      const menu = ensureMentionMenu();
      updateMentionCandidates();
      if (!state.mention.open || state.mention.items.length === 0) {
        menu.style.display = 'none';
        return;
      }
      menu.innerHTML = '';
      state.mention.items.forEach((name, i) => {
        const item = document.createElement('div');
        item.textContent = name;
        item.className = 'mention-item';
        Object.assign(item.style, {
          padding: '8px 10px',
          borderRadius: '8px',
          cursor: 'pointer',
          border: '1px solid transparent',
          userSelect: 'none'
        });
        if (i === state.mention.activeIndex) {
          item.style.background = 'var(--hover-bg)';
          item.style.borderColor = 'var(--hover-border)';
        }
        item.addEventListener('mousemove', () => {
          state.mention.activeIndex = i;
          renderMentionMenu();
        });
        item.addEventListener('mousedown', (e) => {
          e.preventDefault();
          applyMention(name);
        });
        menu.appendChild(item);
      });
  
      const pos = getCaretClientRect(msgField);
      menu.style.left = `${pos.left}px`;
      menu.style.top  = `${pos.top}px`;
      menu.style.display = 'block';
    }
  
    function applyMention(selectedName) {
      const t = msgField.value;
      const a = state.mention.anchorIndex;
      if (a < 0) return closeMention();
  
      // Найти конец текущего слова после '@'
      const after = t.slice(a + 1);
      const m = after.match(/^[^\s:.,!?)]*/);
      const wordLen = m ? m[0].length : 0;
      const start = a;
      const end = a + 1 + wordLen;
  
      // Если курсор был не в начале — всё равно вставим @Ник,
      // но по ТЗ — в начале поля сделать префикс "@Ник: "
      let prefixAtStart = false;
      const selStart = msgField.selectionStart;
      const selEnd   = msgField.selectionEnd;
      if (start === 0) prefixAtStart = true;
  
      let insertText = `@${selectedName}`;
      if (prefixAtStart) insertText += ': ';
  
      const newVal = t.slice(0, start) + insertText + t.slice(end);
      msgField.value = newVal;
  
      // Поставим курсор в конец вставленного блока
      const caret = start + insertText.length;
      msgField.setSelectionRange(caret, caret);
  
      autosize(msgField);
      closeMention();
      msgField.focus();
    }
  
    function handleMentionKeydown(e) {
      if (!state.mention.open) return false;
      const { key } = e;
      if (key === 'ArrowDown') {
        e.preventDefault();
        if (state.mention.items.length === 0) return true;
        state.mention.activeIndex = (state.mention.activeIndex + 1) % state.mention.items.length;
        renderMentionMenu();
        return true;
      }
      if (key === 'ArrowUp') {
        e.preventDefault();
        if (state.mention.items.length === 0) return true;
        state.mention.activeIndex = (state.mention.activeIndex - 1 + state.mention.items.length) % state.mention.items.length;
        renderMentionMenu();
        return true;
      }
      if (key === 'Enter') {
        e.preventDefault();
        const pick = state.mention.items[state.mention.activeIndex];
        if (pick) applyMention(pick);
        return true;
      }
      if (key === 'Escape') {
        e.preventDefault();
        closeMention();
        return true;
      }
      return false;
    }
  
    function maybeOpenOrUpdateMention() {
      const t = msgField.value;
      const caret = msgField.selectionStart;
  
      // Найдём ближайший '@' слева до пробела/перевода строки
      const left = t.slice(0, caret);
      const at = left.lastIndexOf('@');
      if (at < 0) {
        // если было открыто — закрыть
        if (state.mention.open) closeMention();
        return;
      }
      // Между '@' и caret не должно быть пробелов/переносов
      const afterAt = left.slice(at + 1);
      if (/[\s\n\r]/.test(afterAt)) {
        if (state.mention.open) closeMention();
        return;
      }
  
      // Обновим/откроем
      const query = afterAt; // что набрано после '@'
      if (!state.mention.open) openMention(at);
      state.mention.query = query;
      renderMentionMenu();
    }
  
    /* ---------- Message send ---------- */
    function getName() {
      let v = (nameField && nameField.value ? nameField.value.trim() : '') || 'Аноним';
      return v.slice(0, 64);
    }
  
    function getMessage() {
      return (msgField && msgField.value ? msgField.value : '');
    }
  
    function clearMessage() {
      if (!msgField) return;
      msgField.value = '';
      autosize(msgField);
    }
  
    function sendMessage() {
      const name = getName();
      const text = getMessage().trim();
      if (!text) return;
  
      const payload = { name, text, time: Date.now() };
      // Отправляем под несколько событий – на случай разницы на сервере
      if (socket && socket.connected) {
        socket.emit('message', payload);
        socket.emit('chat message', payload);
        socket.emit('sendMessage', payload);
      }
      // Локально сразу отрисуем (optimistic UI)
      renderMessage(payload, true);
      clearMessage();
    }
  
    /* ---------- Render messages ---------- */
    function addUserName(name) {
      if (!name) return;
      state.users.add(String(name));
    }
  
    function renderMessage({ name, text, time }, own = false) {
      if (!messagesEl) return;
      addUserName(name);
  
      const row = document.createElement('div');
      row.className = 'message fade-in' + (own ? ' own' : '');
      const meta = document.createElement('div');
      meta.className = 'meta';
  
      const author = document.createElement('span');
      author.className = 'author badge';
      author.textContent = name || 'Аноним';
  
      const ts = document.createElement('span');
      ts.className = 'time muted';
      const dt = time ? new Date(time) : new Date();
      ts.textContent = dt.toLocaleString();
  
      meta.appendChild(author);
      meta.appendChild(ts);
  
      const body = document.createElement('div');
      body.className = 'text';
  
      // простая подсветка @упоминаний
      const safe = (s) => s
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  
      const withMentions = safe(text).replace(
        /(^|\s)@([^\s:.,!?)(]+)/g,
        (_m, p1, nick) => `${p1}<span class="mention">@${nick}</span>`
      );
      body.innerHTML = withMentions;
  
      row.appendChild(meta);
      row.appendChild(body);
      messagesEl.appendChild(row);
      // автопрокрутка вниз
      messagesEl.parentElement?.scrollTo({ top: messagesEl.parentElement.scrollHeight, behavior: 'smooth' });
    }
  
    /* ---------- Event wiring ---------- */
    function onTextareaKeydown(e) {
      // если открыт mention-список — перехватываем навигацию/enter/esc
      if (state.mention.open) {
        const handled = handleMentionKeydown(e);
        if (handled) return;
      }
  
      if (e.key === 'Enter' && !e.shiftKey) {
        // Enter = отправка
        e.preventDefault();
        sendMessage();
        return;
      }
      // Иначе — обычный ввод, mention будет обновляться на input
    }
  
    function onTextareaInput() {
      autosize(msgField);
      maybeOpenOrUpdateMention();
    }
  
    function onTextareaClickOrSelection() {
      maybeOpenOrUpdateMention();
    }
  
    function onSendClick(e) {
      e.preventDefault();
      sendMessage();
    }
  
    /* ---------- Init ---------- */
    function initDOMDefaults() {
      if (msgField) {
        msgField.setAttribute('rows', '1');
        msgField.style.cursor = 'text';
      }
    }
  
    function bindEvents() {
      if (msgField) {
        msgField.addEventListener('keydown', onTextareaKeydown);
        msgField.addEventListener('input', onTextareaInput);
        msgField.addEventListener('click', onTextareaClickOrSelection);
        msgField.addEventListener('keyup', onTextareaClickOrSelection);
      }
      if (sendBtn) {
        sendBtn.addEventListener('click', onSendClick);
      }
      window.addEventListener('resize', syncBaseHeight);
      document.addEventListener('click', (e) => {
        // клик вне меню — закрыть
        if (!state.mention.open) return;
        const menu = state.mention.menuEl;
        if (menu && !menu.contains(e.target) && e.target !== msgField) {
          closeMention();
        }
      });
    }
  
    function bindSocket() {
      if (!socket) return;
      socket.on('connect', () => {
        // можно послать хэндшейк, если нужно
        // socket.emit('join', { name: getName() });
      });
      socket.on('message', (data) => {
        renderMessage(data, false);
      });
      socket.on('chat message', (data) => {
        renderMessage(data, false);
      });
      socket.on('broadcast', (data) => {
        // если сервер шлёт широковещательно
        renderMessage(data, false);
      });
    }
  
    function collectInitialUsernames() {
      // если в HTML уже есть сообщения — соберём авторов
      $$('.message .meta .author').forEach(a => addUserName(a.textContent.trim()));
    }
  
    function init() {
      if (!msgField || !messagesEl) {
        console.warn('client.js: expected #message (textarea) and .messages container in DOM.');
      }
      initDOMDefaults();
      syncBaseHeight();
      bindEvents();
      bindSocket();
      collectInitialUsernames();
      // небольшой таймаут на случай поздней инициализации тем/шрифтов
      setTimeout(syncBaseHeight, 0);
    }
  
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  })();
  