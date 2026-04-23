import type { SocketLike } from './types.js';

interface ChatManagerOptions {
  chatSelect: HTMLSelectElement | null;
  socket: SocketLike;
  storageKey?: string;
}

export interface ChatManager {
  getCurrentChatId(): number;
  setCurrentChat(id: number, options?: { emit?: boolean; save?: boolean }): void;
  rebuildChatSelect(ids: number[]): void;
}

export function createChatManager({ chatSelect, socket, storageKey = 'chatId' }: ChatManagerOptions): ChatManager {
  let currentChatId = Number(localStorage.getItem(storageKey) || '1') || 1;

  function persist(id: number): void {
    try {
      localStorage.setItem(storageKey, String(id));
    } catch {}
  }

  function setCurrentChat(id: number, { emit = true, save = true } = {}): void {
    id = Number(id) || 1;
    currentChatId = id;
    if (save) persist(id);
    if (chatSelect) chatSelect.value = String(id);
    if (emit) socket.emit('chat:select', { id });
  }

  function rebuildChatSelect(ids: number[]): void {
    if (!chatSelect) {
      setCurrentChat(currentChatId, { emit: true, save: true });
      return;
    }
    const normalized = ids.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    if (!normalized.length) normalized.push(1);
    const prev = Number(chatSelect.value || currentChatId || 1);
    chatSelect.innerHTML = normalized.map((id) => `<option value="${id}">${id}</option>`).join('');
    let next = prev;
    if (!normalized.includes(prev)) {
      const lower = normalized.filter((id) => id < prev);
      next = lower.length ? lower[lower.length - 1] : normalized[0];
    }
    setCurrentChat(next, { emit: true, save: true });
  }

  return { getCurrentChatId: () => currentChatId, setCurrentChat, rebuildChatSelect };
}
