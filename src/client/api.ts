import type { ApiResponse } from './types.js';

export function getErrorMessage(error: unknown, fallback = 'Request failed'): string {
  if (!error) return fallback;
  if (typeof error === 'string') return error;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

export async function parseResponse<T extends ApiResponse>(response: Response, fallback = 'Request failed'): Promise<T> {
  if (response.status === 204) return { ok: true } as T;

  const contentType = response.headers.get('content-type') || '';
  let payload: ApiResponse | null = null;

  try {
    if (contentType.includes('application/json')) {
      payload = await response.json();
    } else {
      const text = await response.text();
      payload = text ? { error: text } : null;
    }
  } catch {
    payload = null;
  }

  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error || fallback);
  }

  return (payload || { ok: true }) as T;
}

export async function fetchJSON<T extends ApiResponse>(url: string, options?: RequestInit, fallback = 'Request failed'): Promise<T> {
  const response = await fetch(url, options);
  return parseResponse<T>(response, fallback);
}
