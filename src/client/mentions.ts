import { copyPlainText, esc } from './utils.js';

interface MentionOptions {
  msgInput: HTMLTextAreaElement | null;
  mentionMenu: HTMLDivElement | null;
}

interface MentionController {
  detectMentionHighlight(): void;
  handleInput(): void;
  handleKeyDown(event: KeyboardEvent): void;
  handleDocumentClick(event: MouseEvent): void;
  insertMention(name: string, withColon?: boolean): void;
  openMentionMenu(filter?: string): void;
  closeMentionMenu(): void;
  updateNames(names: string[]): void;
  isMenuOpen(): boolean;
}

export function createMentionController({ msgInput, mentionMenu }: MentionOptions): MentionController {
  let knownNames: string[] = [];
  let mentionIndex = 0;
  let mentionFilter = '';
  let mentionOpen = false;

  function renderNamesMenu(filter = ''): void {
    if (!mentionMenu) return;
    const query = filter.trim().toLowerCase();
    const list = knownNames.filter((name) => name.toLowerCase().includes(query)).slice(0, 20);
    mentionMenu.innerHTML = list.length
      ? list.map((name, index) => `<div class="mention-item ${index === mentionIndex ? 'active' : ''}" data-name="${esc(name)}">@${esc(name)}</div>`).join('')
      : `<div class="mention-item muted">Нет совпадений</div>`;
    mentionMenu.querySelectorAll('.mention-item').forEach((el) => {
      const targetName = el.getAttribute('data-name');
      if (!targetName) return;
      el.addEventListener('mousedown', (event) => {
        event.preventDefault();
        insertMention(targetName, true);
        closeMentionMenu();
      });
    });
  }

  function openMentionMenu(filter = ''): void {
    if (!mentionMenu || !msgInput) return;
    mentionFilter = filter;
    mentionIndex = 0;
    mentionOpen = true;
    mentionMenu.hidden = false;
    renderNamesMenu(filter);
  }

  function closeMentionMenu(): void {
    if (!mentionMenu) return;
    mentionOpen = false;
    mentionMenu.hidden = true;
  }

  function detectMentionHighlight(): void {
    if (!msgInput) return;
    const value = msgInput.value;
    const hasMention = /@([^\s:]{1,64}):/u.test(value) || knownNames.some((name) => new RegExp(`@${name}\\b`).test(value));
    msgInput.classList.toggle('has-mention', hasMention);
  }

  function insertMention(name: string, withColon = false): void {
    if (!msgInput) return;
    const value = msgInput.value;
    const caret = msgInput.selectionStart ?? value.length;
    const upto = value.slice(0, caret);
    const at = upto.lastIndexOf('@');
    if (at < 0) return;
    const before = value.slice(0, at);
    const after = value.slice(caret);
    const mention = `@${name}${withColon ? ': ' : ' '}`;
    msgInput.value = before + mention + after;
    const position = (before + mention).length;
    msgInput.setSelectionRange(position, position);
    detectMentionHighlight();
  }

  function handleInput(): void {
    detectMentionHighlight();
    const caret = msgInput?.selectionStart ?? 0;
    const upto = msgInput?.value.slice(0, caret) ?? '';
    const at = upto.lastIndexOf('@');
    if (at >= 0) {
      const afterAt = upto.slice(at + 1);
      if (/^[^\s@]{0,32}$/.test(afterAt)) {
        openMentionMenu(afterAt);
        return;
      }
    }
    closeMentionMenu();
  }

  function handleKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || !msgInput) return;
    if (event.shiftKey) return;
    if (!mentionOpen) return;
    event.preventDefault();
    const active = mentionMenu?.querySelector('.mention-item.active');
    const name = active?.getAttribute('data-name') || knownNames.find((n) => n.toLowerCase().includes(mentionFilter.toLowerCase())) || '';
    if (name) insertMention(name, true);
    closeMentionMenu();
  }

  function handleDocumentClick(event: MouseEvent): void {
    if (!mentionOpen || !mentionMenu || !msgInput) return;
    const target = event.target instanceof Node ? event.target : null;
    if (!mentionMenu.contains(target) && target !== msgInput) {
      closeMentionMenu();
    }
  }

  function updateNames(names: string[]): void {
    knownNames = names;
    if (mentionOpen) renderNamesMenu(mentionFilter);
  }

  return {
    detectMentionHighlight,
    handleInput,
    handleKeyDown,
    handleDocumentClick,
    insertMention,
    openMentionMenu,
    closeMentionMenu,
    updateNames,
    isMenuOpen: () => mentionOpen,
  };
}
