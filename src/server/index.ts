import crypto from 'crypto';
import fs from 'fs';
import http, { type IncomingMessage } from 'http';
import path from 'path';
import { Readable } from 'stream';

import express, {
  type Request,
  type RequestHandler,
  type Response,
  type NextFunction
} from 'express';
import mime from 'mime-types';
import multer, { type FileFilterCallback } from 'multer';
import { type Socket } from 'socket.io';
import { Server as SocketIOServer } from 'socket.io';
import type {
  ChatCreateResponse,
  ChatInitPayload,
  ChatMessage,
  ChatNamesPayload,
  ChatsListPayload
} from '@sharechat/types';

import {
  getRuntimeSnapshot,
  initializeRuntimeMetrics,
  recordChatMessage,
  recordCleanupRun,
  recordHttpRequest,
  recordRateLimitHit,
  recordSocketConnected,
  recordSocketDisconnected,
  recordUploadCompleted,
  recordUploadFailure,
  renderPrometheusMetrics,
  setActiveSockets,
  setChatCount,
  setRedisConnected
} from './metrics';
import { createStorageAdapter } from './storage';
import Redis from 'ioredis';
import https from 'https';

const INVITE_HEADER = 'x-sharechat-invite';
const INVITE_QUERY_PARAM = 'invite';
const INVITE_COOKIE_NAME = 'sharechat_invite';

const fsp = fs.promises;
const app = express();

const APP_ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(APP_ROOT, 'public');
const BLOCKED_PAGE = path.join(PUBLIC, 'blocked.html');
const UPLOADS = path.resolve(APP_ROOT, process.env.UPLOADS_DIR || 'uploads');
const DATA_DIR = path.resolve(APP_ROOT, process.env.DATA_DIR || 'data');
const ALLOWED_FILE = path.resolve(APP_ROOT, process.env.ALLOWED_IPS_FILE || 'allowed_ips.txt');
const CHAT_STORE = path.join(DATA_DIR, 'chats.json');

const textExts = new Set(['txt', 'md', 'json', 'csv', 'log', 'js', 'ts', 'py', 'html', 'css', 'xml', 'yml', 'yaml', 'sh', 'bat', 'conf', 'ini']);
const imageExts = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif', 'heic', 'heif', 'tif', 'tiff']);
const audioExts = new Set(['mp3', 'wav', 'ogg', 'm4a', 'flac']);
const videoExts = new Set(['mp4', 'webm', 'mkv', 'mov']);
const inlineUploadExts = new Set([...imageExts, ...audioExts, ...videoExts]);
const CHAT_IMAGE_PREFIX = 'chat-image-';
const defaultBlockedUploadExts = [
  'exe', 'dll', 'com', 'bat', 'cmd', 'msi', 'ps1', 'scr', 'jar',
  'php', 'asp', 'aspx', 'jsp', 'cgi', 'reg'
];

