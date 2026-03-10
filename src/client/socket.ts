import type { SocketFactory, SocketLike } from './types.js';

export function connectSocket(): SocketLike {
  const factory = window.io as SocketFactory | undefined;
  if (!factory) {
    throw new Error('Socket.IO client is not loaded');
  }

  return factory({ path: '/socket.io' });
}
