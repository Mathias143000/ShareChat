export * from '@sharechat/types';

export interface SocketLike {
  on(event: string, handler: (payload?: any) => void): SocketLike;
  emit(event: string, payload?: any): SocketLike;
}

export interface SocketFactoryOptions {
  path?: string;
  transports?: Array<'websocket' | 'polling'>;
  upgrade?: boolean;
  rememberUpgrade?: boolean;
  timeout?: number;
  pingInterval?: number;
  pingTimeout?: number;
}

export type SocketFactory = (options?: SocketFactoryOptions) => SocketLike;

declare global {
  interface Window {
    io?: SocketFactory;
  }
}