function asInt(value: unknown, fallback: number, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER }: { min?: number; max?: number } = {}) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function asBool(value: unknown, fallback = false) {
  if (value == null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseCsv(value: unknown) {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function toOriginSet(items: string[]) {
  const origins = new Set();
  for (const item of items) {
    try {
      origins.add(new URL(item).origin);
    } catch {}
  }
  return origins;
}

function toLowerSet(items: string[]) {
  return new Set(items.map((item) => String(item).trim().toLowerCase()).filter(Boolean));
}

function normalizeStoragePrefix(value?: string) {
  let prefix = String(value || '').trim();
  prefix = prefix.replace(/^[\\/]+/, '');
  if (prefix && !prefix.endsWith('/')) prefix = `${prefix}/`;
  return prefix;
}

function normalizeParam(value: string | string[] | null | undefined): string {
  if (Array.isArray(value)) return value[0] || '';
  return value || '';
}

function normalizeInviteValue(value: string | string[] | null | undefined): string {
  return normalizeParam(value).trim().toLowerCase();
}

function extractInviteFromRequest(req: RequestLike): string {
  const headerCode = normalizeInviteValue(req.headers?.[INVITE_HEADER]);
  if (headerCode) return headerCode;

  if (req.url) {
    try {
      const base = `http://${req.headers?.host || 'localhost'}`;
      const url = new URL(req.url, base);
      const queryCode = normalizeInviteValue(url.searchParams.get(INVITE_QUERY_PARAM));
      if (queryCode) return queryCode;
    } catch {
      /* ignore malformed urls */
    }
  }

  return getInviteFromCookie(req);
}

function normalizeMetricsPath(pathName: string): string {
  if (!pathName) return '/';
  if (pathName.startsWith('/uploads/')) return '/uploads/:name';
  if (pathName.startsWith('/preview/')) return '/preview/:name';
  if (pathName.startsWith('/api/files/')) return '/api/files/:name';
  if (pathName.startsWith('/api/chats/')) {
    return pathName
      .replace(/\/api\/chats\/\d+\/messages$/, '/api/chats/:id/messages')
      .replace(/\/api\/chats\/\d+$/, '/api/chats/:id');
  }
  return pathName.replace(/\/\d+\b/g, '/:id');
}

function parseCookies(value?: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!value) return result;

  for (const entry of value.split(';')) {
    const index = entry.indexOf('=');
    if (index < 0) continue;
    const name = entry.slice(0, index).trim();
    if (!name) continue;
    const cookieValue = entry.slice(index + 1).trim();
    result[name] = cookieValue;
  }
  return result;
}

function getInviteFromCookie(req: RequestLike): string {
  const cookies = parseCookies(req.headers?.cookie);
  const raw = cookies[INVITE_COOKIE_NAME];
  if (!raw) return '';
  try {
    return normalizeInviteValue(decodeURIComponent(raw));
  } catch {
    return normalizeInviteValue(raw);
  }
}

function setInviteCookie(res: Response, code: string, secure = false): void {
  if (!code) return;
  const secureFlag = secure ? '; Secure' : '';
  const cookieValue = `${INVITE_COOKIE_NAME}=${encodeURIComponent(code)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${secureFlag}`;
  const existing = res.getHeader('Set-Cookie');
  if (!existing) {
    res.setHeader('Set-Cookie', cookieValue);
  } else if (Array.isArray(existing)) {
    res.setHeader('Set-Cookie', [...existing, cookieValue]);
  } else if (typeof existing === 'string') {
    res.setHeader('Set-Cookie', [existing, cookieValue]);
  } else {
    res.setHeader('Set-Cookie', cookieValue);
  }
}

function respondInviteRequired(req: Request, res: Response): Response {
  if (String(req.headers.accept || '').includes('text/html')) {
    return res.status(401).send('Unauthorized: invite code required');
  }
  return res.status(401).json({ ok: false, error: 'invite required' });
}

function isInviteRequired(): boolean {
  return inviteCodes.size > 0;
}

function isInviteAuthorized(code: string): boolean {
  if (!inviteCodes.size) return true;
  return inviteCodes.has(code);
}


type SocketTransport = 'websocket' | 'polling';

function parseSocketTransports(value?: string): SocketTransport[] {
  const normalized = parseCsv(value);
  const allowed: SocketTransport[] = [];
  for (const entry of normalized) {
    const lower = entry.trim().toLowerCase();
    if (lower === 'websocket' || lower === 'polling') {
      allowed.push(lower as SocketTransport);
    }
  }
  return allowed.length ? allowed : ['websocket'];
}

const config = {
  nodeName: (process.env.APP_NODE_NAME || process.env.HOSTNAME || 'share-chat').trim(),
  port: asInt(process.env.PORT, 3000, { min: 1, max: 65535 }),
  publicOrigin: process.env.PUBLIC_ORIGIN || '',
  allowedOrigins: toOriginSet(parseCsv(process.env.ALLOWED_ORIGINS)),
  socketTransports: parseSocketTransports(process.env.SOCKET_TRANSPORTS),
  maxHttpBufferSize: asInt(process.env.SOCKET_MAX_BUFFER_MB, 10, { min: 1, max: 64 }) * 1024 * 1024,
  maxUploadBytes: asInt(process.env.MAX_UPLOAD_MB, 200, { min: 1, max: 1024 }) * 1024 * 1024,
  maxUploadFiles: asInt(process.env.MAX_UPLOAD_FILES, 20, { min: 1, max: 200 }),
  uploadRateWindowMs: asInt(process.env.UPLOAD_RATE_WINDOW_MS, 60_000, { min: 1_000 }),
  uploadRateLimit: asInt(process.env.UPLOAD_RATE_LIMIT, 20, { min: 1 }),
  deleteRateWindowMs: asInt(process.env.DELETE_RATE_WINDOW_MS, 60_000, { min: 1_000 }),
  deleteRateLimit: asInt(process.env.DELETE_RATE_LIMIT, 10, { min: 1 }),
  messageRateWindowMs: asInt(process.env.MESSAGE_RATE_WINDOW_MS, 10_000, { min: 1_000 }),
  messageRateLimit: asInt(process.env.MESSAGE_RATE_LIMIT, 40, { min: 1 }),
  messageHistoryLimit: asInt(process.env.CHAT_MESSAGE_LIMIT, 1000, { min: 50, max: 10_000 }),
  initialMessageLimit: asInt(process.env.CHAT_INIT_LIMIT, 200, { min: 10, max: 2_000 }),
  nameListLimit: asInt(process.env.CHAT_NAME_LIMIT, 500, { min: 10, max: 5_000 }),
  messageTtlMs: asInt(process.env.CHAT_MESSAGE_TTL_HOURS, 24 * 7, { min: 1, max: 24 * 365 }) * 60 * 60 * 1000,
  staleUploadTtlMs: asInt(process.env.STALE_UPLOAD_TTL_HOURS, 0, { min: 0, max: 24 * 365 }) * 60 * 60 * 1000,
  cleanupIntervalMs: asInt(process.env.UPLOAD_CLEANUP_INTERVAL_MINUTES, 0, { min: 0, max: 24 * 60 }) * 60 * 1000,
  maxUploadsTotalBytes: asInt(process.env.MAX_TOTAL_UPLOADS_MB, 0, { min: 0, max: 1024 * 1024 }) * 1024 * 1024,
  maxImageDataUrlChars: asInt(process.env.MAX_IMAGE_DATAURL_MB, 8, { min: 1, max: 32 }) * 1024 * 1024,
  fileStatConcurrency: asInt(process.env.FILE_STAT_CONCURRENCY, 8, { min: 1, max: 64 }),
  fileDeleteConcurrency: asInt(process.env.FILE_DELETE_CONCURRENCY, 4, { min: 1, max: 32 }),
  chatSaveDebounceMs: asInt(process.env.CHAT_SAVE_DEBOUNCE_MS, 500, { min: 50, max: 30_000 }),
  allowExternalImageUrls: asBool(process.env.ALLOW_EXTERNAL_IMAGE_URLS, false),
  allowedUploadExts: (() => {
    const values = parseCsv(process.env.ALLOWED_UPLOAD_EXTS);
    return values.length ? toLowerSet(values) : null;
  })(),
  blockedUploadExts: toLowerSet([
    ...defaultBlockedUploadExts,
    ...parseCsv(process.env.BLOCKED_UPLOAD_EXTS)
  ]),
  storageBackend: (process.env.STORAGE_BACKEND || 'disk').trim().toLowerCase(),
  storageS3Bucket: (process.env.STORAGE_S3_BUCKET || '').trim(),
  storageS3Region: process.env.STORAGE_S3_REGION || 'us-east-1',
  storageS3Prefix: normalizeStoragePrefix(process.env.STORAGE_S3_PREFIX || 'uploads/'),
  storageS3Endpoint: (process.env.STORAGE_S3_ENDPOINT || '').trim(),
  storageS3AccessKey:
    process.env.STORAGE_S3_ACCESS_KEY ||
    process.env.AWS_ACCESS_KEY_ID ||
    '',
  storageS3SecretKey:
    process.env.STORAGE_S3_SECRET_KEY ||
    process.env.STORAGE_S3_SECRET_ACCESS_KEY ||
    process.env.AWS_SECRET_ACCESS_KEY ||
    '',
  storageForcePathStyle: asBool(process.env.STORAGE_S3_FORCE_PATH_STYLE, true),
  inviteCodes: toLowerSet(parseCsv(process.env.AUTH_INVITE_CODES || '')),
  httpsKeyFile: (process.env.HTTPS_KEY_FILE || '').trim(),
  httpsCertFile: (process.env.HTTPS_CERT_FILE || '').trim(),
  httpsCaFile: (process.env.HTTPS_CA_FILE || '').trim(),
  httpsPassphrase: (process.env.HTTPS_PASSPHRASE || '').trim()
};

const redisUrl = (process.env.REDIS_URL || '').trim();
const redisChatKey = 'sharechat:chats';
const redisChatChannel = 'sharechat:chats_update';
const redisSocketEventChannel = 'sharechat:socket_event';
const redisRateLimitPrefix = 'rate';
let redisClient: Redis | null = null;
let redisSubscriber: Redis | null = null;
let lastChatBroadcastMarker: string | null = null;
const instanceId = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
const storageBackend =
  config.storageBackend === 's3' || config.storageBackend === 'minio' ? config.storageBackend : 'disk';

const storage = createStorageAdapter({
  backend: storageBackend,
  local: { uploadsPath: UPLOADS },
  s3: {
    bucket: config.storageS3Bucket,
    region: config.storageS3Region,
    prefix: config.storageS3Prefix,
    endpoint: config.storageS3Endpoint || undefined,
    accessKeyId: config.storageS3AccessKey || undefined,
    secretAccessKey: config.storageS3SecretKey || undefined,
    forcePathStyle: config.storageForcePathStyle
  }
});

let httpsOptions: https.ServerOptions | null = null;
let httpsOptionsError: Error | null = null;

(() => {
  if (!config.httpsKeyFile && !config.httpsCertFile) return;
  if (!config.httpsKeyFile || !config.httpsCertFile) {
    httpsOptionsError = new Error('HTTPS_KEY_FILE and HTTPS_CERT_FILE must be provided together');
    return;
  }

  try {
    const key = fs.readFileSync(path.resolve(APP_ROOT, config.httpsKeyFile));
    const cert = fs.readFileSync(path.resolve(APP_ROOT, config.httpsCertFile));
    const options: https.ServerOptions = { key, cert };
    if (config.httpsCaFile) options.ca = fs.readFileSync(path.resolve(APP_ROOT, config.httpsCaFile));
    if (config.httpsPassphrase) options.passphrase = config.httpsPassphrase;
    httpsOptions = options;
    log('info', 'https.options_loaded', {
      key: config.httpsKeyFile,
      cert: config.httpsCertFile
    });
  } catch (error) {
    const message = createJsonResponseError(error, 'https option load failed');
    httpsOptionsError = new Error(message);
    log('error', 'https.options_load_failed', { error: message });
  }
})();

const inviteCodes = config.inviteCodes;

type RateState = {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
  resetAt: number;
};

async function initRedis(): Promise<void> {
  if (!redisUrl) {
    setRedisConnected(false);
    return;
  }

  redisClient = new Redis(redisUrl, { lazyConnect: true });
  redisClient.on('connect', () => {
    setRedisConnected(true);
  });
  redisClient.on('close', () => {
    setRedisConnected(false);
  });
  redisClient.on('error', (error) => {
    setRedisConnected(false);
    log('error', 'redis.client_error', { error: createJsonResponseError(error, 'redis error') });
  });

  await redisClient.connect();

  redisSubscriber = redisClient.duplicate({ lazyConnect: true });
  redisSubscriber.on('error', (error) => {
    log('error', 'redis.subscriber_error', { error: createJsonResponseError(error, 'redis error') });
  });

  await redisSubscriber.connect();
  await redisSubscriber.subscribe(redisChatChannel);
  await redisSubscriber.subscribe(redisSocketEventChannel);
  redisSubscriber.on('message', (channel, message) => {
    if (!message) return;
    if (channel === redisChatChannel) {
      if (message === lastChatBroadcastMarker) {
        lastChatBroadcastMarker = null;
        return;
      }
      void reloadChatsFromRedis();
      return;
    }

    if (channel !== redisSocketEventChannel) return;

    try {
      const payload = JSON.parse(message);
      if (!payload || payload.source === instanceId || !payload.event) return;
      io.emit(String(payload.event), payload.payload);
    } catch (error) {
      log('error', 'redis.socket_event_parse_failed', {
        error: createJsonResponseError(error, 'socket event parse failed')
      });
    }
  });
}

async function broadcastChats(payload: string): Promise<void> {
  if (!redisClient) return;
  const marker = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  lastChatBroadcastMarker = marker;
  await redisClient.set(redisChatKey, payload);
  await redisClient.publish(redisChatChannel, marker);
}

async function broadcastSocketEvent(event: string, payload: unknown): Promise<void> {
  if (!redisClient) return;
  await redisClient.publish(
    redisSocketEventChannel,
    JSON.stringify({
      source: instanceId,
      event,
      payload
    })
  );
}

async function reloadChatsFromRedis(): Promise<boolean> {
  if (!redisClient) return false;
  try {
    const payload = await redisClient.get(redisChatKey);
    if (!payload) return false;
    const parsed = JSON.parse(payload);
    const source = Array.isArray(parsed) ? parsed : parsed.chats;
    if (!Array.isArray(source)) return false;
    hydrateChats(source);
    return true;
  } catch (error) {
    log('error', 'redis.chats_reload_failed', {
      error: createJsonResponseError(error, 'redis reload failed')
    });
    return false;
  }
}

function hydrateChats(source: any[]) {
  chats.clear();
  for (const item of source) {
    const id = Number(item.id);
    if (!Number.isInteger(id)) continue;
    const chat = createChatRecord(item.messages);
    pruneChat(chat);
    chats.set(id, chat);
  }
  if (!chats.size) chats.set(1, createChatRecord());
  setChatCount(chats.size);
}

async function tryLoadChatsFromRedis(): Promise<boolean> {
  if (!redisClient) return false;
  return reloadChatsFromRedis();
}

async function consumeRateLimitRedis(
  key: string,
  limit: number,
  windowMs: number
): Promise<RateState> {
  if (!redisClient) throw new Error('redis missing');
  const pipeline = redisClient.multi();
  pipeline.incr(key);
  pipeline.pexpire(key, windowMs);
  pipeline.pttl(key);
  const results = await pipeline.exec();
  const count = Number(results?.[0]?.[1] ?? 0);
  const ttl = Number(results?.[2]?.[1] ?? windowMs) || windowMs;
  const resetAt = Date.now() + ttl;
  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    retryAfterMs: Math.max(0, resetAt - Date.now()),
    resetAt
  };
}
type Recordish = Record<string, unknown>;

type AllowedEntry =
  | { kind: 'exact'; value: string }
  | { kind: 'cidr4'; base: number; mask: number }
  | { kind: 'wild'; rx: RegExp };

interface RateBucket {
  count: number;
  resetAt: number;
}

type UploadFileInfo = {
  name: string;
  size: number;
  mtimeMs: number;
};

type ScanResult = {
  files: UploadFileInfo[];
  totalBytes: number;
};

type UploadedFileMeta = {
  name: string;
  size: number;
  type: string;
  url: string;
};

type RequestLike = Request | IncomingMessage;

function log(level: 'info' | 'error', event: string, details: Recordish = {}) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    event,
    ...details
  };

  const line = JSON.stringify(payload);
  if (level === 'error') console.error(line);
  else console.log(line);
}

