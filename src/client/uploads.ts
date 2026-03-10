import { fetchJSON, getErrorMessage } from './api.js';
import { esc, formatBytes, fmtTime, isAudioName, isImageName, isTextName, isVideoName } from './utils.js';
import type { DeleteFilesResponse, FileListResponse, StatusKind, UploadListItem } from './types.js';

export type StatusSetter = (message: string, kind?: StatusKind, timeout?: number) => void;

interface UploadsOptions {
  dropzone: HTMLDivElement | null;
  fileInput: HTMLInputElement | null;
  deleteAllBtn: HTMLButtonElement | null;
  filesEl: HTMLElement | null;
  setStatus: StatusSetter;
}

export interface UploadsController {
  loadFiles: (options?: { silent?: boolean }) => Promise<void>;
}

export function initUploads({ dropzone, fileInput, deleteAllBtn, filesEl, setStatus }: UploadsOptions): UploadsController {
  const queue: Array<{ file: File }> = [];
  let uploading = false;

  async function loadFiles({ silent = false } = {}): Promise<void> {
    try {
      const response = await fetchJSON<FileListResponse>('/api/files', undefined, 'Failed to load files');
      const files = (response.files || []).filter((file) => !isImageName(file.name));
      renderFiles(files);
      if (!silent) setStatus('', 'info');
    } catch (error) {
      if (!silent) setStatus(getErrorMessage(error, 'Failed to load files.'), 'error', 5000);
    }
  }

  async function uploadOne(file: File): Promise<void> {
    const form = new FormData();
    form.append('files', file, file.name || `file-${Date.now()}`);
    setStatus(`Uploading ${file.name || 'file'}...`, 'info', 0);
    try {
      await fetchJSON('/api/upload?overwrite=true', { method: 'POST', body: form }, 'Upload failed');
      setStatus(`Uploaded ${file.name || 'file'}.`, 'success', 2000);
    } catch (error) {
      setStatus(getErrorMessage(error, 'Upload failed.'), 'error', 5000);
    } finally {
      await loadFiles({ silent: true });
    }
  }

  async function uploadEnqueue(files: File[]): Promise<void> {
    if (!files.length) return;
    files.forEach((file) => queue.push({ file }));
    setStatus(`Upload queue: ${queue.length}`, 'info', 1500);
    if (uploading) return;
    uploading = true;
    while (queue.length) {
      const { file } = queue.shift()!;
      await uploadOne(file);
    }
    uploading = false;
  }

  function createFileElement(file: UploadListItem): HTMLElement | null {
    if (!filesEl) return null;
    const isText = isTextName(file.name);
    const isAudio = isAudioName(file.name);
    const isVideo = isVideoName(file.name);
    const previewHref = isText
      ? `/preview/${encodeURIComponent(file.name)}`
      : `/uploads/${encodeURIComponent(file.name)}`;
    const previewLabel = isText ? 'Читать' :
      isAudio ? 'Слушать' :
      isVideo ? 'Смотреть' : 'Открыть';

    const el = document.createElement('div');
    el.className = 'file';
    el.innerHTML = `
      <div>
        <div class="name">${esc(file.name)}</div>
        <div class="meta">${formatBytes(file.size || 0)} • ${fmtTime(file.mtime)}</div>
      </div>
      <div class="actions">
        <a class="btn media" href="${previewHref}" target="_blank" rel="noopener">${previewLabel}</a>
        <a class="btn download" href="/uploads/${encodeURIComponent(file.name)}" download>Скачать</a>
        <button class="btn del" title="Удалить" aria-label="Удалить файл">🗑️</button>
      </div>
    `;

    const mediaBtn = el.querySelector<HTMLAnchorElement>('.btn.media');
    if (mediaBtn) mediaBtn.style.minWidth = '110px';
    el.querySelector<HTMLButtonElement>('.btn.del')?.addEventListener('click', async () => {
      try {
        await fetchJSON(`/api/files/${encodeURIComponent(file.name)}`, { method: 'DELETE' }, 'Failed to delete file');
        setStatus(`Deleted ${file.name}.`, 'success', 2000);
      } catch (error) {
        setStatus(getErrorMessage(error, 'Failed to delete file.'), 'error', 5000);
      } finally {
        loadFiles({ silent: true });
      }
    });

    return el;
  }

  function renderFiles(list: UploadListItem[]): void {
    if (!filesEl) return;
    filesEl.innerHTML = '';
    list.forEach((file) => {
      const el = createFileElement(file);
      if (el) filesEl.appendChild(el);
    });
  }

  async function deleteAll(): Promise<void> {
    try {
      const response = await fetchJSON<DeleteFilesResponse>('/api/files', { method: 'DELETE' }, 'Failed to delete files');
      setStatus(`Deleted ${response.deleted || 0} files.`, 'success', 2500);
      await loadFiles({ silent: true });
    } catch (error) {
      setStatus(getErrorMessage(error, 'Failed to delete files.'), 'error', 5000);
    }
  }

  function wireDropzone(): void {
    dropzone?.addEventListener('click', () => fileInput?.click());
    dropzone?.addEventListener('dragover', (event) => { event.preventDefault(); dropzone.classList.add('dragover'); });
    dropzone?.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
    dropzone?.addEventListener('drop', async (event) => {
      event.preventDefault();
      dropzone.classList.remove('dragover');
      const files = await dataTransferToFiles(event.dataTransfer);
      uploadEnqueue(files);
    });
  }

  async function entriesToFiles(entry: any): Promise<File[]> {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve) => entry.file(resolve));
      return [file];
    }
    if (entry.isDirectory) {
      const dirReader = entry.createReader();
      const collected: File[] = [];
      const readBatch = async (): Promise<void> => {
        const entries = await new Promise<any[]>((resolve) => dirReader.readEntries(resolve));
        if (!entries.length) return;
        for (const child of entries) collected.push(...await entriesToFiles(child));
        await readBatch();
      };
      await readBatch();
      return collected;
    }
    return [];
  }

  async function dataTransferToFiles(dataTransfer: DataTransfer | null | undefined): Promise<File[]> {
    const items = dataTransfer?.items;
    if (!items?.length) {
      return Array.from(dataTransfer?.files || []);
    }
    const files: File[] = [];
    for (const item of Array.from(items)) {
      const entry = (item as DataTransferItem & { webkitGetAsEntry?: () => any }).webkitGetAsEntry?.();
      if (entry) files.push(...await entriesToFiles(entry));
    }
    return files.length ? files : Array.from(dataTransfer?.files || []);
  }

  function wireInput(): void {
    fileInput?.addEventListener('change', async () => {
      const files = Array.from(fileInput.files || []);
      uploadEnqueue(files);
      fileInput.value = '';
    });
  }

  function wireDeleteAll(): void {
    deleteAllBtn?.addEventListener('click', () => {
      if (!confirm('Delete all uploaded files?')) return;
      deleteAll();
    });
  }

  wireDropzone();
  wireInput();
  wireDeleteAll();

  return { loadFiles };
}
