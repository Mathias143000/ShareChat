export function deriveAccentFromMessageInput(): void {
  try {
    const probe = document.createElement('textarea');
    probe.className = 'message-input has-mention';
    Object.assign(probe.style, {
      position: 'fixed',
      left: '-99999px',
      top: '0',
      opacity: '0',
      pointerEvents: 'none'
    });
    document.body.appendChild(probe);
    const shadow = window.getComputedStyle(probe).boxShadow || '';
    document.body.removeChild(probe);

    const matches = shadow.match(/rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+(?:\s*,\s*(?:0?\.\d+|1(?:\.0+)?)\s*)?\)/g);
    let color = 'rgba(59,130,246,.35)';
    if (matches?.length) color = matches[matches.length - 1];

    const parts = (color.match(/rgba?\(([^)]+)\)/) || [, '59,130,246,0.35'])[1]
      .split(',')
      .map((value) => parseFloat(value.trim()));
    const [r, g, b, alpha] = parts;
    const a = Number.isFinite(alpha) ? alpha : 1;

    const root = document.documentElement.style;
    root.setProperty('--accent-ring', `rgba(${r}, ${g}, ${b}, ${a})`);
    root.setProperty('--accent-fg', `rgb(${r}, ${g}, ${b})`);
    root.setProperty('--accent-bg', `rgba(${r}, ${g}, ${b}, 0.16)`);
  } catch {}
}

export function injectChatRuntimeStyles(): void {
  if (document.getElementById('chat-runtime-styles')) return;

  const style = document.createElement('style');
  style.id = 'chat-runtime-styles';
  style.textContent = `
    .msg { position:relative; border-radius:10px; transition: background .28s ease, border-color .28s ease, box-shadow .28s ease; }
    .msg.msg-text, .msg.msg-image { cursor: pointer; }
    .msg .meta { font-size:.85em; opacity:.8; margin-bottom:6px; }
    .msg .meta .author { font-weight:600; }
    .msg .text .mention { color: var(--accent-fg, #1d4ed8); background: var(--accent-bg, rgba(59,130,246,.16)); padding:0 .2em; border-radius:4px; }
    .msg .text .mention.me { box-shadow: 0 0 0 2px var(--accent-bg, rgba(59,130,246,.16)); }
    .msg.msg-image img.chat-img{
      max-width:min(100%, 92vw); max-height:72vh; height:auto; display:block;
      border-radius:8px; border:1px solid var(--border);
      object-fit:contain; object-position:center;
    }
    .lightbox-backdrop{position:fixed; inset:0; background:rgba(0,0,0,.85); z-index:9999;
      display:flex; align-items:center; justify-content:center; }
    .lightbox-img{ max-width:98vw; max-height:98vh; object-fit:contain; border-radius:10px; box-shadow:0 20px 60px rgba(0,0,0,.5); }
    .msg.flash,
    .msg.flash:hover{
      background: var(--hover-bg);
      border-color: var(--hover-border);
      box-shadow: 0 0 0 3px var(--accent-ring, rgba(59,130,246,.35));
    }
    @media (prefers-reduced-motion: reduce){ .msg{transition:none;} }
  `;
  document.head.appendChild(style);
}

function updateThemeButton(themeToggle: HTMLButtonElement | null): void {
  const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
  const icon = currentTheme === 'light' ? '&#9728;' : '&#9790;';
  if (themeToggle) {
    themeToggle.innerHTML = `<span class="icon" aria-hidden="true">${icon}</span><span class="label">Тема</span>`;
  }
}

export function initTheme(themeToggle: HTMLButtonElement | null): void {
  injectChatRuntimeStyles();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', deriveAccentFromMessageInput, { once: true });
  } else {
    deriveAccentFromMessageInput();
  }

  const html = document.documentElement;
  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  const savedTheme = localStorage.getItem('theme');
  const initialTheme = savedTheme === 'dark' || savedTheme === 'light'
    ? savedTheme
    : (prefersDark ? 'dark' : 'light');

  html.setAttribute('data-theme', initialTheme);
  updateThemeButton(themeToggle);

  themeToggle?.addEventListener('click', () => {
    const currentTheme = html.getAttribute('data-theme') || 'light';
    const nextTheme = currentTheme === 'light' ? 'dark' : 'light';
    html.setAttribute('data-theme', nextTheme);
    localStorage.setItem('theme', nextTheme);
    updateThemeButton(themeToggle);
    deriveAccentFromMessageInput();
  });
}