function safeBasename(name: unknown): string {
  return path.basename(String(name || ''));
}

function maybeFixLatin1Utf8(name: string): string {
  if (/[ГѓГ‚ГђГ‘][\x80-\xBF]/.test(name)) {
    try {
      return Buffer.from(name, 'latin1').toString('utf8');
    } catch {}
  }
  return String(name);
}

function safeFileName(rawName: unknown): string {
  const raw = maybeFixLatin1Utf8(String(rawName || 'file')).normalize('NFC');
  return (raw
    .replace(/[\\\/<>:"|?*\x00-\x1F]/g, '_')
    .replace(/[^\p{L}\p{N}\-_.+()\[\] ]/gu, '_')
    .replace(/\s+/g, ' ')
    .trim() || 'file');
}

function extOf(name: unknown): string {
  return (String(name || '').split('.').pop() || '').toLowerCase();
}

function fileUrl(fileName: string): string {
  return `/uploads/${encodeURIComponent(fileName)}`;
}

function guessMime(fileName: string): string {
  return mime.lookup(fileName) || 'application/octet-stream';
}

function encodeRFC5987ValueChars(value: string): string {
  return encodeURIComponent(value)
    .replace(/['()*]/g, (char) => {
      const hex = char.charCodeAt(0).toString(16).toUpperCase();
      return `%${hex}`;
    });
}

function formatContentDisposition(fileName: string, inline: boolean): string {
  const disposition = inline ? 'inline' : 'attachment';
  const fallback = fileName.replace(/["\\\r\n]/g, '_') || 'file';
  const encoded = encodeRFC5987ValueChars(fileName);
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function extFromMime(type: unknown): string {
  const value = String(type || '').toLowerCase().split(';')[0];
  if (!value) return '';
  if (value === 'image/svg+xml') return 'svg';
  return mime.extension(value) || (value.includes('/') ? value.split('/')[1] : '');
}

function getClientIP(req: RequestLike): string {
  const forwardedHeader = req.headers?.['x-forwarded-for'];
  const forwardedValue = Array.isArray(forwardedHeader)
    ? forwardedHeader[0]
    : forwardedHeader;
  const forwarded = String(forwardedValue || '').split(',')[0].trim();
  let ip = forwarded;
  if (!ip) {
    ip = req.socket?.remoteAddress || req.connection?.remoteAddress || '';
  }
  ip = String(ip);
  ip = ip.replace(/^::ffff:/, '').split('%')[0];
  if (ip.includes(':') && ip.includes('.')) {
    const candidate = ip.split(':').pop();
    ip = candidate || ip;
  }
  return ip;
}

function normalizeOrigin(origin?: string | null): string {
  if (!origin) return '';
  try {
    return new URL(origin).origin;
  } catch {
    return '';
  }
}

function sameHostOrigin(origin: string, hostHeader: string): boolean {
  if (!origin || !hostHeader) return false;
  try {
    return new URL(origin).host === hostHeader;
  } catch {
    return false;
  }
}

function isOriginAllowed(origin?: string | null, hostHeader?: string): boolean {
  if (!origin) return true;
  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;
  if (config.allowedOrigins.size) return config.allowedOrigins.has(normalized);
  if (config.publicOrigin) return normalized === normalizeOrigin(config.publicOrigin);
  return sameHostOrigin(normalized, hostHeader || '');
}

function requestAcceptsHtml(req: RequestLike): boolean {
  return String(req.headers.accept || '').includes('text/html');
}

function loadAllowedIPsRaw(): string[] {
  try {
    const source = fs.readFileSync(ALLOWED_FILE, 'utf8');
    return source
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
  } catch {
    return [];
  }
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function parseAllowedEntry(entry: string): AllowedEntry | null {
  if (entry === 'localhost') return { kind: 'exact', value: '127.0.0.1' };
  if (entry === '::1') return { kind: 'exact', value: '::1' };

  if (entry.includes('/')) {
    const [base, bitsStr] = entry.split('/');
    const bits = Number(bitsStr);
    const baseInt = ipv4ToInt(base);
    if (baseInt == null || Number.isNaN(bits) || bits < 0 || bits > 32) return null;
    const mask = bits === 0 ? 0 : (~((1 << (32 - bits)) - 1)) >>> 0;
    return { kind: 'cidr4', base: baseInt & mask, mask };
  }

  if (entry.includes('*')) {
    const pattern = '^' + entry.replace(/\./g, '\\.').replace(/\*/g, '[^.]+') + '$';
    return { kind: 'wild', rx: new RegExp(pattern) };
  }

  return { kind: 'exact', value: entry };
}

let allowedRaw = loadAllowedIPsRaw();
let allowed: AllowedEntry[] = allowedRaw
  .map(parseAllowedEntry)
  .filter((entry): entry is AllowedEntry => Boolean(entry));

fs.watchFile(ALLOWED_FILE, () => {
  allowedRaw = loadAllowedIPsRaw();
  allowed = allowedRaw
    .map(parseAllowedEntry)
    .filter((entry): entry is AllowedEntry => Boolean(entry));
  log('info', 'allowed_ips.reloaded', { count: allowed.length });
});

function isAllowed(req: RequestLike): boolean {
  if (!allowed.length) return true;
  const ip = getClientIP(req);
  if (allowed.some((entry) => entry.kind === 'exact' && entry.value === ip)) return true;
  if (allowed.some((entry) => entry.kind === 'wild' && entry.rx.test(ip))) return true;

  const ipInt = ipv4ToInt(ip);
  if (ipInt != null) {
    for (const entry of allowed) {
      if (entry.kind === 'cidr4' && ((ipInt & entry.mask) === entry.base)) return true;
    }
  }
  return false;
}

function cleanupRateStore(store: Map<string, RateBucket>) {
  const now = Date.now();
  for (const [key, value] of store.entries()) {
    if (value.resetAt <= now) store.delete(key);
  }
}

function consumeRateLimit(
  store: Map<string, RateBucket>,
  key: string,
  limit: number,
  windowMs: number
): RateState {
  const now = Date.now();
  let bucket = store.get(key);

  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs };
  }

  bucket.count += 1;
  store.set(key, bucket);
  if (store.size > 5_000) cleanupRateStore(store);

  return {
    allowed: bucket.count <= limit,
    remaining: Math.max(0, limit - bucket.count),
    retryAfterMs: Math.max(0, bucket.resetAt - now),
    resetAt: bucket.resetAt
  };
}

async function getRateLimitState(
  scope: string,
  ip: string,
  limit: number,
  windowMs: number,
  store: Map<string, RateBucket>
): Promise<RateState> {
  if (redisClient) {
    try {
      return await consumeRateLimitRedis(`${redisRateLimitPrefix}:${scope}:${ip}`, limit, windowMs);
    } catch (error) {
      log('error', 'redis.rate_limit_failed', {
        error: createJsonResponseError(error, 'redis rate limit failed')
      });
    }
  }
  return consumeRateLimit(store, `${scope}:${ip}`, limit, windowMs);
}

function createRateLimitMiddleware(
  scope: string,
  { limit, windowMs }: { limit: number; windowMs: number }
): RequestHandler {
  const store = new Map<string, RateBucket>();
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ip = getClientIP(req) || 'unknown';
      const state = await getRateLimitState(scope, ip, limit, windowMs, store);
      res.setHeader('RateLimit-Limit', String(limit));
      res.setHeader('RateLimit-Remaining', String(state.remaining));
      res.setHeader('RateLimit-Reset', String(Math.ceil(state.resetAt / 1000)));

      if (state.allowed) return next();

      recordRateLimitHit(scope);

      log('info', 'http.rate_limited', {
        scope,
        ip,
        path: req.originalUrl,
        retryAfterMs: state.retryAfterMs
      });

      res.setHeader('Retry-After', String(Math.ceil(state.retryAfterMs / 1000)));
      return res.status(429).json({ ok: false, error: 'too many requests' });
    } catch (error) {
      log('error', 'rate_limit.middleware_failed', {
        scope,
        error: createJsonResponseError(error, 'rate limit failure')
      });
      return res.status(500).json({ ok: false, error: 'internal error' });
    }
  };
}

const uploadRateLimit = createRateLimitMiddleware('upload', {
  limit: config.uploadRateLimit,
  windowMs: config.uploadRateWindowMs
});

const deleteRateLimit = createRateLimitMiddleware('delete', {
  limit: config.deleteRateLimit,
  windowMs: config.deleteRateWindowMs
});

function isUploadAllowed(fileName: string): boolean {
  const ext = extOf(fileName);
  if (!ext) return true;
  if (config.allowedUploadExts && !config.allowedUploadExts.has(ext)) return false;
  return !config.blockedUploadExts.has(ext);
}

function shouldInlineUpload(fileName: string): boolean {
  return inlineUploadExts.has(extOf(fileName));
}

async function resolveUploadFileName(rawName: unknown, overwrite: boolean): Promise<string> {
  const original = maybeFixLatin1Utf8(String(rawName || ''));
  let baseName = safeFileName(original).replace(/\.+$/, '');
  let ext = extOf(baseName);

  if (!ext) {
    ext = extFromMime(guessMime(baseName)) || 'bin';
    if (baseName) baseName = `${baseName}.${ext}`;
  }

  if (!baseName) {
    baseName = `upload-${Date.now()}.${ext || 'bin'}`;
  }

  if (overwrite) {
    await storage.delete(baseName).catch(() => {});
    return baseName;
  }

  if (!(await storage.fileExists(baseName))) return baseName;

  const parsed = path.parse(baseName);
  for (let index = 1; index <= 9999; index += 1) {
    const candidate = `${parsed.name}-${index}${parsed.ext}`;
    if (!(await storage.fileExists(candidate))) return candidate;
  }

  return `${parsed.name}-${Date.now()}${parsed.ext}`;
}

function createJsonResponseError(error: unknown, fallback: string): string {
  if (!error) return fallback;
  if (typeof error === 'string') return error;

  if (typeof error === 'object' && error !== null) {
    const typedError = error as { message?: unknown };
    if (typeof typedError.message === 'string' && typedError.message) {
      return typedError.message;
    }
  }

  if (error instanceof Error && error.message) return error.message;
  return String(error) || fallback;
}

async function mapLimit<T, U>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<U | undefined>
): Promise<NonNullable<U>[]> {
  if (!items.length) return [];
  const results = new Array<U | undefined>(items.length);
  let index = 0;

  async function worker() {
    while (true) {
      const current = index;
      index += 1;
      if (current >= items.length) return;
      results[current] = await mapper(items[current], current);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results.filter((value): value is NonNullable<U> => value !== undefined);
}

function decodeUploadNameFromUrl(value: unknown): string {
  const source = String(value || '');
  if (!source.startsWith('/uploads/')) return '';
  try {
    return safeBasename(decodeURIComponent(source.slice('/uploads/'.length)));
  } catch {
    return '';
  }
}

function isChatImageFileName(fileName: string): boolean {
  return String(fileName || '').startsWith(CHAT_IMAGE_PREFIX);
}

async function scanUploadFiles(): Promise<ScanResult> {
  const files = await storage.list();
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  return { files, totalBytes };
}

async function ensureUploadQuota(additionalBytes = 0) {
  if (!config.maxUploadsTotalBytes) return;
  const { totalBytes } = await scanUploadFiles();
  if (totalBytes + additionalBytes > config.maxUploadsTotalBytes) {
    throw new Error('storage quota exceeded');
  }
}

function collectReferencedUploadNames(): Set<string> {
  const referenced = new Set<string>();
  for (const id of sortedIds()) {
    const chat = getChat(id);
    for (const message of chat.messages) {
      const uploadName = decodeUploadNameFromUrl(message.image);
      if (uploadName) referenced.add(uploadName);
    }
  }
  return referenced;
}

function pruneChatsMissingUploads(existingUploadNames: Set<string>): boolean {
  let changed = false;

  for (const id of sortedIds()) {
    const chat = getChat(id);
    const before = chat.messages.length;
    chat.messages = chat.messages.filter((message) => {
      const uploadName = decodeUploadNameFromUrl(message.image);
      if (!uploadName) return true;
      return existingUploadNames.has(uploadName);
    });

    if (chat.messages.length !== before) {
      pruneChat(chat);
      changed = true;
    }
  }

  if (changed) scheduleChatSave();
  return changed;
}

let uploadCleanupPromise: Promise<void> | null = null;
let uploadCleanupQueued = false;
let uploadCleanupTimer: NodeJS.Timeout | null = null;

async function runUploadCleanup(reason = 'manual') {
  if (uploadCleanupPromise) {
    uploadCleanupQueued = true;
    return uploadCleanupPromise;
  }

  uploadCleanupPromise = (async () => {
    const deleted: string[] = [];
    const now = Date.now();

    try {
      let scan = await scanUploadFiles();
      const existingNames = new Set(scan.files.map((file) => file.name));
      const chatsChanged = pruneChatsMissingUploads(existingNames);
      if (chatsChanged) {
        scan = await scanUploadFiles();
      }

      let referenced = collectReferencedUploadNames();
      const deletions: UploadFileInfo[] = [];

      for (const file of scan.files) {
        const isReferenced = referenced.has(file.name);
        const isOrphanChatImage = isChatImageFileName(file.name) && !isReferenced;
        const isExpiredGenericFile = config.staleUploadTtlMs > 0 && !isReferenced && (now - file.mtimeMs) > config.staleUploadTtlMs;
        if (isOrphanChatImage || isExpiredGenericFile) {
          deletions.push(file);
        }
      }

      if (deletions.length) {
        await mapLimit(deletions, config.fileDeleteConcurrency, async (file) => {
          await storage.delete(file.name).catch(() => {});
          deleted.push(file.name);
        });
        scan = await scanUploadFiles();
        referenced = collectReferencedUploadNames();
      }

      if (config.maxUploadsTotalBytes && scan.totalBytes > config.maxUploadsTotalBytes) {
        const removable = scan.files
          .filter((file) => !referenced.has(file.name))
          .sort((left, right) => {
            if (isChatImageFileName(left.name) !== isChatImageFileName(right.name)) {
              return isChatImageFileName(left.name) ? -1 : 1;
            }
            return left.mtimeMs - right.mtimeMs;
          });

        let bytesToFree = scan.totalBytes - config.maxUploadsTotalBytes;
        const quotaDeletes = [];
        for (const file of removable) {
          quotaDeletes.push(file);
          bytesToFree -= file.size;
          if (bytesToFree <= 0) break;
        }

        if (quotaDeletes.length) {
          await mapLimit(quotaDeletes, config.fileDeleteConcurrency, async (file) => {
            await storage.delete(file.name).catch(() => {});
            deleted.push(file.name);
          });
          scan = await scanUploadFiles();
        }
      }

      if (deleted.length) {
        io.emit('files:update');
      }

      recordCleanupRun(reason, 'ok');
      log('info', 'uploads.cleanup', {
        reason,
        deleted: deleted.length,
        totalBytes: scan.totalBytes
      });
    } catch (error) {
      recordCleanupRun(reason, 'error');
      log('error', 'uploads.cleanup_failed', {
        reason,
        error: createJsonResponseError(error, 'cleanup failed')
      });
    } finally {
      uploadCleanupPromise = null;
      if (uploadCleanupQueued) {
        uploadCleanupQueued = false;
        void runUploadCleanup('queued');
      }
    }
  })();

  return uploadCleanupPromise;
}

function scheduleUploadCleanup(reason = 'scheduled', delayMs = 1_000) {
  if (uploadCleanupTimer) return;
  uploadCleanupTimer = setTimeout(() => {
    uploadCleanupTimer = null;
    void runUploadCleanup(reason);
  }, delayMs);
  if (typeof uploadCleanupTimer.unref === 'function') uploadCleanupTimer.unref();
}

type ChatRecord = {
  messages: ChatMessage[];
  names: Set<string>;
};

function createChatRecord(messages: ChatMessage[] = []): ChatRecord {
  return {
    messages: Array.isArray(messages) ? messages : [],
    names: new Set()
  };
}

const chats = new Map<number, ChatRecord>();
let chatSaveTimer: NodeJS.Timeout | null = null;
let chatSavePromise: Promise<void> = Promise.resolve();

function rebuildChatNames(chat: ChatRecord) {
  chat.names = new Set(
    chat.messages
      .map((message) => String(message.name || '').trim())
      .filter(Boolean)
  );
}

function pruneChat(chat: ChatRecord) {
  const cutoff = Date.now() - config.messageTtlMs;
  chat.messages = chat.messages
    .filter((message) => message && Number.isFinite(Number(message.time)))
    .filter((message) => Number(message.time) >= cutoff)
    .slice(-config.messageHistoryLimit)
    .map((message) => {
      const normalized: ChatMessage = {
        id: Number(message.id) || 1,
        name: String(message.name || 'Anon').slice(0, 64),
        time: Number(message.time) || Date.now()
      };

      if (message.image) normalized.image = String(message.image);
      else normalized.text = String(message.text || '').slice(0, 10_000);
      return normalized;
    });

  rebuildChatNames(chat);
}

function ensureChat(idRaw: unknown): number {
  const id = Number(idRaw) || 1;
  if (!chats.has(id)) chats.set(id, createChatRecord());
  const chat = chats.get(id);
  pruneChat(chat!);
  return id;
}

function getChat(idRaw: unknown): ChatRecord {
  const id = ensureChat(idRaw);
  const chat = chats.get(id);
  if (!chat) throw new Error('chat missing');
  return chat;
}

function sortedIds() {
  return Array.from(chats.keys()).sort((a, b) => a - b);
}

function nextChatId() {
  return chats.size ? Math.max(...chats.keys()) + 1 : 1;
}

function serializeChats() {
  return sortedIds().map((id) => {
    const chat = getChat(id);
    return {
      id,
      messages: chat.messages
    };
  });
}

async function persistChats() {
  const payload = JSON.stringify({
    version: 1,
    savedAt: Date.now(),
    chats: serializeChats()
  }, null, 2);

  const tempFile = `${CHAT_STORE}.tmp`;
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.writeFile(tempFile, payload, 'utf8');
  await fsp.rm(CHAT_STORE, { force: true }).catch(() => {});
  await fsp.rename(tempFile, CHAT_STORE);
  log('info', 'chat_store.saved', { chats: chats.size });
  void broadcastChats(payload).catch((error) => {
    log('error', 'redis.chats_broadcast_failed', { error: createJsonResponseError(error, 'broadcast failed') });
  });
}

function scheduleChatSave() {
  if (chatSaveTimer) return;

  chatSaveTimer = setTimeout(() => {
    chatSaveTimer = null;
    chatSavePromise = persistChats().catch((error) => {
      log('error', 'chat_store.save_failed', { error: createJsonResponseError(error, 'save failed') });
    });
  }, config.chatSaveDebounceMs);

  if (typeof chatSaveTimer.unref === 'function') chatSaveTimer.unref();
}

async function flushChatSave() {
  if (chatSaveTimer) {
    clearTimeout(chatSaveTimer);
    chatSaveTimer = null;
    chatSavePromise = persistChats().catch((error) => {
      log('error', 'chat_store.save_failed', { error: createJsonResponseError(error, 'save failed') });
    });
  }

  await chatSavePromise;
}

async function loadChats() {
  if (await tryLoadChatsFromRedis()) return;

  try {
    const raw = await fsp.readFile(CHAT_STORE, 'utf8');
    const parsed = JSON.parse(raw);
    const source = Array.isArray(parsed) ? parsed : parsed.chats;
    if (!Array.isArray(source)) return;

    for (const item of source) {
      const id = Number(item.id);
      if (!Number.isInteger(id)) continue;
      const chat = createChatRecord(item.messages);
      pruneChat(chat);
      chats.set(id, chat);
    }
  } catch (error) {
    const errCode =
      typeof error === 'object' && error !== null && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined;
    if (errCode !== 'ENOENT') {
      log('error', 'chat_store.load_failed', { error: createJsonResponseError(error, 'load failed') });
    }
  }

  if (!chats.size) chats.set(1, createChatRecord());
  setChatCount(chats.size);
}

function chatInitPayload(id: number) {
  const chat = getChat(id);
  return {
    id,
    messages: chat.messages.slice(-config.initialMessageLimit),
    names: Array.from(chat.names).slice(0, config.nameListLimit)
  };
}

function chatNamesPayload(id: number) {
  const chat = getChat(id);
  return { id, names: Array.from(chat.names).slice(0, config.nameListLimit) };
}

function emitChatNames(id: number) {
  io.emit('chat:names', chatNamesPayload(id));
}

function appendChatMessage(id: number, message: ChatMessage) {
  const chat = getChat(id);
  chat.messages.push(message);
  pruneChat(chat);
  scheduleChatSave();
  scheduleUploadCleanup('chat-message');
}

function nextGeneratedName(prefix: string, ext: string) {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
}

async function persistDataUrlImage(dataUrl: string): Promise<string> {
  if (dataUrl.length > config.maxImageDataUrlChars) {
    throw new Error('image too large');
  }

  const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(dataUrl);
  if (!match) throw new Error('bad data url');

  const contentType = match[1].toLowerCase();
  const ext = extFromMime(contentType);
  if (!ext || !imageExts.has(ext)) throw new Error('unsupported image type');

  const buffer = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
  if (!buffer.length) throw new Error('empty image');
  if (buffer.length > config.maxHttpBufferSize) throw new Error('image too large');
  await ensureUploadQuota(buffer.length);

  const fileName = nextGeneratedName(CHAT_IMAGE_PREFIX.replace(/-$/, ''), ext);
  const saved = await storage.save(fileName, Readable.from([buffer]));
  return fileUrl(saved.name);
}

async function normalizeIncomingImage(image: unknown): Promise<string> {
  const source = String(image || '');
  if (!source) return '';
  if (source.startsWith('/uploads/')) return source;
  if (source.startsWith('data:')) return persistDataUrlImage(source);
  if (config.allowExternalImageUrls && /^https?:\/\//i.test(source)) return source;
  throw new Error('unsupported image src');
}

function buildUploadMeta(file: Express.Multer.File): UploadedFileMeta {
  return {
    name: file.filename,
    size: file.size,
    type: (file.mimetype && file.mimetype !== 'application/octet-stream') ? file.mimetype : guessMime(file.filename),
    url: fileUrl(file.filename)
  };
}

class AdapterStorageEngine implements multer.StorageEngine {
  _handleFile(req: Request, file: Express.Multer.File, cb: (error: Error | null, info?: Partial<Express.Multer.File>) => void): void {
    const overwrite = String(req.query.overwrite ?? req.body?.overwrite ?? 'true') !== 'false';
    resolveUploadFileName(file.originalname || '', overwrite)
      .then((fileName) => storage.save(fileName, file.stream))
      .then((saved) => {
        cb(null, {
          fieldname: file.fieldname,
          originalname: file.originalname,
          encoding: file.encoding,
          mimetype: file.mimetype,
          destination: UPLOADS,
          filename: saved.name,
          path: saved.name,
          size: saved.size
        } as Express.Multer.File);
      })
      .catch((error) => cb(error as Error));
  }

  _removeFile(_req: Request, file: Express.Multer.File, cb: (error: Error | null) => void): void {
    if (!file?.filename) return cb(null);
    storage
      .delete(file.filename)
      .then(() => cb(null))
      .catch((error) => cb(error as Error));
  }
}

const uploadAny = multer({
  storage: new AdapterStorageEngine(),
  limits: {
    fileSize: config.maxUploadBytes,
    files: config.maxUploadFiles
  },
  fileFilter: (_req: Request, file: Express.Multer.File, cb: FileFilterCallback) => {
    const normalized = safeFileName(file.originalname || '');
    if (!isUploadAllowed(normalized)) {
      return cb(new Error('upload type is blocked'));
    }
    return cb(null, true);
  }
}).any();

app.set('trust proxy', true);
app.use(express.urlencoded({ extended: true, limit: '256kb' }));
app.use(express.json({ limit: '256kb' }));

app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  res.on('finish', () => {
    if (!req.path.startsWith('/api') && !req.path.startsWith('/socket.io')) return;
    const durationMs = Date.now() - start;
    recordHttpRequest(req.method, normalizeMetricsPath(req.path), res.statusCode, durationMs);
    log('info', 'http.request', {
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      ip: getClientIP(req),
      durationMs
    });
  });
  next();
});

app.get('/api/health', (_req: Request, res: Response) => {
  const runtime = getRuntimeSnapshot();
  res.json({
    ok: true,
    nodeName: runtime.nodeName,
    storageBackend: runtime.storageBackend,
    redisEnabled: runtime.redisEnabled,
    redisConnected: runtime.redisConnected,
    uptimeSec: runtime.uptimeSec,
    chats: runtime.chats,
    activeSockets: runtime.activeSockets
  });
});

app.get('/api/ready', (_req: Request, res: Response) => {
  res.json({ ok: true, ...getRuntimeSnapshot() });
});

app.get('/api/live', (_req: Request, res: Response) => {
  res.json({ ok: true, uptimeSec: Math.round(process.uptime()) });
});

app.get('/api/runtime', (_req: Request, res: Response) => {
  res.json({ ok: true, runtime: getRuntimeSnapshot() });
});

app.get('/api/metrics', (_req: Request, res: Response) => {
  res.type('text/plain; version=0.0.4; charset=utf-8');
  res.send(renderPrometheusMetrics());
});

app.get('/api/ip', (req: Request, res: Response) => {
  res.json({ ok: true, ip: getClientIP(req) });
});

app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  if (origin && isOriginAllowed(origin, req.headers.host || '')) {
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Origin', normalizeOrigin(origin));
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  }

  res.setHeader('Permissions-Policy', 'clipboard-write=(self)');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  return next();
});

