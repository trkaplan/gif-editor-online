export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

export function createId(): string {
  return crypto.randomUUID();
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function normalizeRect(x: number, y: number, w: number, h: number): { x: number; y: number; w: number; h: number } {
  const nx = w < 0 ? x + w : x;
  const ny = h < 0 ? y + h : y;
  return { x: nx, y: ny, w: Math.abs(w), h: Math.abs(h) };
}

export function sameFrameOrder(a: { id: string }[], b: { id: string }[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id) return false;
  }
  return true;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
