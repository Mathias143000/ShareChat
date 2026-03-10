// src/client/main.ts - ShareChat frontend entrypoint
// - Клик по картинке: лайтбокс (никакого копирования)
// - Клик по тексту: копирует только текст (без ведущего "@Nick: "), подсветка-миг "как hover" + ring
// - @упоминания: цвет берётся из .message-input.has-mention, совпадает с полем "Сообщение"
// - Скриншоты через paste/drop в поле сообщения отправляются как dataURL (не попадают в список файлов)

import { fetchJSON, getErrorMessage } from './api.js';
import { bindChatInteractions, renderMessage } from './chat-view.js';
import { connectSocket } from './socket.js';
import { createStatusController } from './status.js';
import { initTheme } from './theme.js';
import { initUploads } from './uploads.js';
import { createMentionController } from './mentions.js';
import { createChatManager } from './chats.js';
import type {
  ChatCreateResponse,
  ChatInitPayload,
  ChatMessage,
  ChatNamesPayload,
  ChatsListPayload,
  DeleteFilesResponse,
  FileListResponse,
  UploadListItem
} from './types.js';
import {
  $,
  blobToDataURL,
  canvasToBlob,
  isImageFile,
  loadImage
} from './utils.js';

function clearInviteCodeFromUrl(): void {
  const params = new URLSearchParams(window.location.search);
  const inviteCode = params.get('invite');
  if (!inviteCode) return;
  const normalized = inviteCode.trim();
  if (!normalized) return;
  params.delete('invite');
  const search = params.toString();
  const newUrl = `${window.location.pathname}${search ? `?${search}` : ''}${window.location.hash}`;
  window.history.replaceState(null, '', newUrl);
}

clearInviteCodeFromUrl();