app.use((req: Request, res: Response, next: NextFunction) => {
  if (
    req.path === '/api/health' ||
    req.path === '/api/ready' ||
    req.path === '/api/live' ||
    req.path === '/api/runtime' ||
    req.path === '/api/metrics'
  ) {
    return next();
  }
  if (!isAllowed(req)) {
    log('info', 'http.ip_blocked', { ip: getClientIP(req), path: req.originalUrl });
    if (requestAcceptsHtml(req)) {
      return res.status(403).sendFile(BLOCKED_PAGE, (error) => {
        if (error && !res.headersSent) {
          res.status(403).send('<h1>403</h1>');
        }
      });
    }
    return res.status(403).json({ ok: false, error: 'ip forbidden' });
  }
  if (!isOriginAllowed(req.headers.origin, req.headers.host || '')) {
    log('info', 'http.origin_blocked', { origin: req.headers.origin || '', path: req.originalUrl });
    return res.status(403).json({ ok: false, error: 'origin forbidden' });
  }
  if (isInviteRequired()) {
    const invite = extractInviteFromRequest(req);
    if (!isInviteAuthorized(invite)) {
      log('info', 'http.invite_blocked', { path: req.originalUrl, ip: getClientIP(req) });
      return respondInviteRequired(req, res);
    }
    setInviteCookie(res, invite, req.secure);
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
});

app.use('/public', express.static(PUBLIC, {
  maxAge: 0,
  setHeaders(res: Response) {
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
  }
}));

app.get('/uploads/:name', async (req: Request, res: Response) => {
  const rawName = normalizeParam(req.params.name);
  let decodedName = rawName;
  try {
    decodedName = decodeURIComponent(rawName);
  } catch {
    decodedName = rawName;
  }
  const fileName = safeBasename(decodedName);
  if (!fileName) return res.status(404).send('Not found');

  const file = await storage.stat(fileName);
  if (!file) return res.status(404).send('Not found');

  res.setHeader('Cache-Control', 'no-store, must-revalidate');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Content-Type', guessMime(fileName));
  res.setHeader('Content-Disposition', formatContentDisposition(fileName, shouldInlineUpload(fileName)));

  const stream = await storage.createReadStream(fileName);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
});

app.post('/api/upload', uploadRateLimit, (req: Request, res: Response) => {
  uploadAny(req, res, (error: unknown) => {
    if (error) {
      recordUploadFailure('upload-middleware');
      log('info', 'upload.rejected', {
        ip: getClientIP(req),
        error: createJsonResponseError(error, 'upload failed')
      });
      return res.status(400).json({ ok: false, error: createJsonResponseError(error, 'upload failed') });
    }

    const uploadedFiles = Array.isArray(req.files) ? req.files : [];
    const files = uploadedFiles.map(buildUploadMeta);
    if (!files.length) {
      return res.status(400).json({ ok: false, error: 'no files uploaded' });
    }

    if (config.maxUploadsTotalBytes) {
      scanUploadFiles()
        .then(async (scan) => {
          let current = scan;
          if (current.totalBytes > config.maxUploadsTotalBytes) {
            await runUploadCleanup('upload-quota');
            current = await scanUploadFiles();
          }

          if (current.totalBytes <= config.maxUploadsTotalBytes) {
            files.forEach((file) => {
              io.emit('file:new', file);
              void broadcastSocketEvent('file:new', file);
            });
            io.emit('files:update');
            void broadcastSocketEvent('files:update', {});
            recordUploadCompleted(
              files.length,
              files.reduce((sum, file) => sum + Number(file.size || 0), 0)
            );

            log('info', 'upload.completed', {
              ip: getClientIP(req),
              files: files.length,
              bytes: files.reduce((sum, file) => sum + Number(file.size || 0), 0)
            });

            return res.json({ ok: true, files });
          }

          await mapLimit(
            uploadedFiles
              .map((file) => file.filename)
              .filter(Boolean),
            config.fileDeleteConcurrency,
            async (target) => storage.delete(target).catch(() => {})
          );

          log('info', 'upload.rejected_quota', {
            ip: getClientIP(req),
            files: files.length,
            totalBytes: current.totalBytes
          });

          recordUploadFailure('quota');
          return res.status(507).json({ ok: false, error: 'storage quota exceeded' });
        })
        .catch((scanError) => {
          recordUploadFailure('postcheck');
          log('error', 'upload.postcheck_failed', {
            error: createJsonResponseError(scanError, 'upload postcheck failed')
          });
          return res.status(500).json({ ok: false, error: 'upload failed' });
        });
      return;
    }

    files.forEach((file) => {
      io.emit('file:new', file);
      void broadcastSocketEvent('file:new', file);
    });
    io.emit('files:update');
    void broadcastSocketEvent('files:update', {});
    recordUploadCompleted(
      files.length,
      files.reduce((sum, file) => sum + Number(file.size || 0), 0)
    );

    log('info', 'upload.completed', {
      ip: getClientIP(req),
      files: files.length,
      bytes: files.reduce((sum, file) => sum + Number(file.size || 0), 0)
    });

    return res.json({ ok: true, files });
  });
});

app.get('/api/files', async (_req: Request, res: Response) => {
  try {
    const scan = await scanUploadFiles();
    const files = scan.files
      .filter((entry) => !imageExts.has(extOf(entry.name)))
      .map((entry) => ({ name: entry.name, size: entry.size, mtime: entry.mtimeMs }));

    files.sort((a, b) => b.mtime - a.mtime);
    res.json({ ok: true, files });
  } catch (error) {
    log('error', 'files.list_failed', { error: createJsonResponseError(error, 'list failed') });
    res.status(500).json({ ok: false, error: 'failed to list files' });
  }
});

app.delete('/api/files', deleteRateLimit, async (_req: Request, res: Response) => {
  try {
    const scan = await scanUploadFiles();
    await mapLimit(scan.files, config.fileDeleteConcurrency, async (entry) => {
      await storage.delete(entry.name);
    });

    scheduleUploadCleanup('delete-all');
    io.emit('files:update');
    void broadcastSocketEvent('files:update', {});
    res.json({ ok: true, deleted: scan.files.length });
  } catch (error) {
    log('error', 'files.delete_all_failed', { error: createJsonResponseError(error, 'delete failed') });
    res.status(500).json({ ok: false, error: 'failed to delete files' });
  }
});

app.delete('/api/files/:name', deleteRateLimit, async (req: Request, res: Response) => {
  try {
    const rawName = normalizeParam(req.params.name);
    const name = safeBasename(decodeURIComponent(rawName));
    if (!name) return res.status(404).json({ ok: false, error: 'not found' });

    const stats = await storage.stat(name);
    if (!stats) return res.status(404).json({ ok: false, error: 'not found' });

    await storage.delete(name);

    scheduleUploadCleanup('delete-file');
    io.emit('files:update');
    void broadcastSocketEvent('files:update', {});
    res.json({ ok: true });
  } catch (error) {
    log('error', 'files.delete_failed', { error: createJsonResponseError(error, 'delete failed') });
    res.status(500).json({ ok: false, error: 'failed to delete file' });
  }
});

app.get('/preview/:name', async (req: Request, res: Response) => {
  const rawName = normalizeParam(req.params.name);
  const name = safeBasename(decodeURIComponent(rawName));
  if (!textExts.has(extOf(name))) return res.status(415).send('Unsupported preview');

  const stats = await storage.stat(name);
  if (!stats) return res.status(404).send('Not found');

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  const stream = await storage.createReadStream(name);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
});

app.get('/api/chats', (_req: Request, res: Response) => {
  res.json({ ok: true, chats: sortedIds() });
});

app.post('/api/chats', (_req: Request, res: Response) => {
  const id = nextChatId();
  ensureChat(id);
  setChatCount(chats.size);
  scheduleChatSave();
  scheduleUploadCleanup('create-chat');
  const payload = { chats: sortedIds() };
  io.emit('chats:list', payload);
  void broadcastSocketEvent('chats:list', payload);
  res.status(201).json({ ok: true, id });
});

app.delete('/api/chats/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: 'bad id' });
  if (!chats.has(id)) return res.sendStatus(204);

  chats.delete(id);
  if (!chats.size) ensureChat(1);
  setChatCount(chats.size);
  scheduleChatSave();
  scheduleUploadCleanup('delete-chat');

  const payload = { chats: sortedIds() };
  io.emit('chats:list', payload);
  void broadcastSocketEvent('chats:list', payload);
  res.sendStatus(204);
});

