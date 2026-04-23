import type { StatusKind } from './types.js';

export interface StatusController {
  setStatus(message: string, kind?: StatusKind, timeout?: number): void;
}

export function createStatusController(statusEl: HTMLElement | null): StatusController {
  let statusTimer = 0;

  return {
    setStatus(message, kind = 'info', timeout = 4000) {
      if (!statusEl) return;

      window.clearTimeout(statusTimer);
      if (!message) {
        statusEl.hidden = true;
        statusEl.textContent = '';
        statusEl.className = 'status';
        return;
      }

      statusEl.hidden = false;
      statusEl.textContent = message;
      statusEl.className = `status is-${kind}`;

      if (timeout > 0) {
        statusTimer = window.setTimeout(() => {
          statusEl.hidden = true;
          statusEl.textContent = '';
          statusEl.className = 'status';
        }, timeout);
      }
    }
  };
}
