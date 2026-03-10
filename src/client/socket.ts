import type { SocketFactory, SocketLike } from './types.js';

export function connectSocket(): SocketLike {
  const factory = window.io as SocketFactory | undefined;
  if (!factory) {
    throw new Error('Socket.IO client is not loaded');
  }

  return factory({
    path: '/socket.io',
    transports: ['websocket'],
    upgrade: true,
    rememberUpgrade: true,
    timeout: 20_000,
    pingInterval: 25_000,
    pingTimeout: 20_000
  });
}