app.delete('/api/chats/:id/messages', async (req: Request, res: Response) => {
  try {
    const id = ensureChat(req.params.id);
    const chat = getChat(id);
    chat.messages.length = 0;
    chat.names.clear();
    scheduleChatSave();
    scheduleUploadCleanup('clear-chat');
    const payload = { id, names: [] };
    io.emit('chat:cleared', payload);
    void broadcastSocketEvent('chat:cleared', payload);
    res.sendStatus(204);
  } catch (error) {
    log('error', 'chat.clear_failed', { error: createJsonResponseError(error, 'clear failed') });
    res.status(500).json({ ok: false, error: 'internal error' });
  }
});

app.get('/', (_req: Request, res: Response) => {
  res.sendFile(path.join(PUBLIC, 'index.html'));
});

const serverProtocol = httpsOptions ? 'https' : 'http';
const server = httpsOptions ? https.createServer(httpsOptions, app) : http.createServer(app);
const io = new SocketIOServer(server, {
  path: '/socket.io',
  maxHttpBufferSize: config.maxHttpBufferSize,
  transports: config.socketTransports,
  pingInterval: 25_000,
  pingTimeout: 20_000,
  allowRequest(request: IncomingMessage, callback: (err: string | null, success: boolean) => void) {
    const ipAllowed = isAllowed(request);
    const originAllowed = isOriginAllowed(request.headers.origin, request.headers.host || '');

    if (!ipAllowed || !originAllowed) {
      callback(null, false);
      return;
    }

    if (isInviteRequired()) {
      const invite = extractInviteFromRequest(request);
      if (!isInviteAuthorized(invite)) {
        log('info', 'socket.invite_blocked', {
          path: request.url || '',
          ip: getClientIP(request)
        });
        callback('invite required', false);
        return;
      }
    }

    callback(null, true);
  }
});

