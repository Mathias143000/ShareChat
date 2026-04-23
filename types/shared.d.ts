export type StatusKind = 'info' | 'success' | 'error';

export interface ApiResponse {
  ok?: boolean;
  error?: string;
  [key: string]: unknown;
}

export interface UploadListItem {
  name: string;
  size: number;
  mtime: number;
}

export interface FileListResponse extends ApiResponse {
  files?: UploadListItem[];
}

export interface DeleteFilesResponse extends ApiResponse {
  deleted?: number;
}

export interface UploadResponse extends ApiResponse {
  files?: Array<{
    name: string;
    size: number;
    type: string;
    url: string;
  }>;
}

export interface ChatMessage {
  id: number;
  name: string;
  time: number;
  text?: string;
  image?: string;
  mime?: string;
}

export interface ChatInitPayload {
  id?: number;
  messages?: ChatMessage[];
  names?: string[];
}

export interface ChatNamesPayload {
  id?: number;
  names?: string[];
}

export interface ChatsListPayload {
  chats?: number[];
}

export interface ChatCreateResponse extends ApiResponse {
  id?: number;
}
