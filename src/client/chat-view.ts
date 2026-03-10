import type { ChatMessage } from './types.js';
import { copyPlainText, esc, fmtTime } from './utils.js';

export function highlightMentions(plain: string, currentName: string, allNames: string[] = []): string {
  const safe = esc(plain || '');
  const namesSet = new Set(allNames.map((name) => String(name).trim()).filter(Boolean));
  const me = String(currentName || '').trim();

  return safe.replace(/(^|[\s>])@([^\s:@]{1,64})(:?)/g, (match, lead, nick, colon) => {
    const isKnown = namesSet.has(nick);
    if (!isKnown && (!me || nick !== me)) return match;
    const className = nick === me ? 'mention me' : 'mention';
    return `${lead}<span class="${className}" data-nick="${esc(nick)}">@${esc(nick)}</span>${colon || ''}`;
  });
}

export function renderMessage(
  chatEl: HTMLElement | null,
  message: ChatMessage | null | undefined,
  currentName: string,
  knownNames: string[]
): void {
  if (!chatEl || !message) return;

  const author = esc(message.name || 'Anon');
  const time = fmtTime(message.time || Date.now());
  const wrap = document.createElement('div');

  if (message.image) {
    wrap.className = 'msg msg-image';
    wrap.title = 'Нажмите для увеличения';

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.innerHTML = `<span class="author">${author}</span> • ${esc(time)}`;

    const image = document.createElement('img');
    image.className = 'chat-img';
    image.alt = message.name || 'image';
    image.src = message.image;
    image.decoding = 'async';
    image.loading = 'lazy';

    wrap.appendChild(meta);
    wrap.appendChild(image);
  } else {
    wrap.className = 'msg msg-text';
    wrap.title = 'Клик — копировать текст';

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.innerHTML = `<span class="author">${author}</span> • ${esc(time)}`;

    const text = document.createElement('div');
    text.className = 'text';
    text.innerHTML = highlightMentions(String(message.text || ''), currentName, knownNames);

    wrap.appendChild(meta);
    wrap.appendChild(text);
  }

  chatEl.appendChild(wrap);
}

function openLightbox(src: string): void {
  const backdrop = document.createElement('div');
  backdrop.className = 'lightbox-backdrop';

  const image = document.createElement('img');
  image.className = 'lightbox-img';
  image.src = src;
  image.alt = '';

  backdrop.appendChild(image);

  const close = () => {
    try {
      document.body.removeChild(backdrop);
    } catch {}
  };

  backdrop.addEventListener('click', close, { once: true });
  document.addEventListener('keydown', function onEscape(event) {
    if (event.key === 'Escape') {
      close();
      document.removeEventListener('keydown', onEscape);
    }
  });
  document.body.appendChild(backdrop);
}

export function bindChatInteractions(chatEl: HTMLElement | null): void {
  chatEl?.addEventListener('click', async (event) => {
    const target = event.target as HTMLElement | null;
    const imageMessage = target?.closest<HTMLElement>('.msg.msg-image');
    const textMessage = target?.closest<HTMLElement>('.msg.msg-text');

    if (imageMessage) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const image = imageMessage.querySelector<HTMLImageElement>('img.chat-img');
      if (image?.src) openLightbox(image.src);
      return;
    }

    if (!textMessage) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const textEl = textMessage.querySelector<HTMLElement>('.text');
    let text = textEl?.innerText?.trim() || '';
    text = text.replace(/^\s*@([^\s:@]{1,64}):\s*/u, '');

    textMessage.classList.remove('flash');
    textMessage.offsetWidth;
    textMessage.classList.add('flash');
    window.setTimeout(() => textMessage.classList.remove('flash'), 900);

    if (text) await copyPlainText(text);
  }, { passive: false });
}