const socketMessageLimitStore = new Map();

io.on('connection', (socket: Socket) => {
  setActiveSockets(io.engine.clientsCount);
  recordSocketConnected();
  socket.data.clientIp = getClientIP(socket.request) || 'unknown';
  socket.emit('chats:list', { chats: sortedIds() });

  const firstChatId = sortedIds()[0] || 1;
  socket.emit('chat:init', chatInitPayload(firstChatId));

  socket.on('chat:select', (payload: ChatNamesPayload = {}) => {
    const wantedId = Number(payload?.id);
    const ids = sortedIds();
    const id = ids.includes(wantedId) ? wantedId : (ids[0] || 1);
    socket.emit('chat:init', chatInitPayload(id));
  });

  socket.on('chat:message', async (payload: Partial<ChatMessage> & { id?: number } = {}) => {
    const rate = consumeRateLimit(
      socketMessageLimitStore,
      `chat:${socket.data.clientIp}`,
      config.messageRateLimit,
      config.messageRateWindowMs
    );

    if (!rate.allowed) {
      recordRateLimitHit('chat');
      socket.emit('chat:error', { error: 'too many messages' });
      return;
    }

    try {
      const id = Number(payload.id);
      const name = String(payload.name || 'Anon').slice(0, 64);
      const text = payload.text != null ? String(payload.text).slice(0, 10_000) : '';
      const image = payload.image != null ? String(payload.image) : '';

      if (!Number.isInteger(id)) return;
      if (!text && !image) return;

      const message: ChatMessage = {
        id,
        name,
        time: Date.now()
      };

      if (image) message.image = await normalizeIncomingImage(image);
      else message.text = text;

      appendChatMessage(id, message);
      recordChatMessage(image ? 'image' : 'text');
      io.emit('chat:message', message);
      void broadcastSocketEvent('chat:message', message);
      emitChatNames(id);
      void broadcastSocketEvent('chat:names', chatNamesPayload(id));
    } catch (error) {
      log('error', 'chat.message_failed', {
        error: createJsonResponseError(error, 'chat failed'),
        ip: socket.data.clientIp
      });
      socket.emit('chat:error', { error: createJsonResponseError(error, 'chat failed') });
    }
  });

  socket.on('image:upload', async (payload: { id?: number; name?: string; base64?: string } = {}) => {
    const rate = consumeRateLimit(
      socketMessageLimitStore,
      `image:${socket.data.clientIp}`,
      config.messageRateLimit,
      config.messageRateWindowMs
    );

    if (!rate.allowed) {
      recordRateLimitHit('image');
      socket.emit('image:uploaded', { ok: false, error: 'too many messages' });
      return;
    }

    try {
      const id = Number(payload.id) || 1;
      const name = String(payload.name || 'Anon').slice(0, 64);
      const image = await normalizeIncomingImage(payload.base64 || '');
      const message = { id, name, time: Date.now(), image };

      appendChatMessage(id, message);
      recordChatMessage('image');
      io.emit('chat:message', message);
      void broadcastSocketEvent('chat:message', message);
      emitChatNames(id);
      void broadcastSocketEvent('chat:names', chatNamesPayload(id));
      socket.emit('image:uploaded', { ok: true, image });
    } catch (error) {
      recordUploadFailure('socket-image');
      socket.emit('image:uploaded', {
        ok: false,
        error: createJsonResponseError(error, 'image upload failed')
      });
    }
  });

  socket.on('chat:clear', (payload: { id?: number } = {}) => {
    try {
      const id = ensureChat(payload.id);
      const chat = getChat(id);
      chat.messages.length = 0;
      chat.names.clear();
      scheduleChatSave();
      scheduleUploadCleanup('socket-clear-chat');
      const clearedPayload = { id, names: [] };
      io.emit('chat:cleared', clearedPayload);
      void broadcastSocketEvent('chat:cleared', clearedPayload);
    } catch (error) {
      log('error', 'socket.chat_clear_failed', {
        error: createJsonResponseError(error, 'socket clear failed')
      });
    }
  });

  socket.on('disconnect', (reason: string) => {
    setActiveSockets(io.engine.clientsCount);
    recordSocketDisconnected(reason || 'unknown');
  });
});

