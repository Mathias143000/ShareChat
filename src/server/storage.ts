import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { type Readable } from 'stream';

import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3ClientConfig,
  S3Client
} from '@aws-sdk/client-s3';

const fsp = fs.promises;

async function readableToBuffer(source: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of source) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export type StorageFile = {
  name: string;
  size: number;
  mtimeMs: number;
};

export interface StorageAdapter {
  init(): Promise<void>;
  fileExists(name: string): Promise<boolean>;
  stat(name: string): Promise<StorageFile | null>;
  list(): Promise<StorageFile[]>;
  save(name: string, source: Readable): Promise<StorageFile>;
  delete(name: string): Promise<void>;
  deleteMany(names: string[]): Promise<void>;
  createReadStream(name: string): Promise<Readable>;
}

export interface LocalStorageConfig {
  uploadsPath: string;
}

export interface S3StorageConfig {
  bucket: string;
  region: string;
  prefix: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
}

export interface StorageConfig {
  backend: 'disk' | 's3' | 'minio';
  local: LocalStorageConfig;
  s3: Partial<S3StorageConfig>;
}

function isNotFoundError(error: unknown): boolean {
  if (
    error instanceof Error &&
    (error.name === 'NotFound' || error.name === 'NoSuchKey' || /NotFound/.test(error.message || ''))
  ) {
    return true;
  }

  const metadata = (error as { $metadata?: { httpStatusCode?: number } }).$metadata;
  return metadata?.httpStatusCode === 404;
}

export function createStorageAdapter(config: StorageConfig): StorageAdapter {
  if (config.backend === 's3' || config.backend === 'minio') {
    if (!config.s3.bucket) {
      throw new Error('S3 bucket is required');
    }

    return new S3StorageAdapter({
      bucket: config.s3.bucket || '',
      region: config.s3.region || 'us-east-1',
      prefix: config.s3.prefix || '',
      endpoint: config.s3.endpoint,
      accessKeyId: config.s3.accessKeyId,
      secretAccessKey: config.s3.secretAccessKey,
      forcePathStyle: config.s3.forcePathStyle
    });
  }

  return new LocalStorageAdapter(config.local.uploadsPath);
}

class LocalStorageAdapter implements StorageAdapter {
  private readonly basePath: string;

  constructor(basePath: string) {
    this.basePath = path.resolve(basePath);
  }

  async init(): Promise<void> {
    await fsp.mkdir(this.basePath, { recursive: true });
  }

  private resolve(name: string) {
    return path.join(this.basePath, name);
  }

  async fileExists(name: string): Promise<boolean> {
    try {
      await fsp.access(this.resolve(name), fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async stat(name: string): Promise<StorageFile | null> {
    try {
      const stats = await fsp.stat(this.resolve(name));
      if (!stats.isFile()) return null;
      return {
        name,
        size: Number(stats.size) || 0,
        mtimeMs: Number(stats.mtimeMs) || 0
      };
    } catch {
      return null;
    }
  }

  async list(): Promise<StorageFile[]> {
    const entries = await fsp.readdir(this.basePath, { withFileTypes: true });
    const files: StorageFile[] = [];

    await Promise.all(
      entries
        .filter((entry) => entry.isFile())
        .map(async (entry) => {
          const stats = await fsp.stat(this.resolve(entry.name));
          files.push({
            name: entry.name,
            size: Number(stats.size) || 0,
            mtimeMs: Number(stats.mtimeMs) || 0
          });
        })
    );

    files.sort((a, b) => a.name.localeCompare(b.name));
    return files;
  }

  async save(name: string, source: Readable): Promise<StorageFile> {
    const target = this.resolve(name);
    const stream = fs.createWriteStream(target, { flags: 'wx' });
    await pipeline(source, stream);
    const stats = await fsp.stat(target);
    return {
      name,
      size: Number(stats.size) || 0,
      mtimeMs: Number(stats.mtimeMs) || 0
    };
  }

  async delete(name: string): Promise<void> {
    await fsp.rm(this.resolve(name), { force: true });
  }

  async deleteMany(names: string[]): Promise<void> {
    await Promise.all(names.map((name) => this.delete(name)));
  }

  async createReadStream(name: string): Promise<Readable> {
    return fs.createReadStream(this.resolve(name));
  }
}

class S3StorageAdapter implements StorageAdapter {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(private readonly options: S3StorageConfig) {
    const credentials =
      options.accessKeyId && options.secretAccessKey
        ? {
            accessKeyId: options.accessKeyId,
            secretAccessKey: options.secretAccessKey
          }
        : undefined;

    const clientConfig: S3ClientConfig = {
      region: options.region,
      endpoint: options.endpoint,
      forcePathStyle: options.forcePathStyle,
      credentials
    };

    this.bucket = options.bucket;
    this.prefix = options.prefix || '';
    this.client = new S3Client(clientConfig);
  }

  private key(filename: string) {
    return `${this.prefix}${filename}`;
  }

  async init(): Promise<void> {
    return;
  }

  async fileExists(name: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: this.key(name)
        })
      );
      return true;
    } catch (error: unknown) {
      if (isNotFoundError(error)) return false;
      throw error;
    }
  }

  async stat(name: string): Promise<StorageFile | null> {
    try {
      const response = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: this.key(name)
        })
      );
      const size = response.ContentLength ?? 0;
      const mtime = response.LastModified ? response.LastModified.getTime() : 0;
      return {
        name,
        size: Number(size) || 0,
        mtimeMs: Number(mtime) || 0
      };
    } catch (error: unknown) {
      if (isNotFoundError(error)) return null;
      throw error;
    }
  }

  async list(): Promise<StorageFile[]> {
    const files: StorageFile[] = [];
    let continuation: string | undefined;

    do {
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: this.prefix,
          ContinuationToken: continuation
        })
      );

      for (const entry of response.Contents || []) {
        if (!entry.Key) continue;
        const name = entry.Key.startsWith(this.prefix) ? entry.Key.slice(this.prefix.length) : entry.Key;
        files.push({
          name,
          size: Number(entry.Size) || 0,
          mtimeMs: entry.LastModified ? entry.LastModified.getTime() : 0
        });
      }

      continuation = response.NextContinuationToken;
    } while (continuation);

    return files;
  }

  async save(name: string, source: Readable): Promise<StorageFile> {
    const body = await readableToBuffer(source);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.key(name),
        Body: body,
        ContentLength: body.length
      })
    );
    const stored = await this.stat(name);
    if (!stored) {
      throw new Error('s3 save failed');
    }
    return stored;
  }

  async delete(name: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: this.key(name)
      })
    );
  }

  async deleteMany(names: string[]): Promise<void> {
    const batchSize = 1000;

    for (let index = 0; index < names.length; index += batchSize) {
      const batch = names.slice(index, index + batchSize);
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: {
            Objects: batch.map((name) => ({ Key: this.key(name) }))
          }
        })
      );
    }
  }

  async createReadStream(name: string): Promise<Readable> {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.key(name)
      })
    );

    if (!response.Body) {
      throw new Error('s3 object missing body');
    }

    return response.Body as Readable;
  }
}
