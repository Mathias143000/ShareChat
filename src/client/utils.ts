export function $<T extends Element>(selector: string): T | null {
  return document.querySelector<T>(selector);
}

export function fmtTime(time: number): string {
  return new Date(time).toLocaleString();
}

export function esc(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (char) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] || char
  ));
}

const imageExts = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'heic', 'heif', 'avif']);

export function isImageFile(file: File | null | undefined): boolean {
  return Boolean(file && /^image\//i.test(file.type));
}

export function isImageName(name = ''): boolean {
  return imageExts.has(String(name).split('.').pop()?.toLowerCase() || '');
}

export function isTextName(name = ''): boolean {
  return /\.(txt|md|json|csv|log|js|ts|py|html|css|xml|yml|yaml|sh|bat|conf|ini)$/i.test(name);
}

export function isAudioName(name = ''): boolean {
  return /\.(mp3|wav|ogg|m4a|flac)$/i.test(name);
}

export function isVideoName(name = ''): boolean {
  return /\.(mp4|webm|mkv|mov)$/i.test(name);
}

export function formatBytes(bytes: number): string {
  const value = Number(bytes) || 0;
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  if (value < 1024) return `${value} bytes`;

  let unitIndex = 0;
  let size = value;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size < 10 ? 1 : 0)} ${units[unitIndex]}`;
}

export async function copyPlainText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}

  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.readOnly = true;
    textarea.style.position = 'fixed';
    textarea.style.top = '-2000px';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    const copied = document.execCommand('copy');
    document.body.removeChild(textarea);
    return copied;
  } catch {
    return false;
  }
}

export function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

export function canvasToBlob(canvas: HTMLCanvasElement, type = 'image/png', quality = 0.92): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Canvas export failed'));
    }, type, quality);
  });
}