app.use(
  (error: unknown, req: Request, res: Response, _next: NextFunction) => {
  log('error', 'http.unhandled_error', {
    path: req.originalUrl,
    error: createJsonResponseError(error, 'unexpected error')
  });
  res.status(500).json({ ok: false, error: 'internal server error' });
});

let shuttingDown = false;
let uploadCleanupInterval: NodeJS.Timeout | null = null;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;

  if (uploadCleanupTimer) {
    clearTimeout(uploadCleanupTimer);
    uploadCleanupTimer = null;
  }
  if (uploadCleanupInterval) {
    clearInterval(uploadCleanupInterval);
    uploadCleanupInterval = null;
  }

  log('info', 'server.shutdown', { signal });
  try {
    await runUploadCleanup('shutdown');
    await flushChatSave();
    if (redisSubscriber) {
      await redisSubscriber.unsubscribe(redisChatChannel).catch(() => {});
      await redisSubscriber.quit().catch(() => {});
      redisSubscriber = null;
    }
    if (redisClient) {
      await redisClient.quit().catch(() => {});
      redisClient = null;
    }
  } catch {}

  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

async function start() {
  if (httpsOptionsError) {
    throw httpsOptionsError;
  }
  initializeRuntimeMetrics({
    nodeName: config.nodeName,
    storageBackend,
    redisEnabled: Boolean(redisUrl),
    protocol: serverProtocol
  });
  await fsp.mkdir(UPLOADS, { recursive: true });
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await storage.init();
  await initRedis();
  await loadChats();
  await runUploadCleanup('startup');

  if (config.cleanupIntervalMs > 0) {
    uploadCleanupInterval = setInterval(() => {
      void runUploadCleanup('interval');
    }, config.cleanupIntervalMs);
    if (typeof uploadCleanupInterval.unref === 'function') uploadCleanupInterval.unref();
  }

  server.listen(config.port, () => {
    setChatCount(chats.size);
    setActiveSockets(0);
    setRedisConnected(Boolean(redisClient));
    log('info', 'server.started', {
      nodeName: config.nodeName,
      port: config.port,
      uploads: UPLOADS,
      allowedOrigins: Array.from(config.allowedOrigins),
      protocol: serverProtocol
    });
  });
}

start().catch((error) => {
  log('error', 'server.start_failed', { error: createJsonResponseError(error, 'startup failed') });
  process.exit(1);
});
