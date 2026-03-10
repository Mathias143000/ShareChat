export * from '@sharechat/types';

export interface SocketLike {
  on(event: string, handler: (payload?: any) => void): SocketLike;
  emit(event: string, payload?: any): SocketLike;
}

export type SocketFactory = (options?: { path: string }) => SocketLike;

declare global {
  interface Window {
    io?: SocketFactory;
  }
}