(() => {
  const chatEl = $<HTMLDivElement>('#chat');
  const filesEl = $<HTMLDivElement>('#files');
  const statusEl = $<HTMLDivElement>('#status');
  let nameInput = $<HTMLInputElement | HTMLTextAreaElement>('#name');
  let msgInput = $<HTMLTextAreaElement>('#message');
  const sendBtn = $<HTMLButtonElement>('#sendBtn');
  const deleteAllBtn = $<HTMLButtonElement>('#deleteAll');
  const dropzone = $<HTMLDivElement>('#dropzone');
  const fileInput = $<HTMLInputElement>('#fileInput');
  const mentionMenu = $<HTMLDivElement>('#mentionMenu');
  const themeToggle = $<HTMLButtonElement>('#themeToggle');

  const chatSelect = $<HTMLSelectElement>('#chatSelect');
  const chatAddBtn = $<HTMLButtonElement>('#chatAdd');
  const chatDelBtn = $<HTMLButtonElement>('#chatDel');
  const clearChatBtn = $<HTMLButtonElement>('#clearChat');

  fileInput?.setAttribute('multiple', '');

  const socket = connectSocket();
  const { setStatus } = createStatusController(statusEl);
  initTheme(themeToggle);
  const uploads = initUploads({ dropzone, fileInput, deleteAllBtn, filesEl, setStatus });
  const mentionController = createMentionController({ msgInput, mentionMenu });

  const form = $<HTMLFormElement>('#chatForm');
  if (form) {
    form.style.display = 'grid';
    form.style.gridTemplateColumns = '160px 1fr';
    form.style.gridTemplateAreas = '"name msg" "send send"';
    form.style.gap = '8px';
  }

  /* ---------- Имя как textarea ---------- */
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

  /* ---------- Авто-рост полей ---------- */
  const LINE = 22;
  const MAX_H = LINE * 5 + 22;
  const MIN_H = LINE + 14;
  const px = (v: string | number): number => {
    const n = parseFloat(String(v));
    return Number.isFinite(n) ? n : 0;
  };
  interface MeasuredLayout {
    el: HTMLTextAreaElement | HTMLInputElement;
    minH: number;
    padV: number;
    scrollH: number;
    needed: number;
    oneLine: boolean;
  }
  function measure(el: HTMLTextAreaElement | HTMLInputElement | null): MeasuredLayout | null {
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
  function apply(el: HTMLTextAreaElement | HTMLInputElement | null, targetH: number, meta: MeasuredLayout | null): void {
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
  let knownNames: string[] = [];
  const chatManager = createChatManager({ chatSelect, socket });

  /* ---------- Утилиты ---------- */

  async function downscaleDataURL(dataURL: string, maxSide = 1920, outType = 'image/png', outQuality = 0.92): Promise<string> {
    const img = await loadImage(dataURL);
    const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    const scale = Math.min(1, maxSide/Math.max(w,h));
    if (scale >= 1) return dataURL;
    const cw = Math.max(1, Math.round(w*scale)), ch = Math.max(1, Math.round(h*scale));
    const canvas = document.createElement('canvas'); canvas.width=cw; canvas.height=ch;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0,0, cw,ch);
    const blob = await canvasToBlob(canvas, outType, outQuality);
    return await blobToDataURL(blob);
  }
  async function prepareDataURLForChat(file: File): Promise<string> {
    const orig = await blobToDataURL(file);
    const t = (file.type||'').toLowerCase();
    if (t.includes('gif') || t.includes('svg')) return orig;
    return await downscaleDataURL(orig, 1920, 'image/png', 0.92);
  }

  /* ---------- Chat view ---------- */
  bindChatInteractions(chatEl);

  function sendCurrentMessage() {
    const name = (nameInput?.value || '').trim() || 'Anon';
    const text = (msgInput?.value || '').trim();
    if (!text) return false;
    if (sendBtn) sendBtn.disabled = true;
    socket.emit('chat:message', { id: chatManager.getCurrentChatId(), name, text });
    if (msgInput) msgInput.value = '';
    mentionController.detectMentionHighlight();
    autosizeBoth();
    setTimeout(() => { if (sendBtn) sendBtn.disabled = false; }, 50);
    return true;
  }
  $('#chatForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!sendCurrentMessage()) setStatus('Message is empty.', 'error');
  });

  msgInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && mentionController.isMenuOpen()) {
      mentionController.handleKeyDown(event);
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (!sendCurrentMessage()) setStatus('Message is empty.', 'error');
    }
  });

  msgInput?.addEventListener('input', () => {
    mentionController.handleInput();
    autosizeBoth();
  });

  document.addEventListener('click', (event) => mentionController.handleDocumentClick(event));

  msgInput?.addEventListener('paste', async (e: ClipboardEvent) => {
    const items = e.clipboardData?.items ? Array.from(e.clipboardData.items) : [];
    const images: File[] = [];
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
        const dataURL = await prepareDataURLForChat(f);
        socket.emit('chat:message', { id: chatManager.getCurrentChatId(), name, image: dataURL, mime: f.type || 'image/png' });
      } catch (error) {
        setStatus(getErrorMessage(error, 'Failed to prepare pasted image.'), 'error');
      }
    }
  });
  msgInput?.addEventListener('dragover', (e) => { e.preventDefault(); });
  msgInput?.addEventListener('drop', async (e: DragEvent) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer?.files || []).filter(isImageFile);
    if (!files.length) return;
    const name = (nameInput?.value || '').trim() || 'Anon';
    for (const f of files) {
      try {
        const dataURL = await prepareDataURLForChat(f);
        socket.emit('chat:message', { id: chatManager.getCurrentChatId(), name, image: dataURL, mime: f.type || 'image/png' });
      } catch (error) {
        setStatus(getErrorMessage(error, 'Failed to prepare dropped image.'), 'error');
      }
    }
  });

  /* ---------- Socket ---------- */
  socket.on('connect', () => {
    setStatus('Connected.', 'success', 1500);
  });

  socket.on('connect_error', (error) => {
    setStatus(getErrorMessage(error, 'Connection failed.'), 'error', 5000);
  });

  socket.on('disconnect', () => {
    setStatus('Connection lost. Trying to reconnect...', 'error', 5000);
  });

  socket.on('files:update', () => {
    uploads.loadFiles({ silent: true });
  });

  socket.on('chat:error', (payload) => {
    setStatus(payload?.error || 'Chat action failed.', 'error', 5000);
  });

  socket.on('image:uploaded', (payload) => {
    if (payload?.ok === false) {
      setStatus(payload?.error || 'Image upload failed.', 'error', 5000);
    }
  });

  socket.on('chats:list', (payload: ChatsListPayload) => {
    const ids = (payload?.chats || []).map(Number).filter(Number.isFinite).sort((a,b)=>a-b);
    if (!ids.length) ids.push(1);
    chatManager.rebuildChatSelect(ids);
  });

  socket.on('chat:init', (payload: ChatInitPayload) => {
    const id = Number(payload?.id) || 1;
    const msgs: ChatMessage[] = Array.isArray(payload?.messages) ? payload.messages : [];
    knownNames = Array.isArray(payload?.names) ? payload.names : [];
    mentionController.updateNames(knownNames);
    if (id !== chatManager.getCurrentChatId()) {
      chatManager.setCurrentChat(id, { emit:false, save:true });
    }
    if (chatEl) {
      chatEl.innerHTML = '';
      msgs.forEach((message) => renderMessage(chatEl, message, (nameInput?.value || '').trim(), knownNames));
      chatEl.scrollTop = chatEl.scrollHeight;
    }
    mentionController.detectMentionHighlight();
    autosizeBoth();
  });

  socket.on('chat:message', (m: ChatMessage) => {
    if (Number(m?.id) !== chatManager.getCurrentChatId()) return;
    renderMessage(chatEl, m, (nameInput?.value || '').trim(), knownNames);
    if (chatEl) chatEl.scrollTop = chatEl.scrollHeight;
    setStatus('');
  });

  socket.on('chat:names', (payload: ChatNamesPayload) => {
    if (Number(payload?.id) !== chatManager.getCurrentChatId()) return;
    knownNames = Array.isArray(payload?.names) ? payload.names : [];
    mentionController.updateNames(knownNames);
    mentionController.detectMentionHighlight();
  });

  socket.on('chat:cleared', (payload: ChatNamesPayload) => {
    if (Number(payload?.id) !== chatManager.getCurrentChatId()) return;
    if (chatEl) chatEl.innerHTML = '';
    knownNames = Array.isArray(payload?.names) ? payload.names : [];
    mentionController.updateNames(knownNames);
    mentionController.detectMentionHighlight();
    autosizeBoth();
  });

  async function deleteCurrentChatCompletely() {
    const chatId = chatManager.getCurrentChatId();
    if (!confirm(`Удалить чат «${chatId}» полностью?`)) return;
    try {
      await fetchJSON('/api/chats/' + encodeURIComponent(String(chatId)), { method: 'DELETE' }, 'Failed to delete chat');
      setStatus(`Deleted chat ${chatId}.`, 'success', 2000);
    } catch (error) {
      setStatus(getErrorMessage(error, 'Failed to delete chat.'), 'error', 5000);
    }
  }
  async function clearCurrentChatMessages() {
    const chatId = chatManager.getCurrentChatId();
    clearChatBtn?.setAttribute('disabled','');
    try {
      await fetchJSON('/api/chats/'+encodeURIComponent(String(chatId))+'/messages', { method:'DELETE' }, 'Failed to clear chat');
      if (chatEl) chatEl.innerHTML = '';
      knownNames = [];
      mentionController.updateNames([]);
      mentionController.detectMentionHighlight();
      autosizeBoth();
      setStatus(`Cleared chat ${chatId}.`, 'success', 2000);
    } catch (error) {
      socket.emit('chat:clear', { id: chatId });
      setStatus(getErrorMessage(error, 'Failed to clear chat.'), 'error', 5000);
    } finally {
      clearChatBtn?.removeAttribute('disabled');
    }
  }
  chatAddBtn?.addEventListener('click',  async () => {
    try {
      const j = await fetchJSON('/api/chats', { method:'POST' }, 'Failed to create chat');
      if (j?.ok && j?.id) chatManager.setCurrentChat(Number(j.id), { emit:true, save:true });
      setStatus(`Created chat ${j?.id}.`, 'success', 2000);
    } catch (error) {
      setStatus(getErrorMessage(error, 'Failed to create chat.'), 'error', 5000);
    }
  });
  chatDelBtn?.addEventListener('click',  () => deleteCurrentChatCompletely());
  clearChatBtn?.addEventListener('click', (e) => { e.preventDefault(); clearCurrentChatMessages(); });

  if (chatSelect) {
    chatSelect.addEventListener('change', (e) => {
      const id = Number((e.target as HTMLSelectElement).value);
      if (id && id !== chatManager.getCurrentChatId()) {
        chatManager.setCurrentChat(id, { emit: true, save: true });
      }
    });
  }

  /* ---------- Старт ---------- */
  window.addEventListener('online', () => setStatus('Network connection restored.', 'success', 2000));
  window.addEventListener('offline', () => setStatus('You are offline.', 'error', 5000));
  uploads.loadFiles();
})();


