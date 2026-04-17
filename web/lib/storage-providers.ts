/**
 * storage-providers.ts — Cloud storage integration for DLF.
 *
 * Supports Google Drive, Dropbox, and Bitbucket as document sources.
 * OAuth tokens are stored server-side only — browser never sees raw tokens.
 *
 * Required env vars (set in .env.local):
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
 *   DROPBOX_CLIENT_ID, DROPBOX_CLIENT_SECRET
 *   BITBUCKET_CLIENT_ID, BITBUCKET_CLIENT_SECRET
 *   NEXT_PUBLIC_APP_URL  (e.g. http://localhost:3000)
 */

// ── Types ────────────────────────────────────────────────────

export type StorageProvider = "gdrive" | "dropbox" | "bitbucket";

export type StorageFile = {
  id: string;
  name: string;
  path: string;
  size: number;
  mimeType: string;
  modifiedAt: string;
};

export type StorageFolder = {
  id: string;
  name: string;
  path: string;
  children?: (StorageFile | StorageFolder)[];
};

export type StorageItem = StorageFile | StorageFolder;

export type ConnectionStatus = {
  provider: StorageProvider;
  connected: boolean;
};

// ── Helpers ──────────────────────────────────────────────────

const PROVIDER_LABELS: Record<StorageProvider, string> = {
  gdrive: "Google Drive",
  dropbox: "Dropbox",
  bitbucket: "Bitbucket",
};

export function providerLabel(p: StorageProvider): string {
  return PROVIDER_LABELS[p] ?? p;
}

function isFolder(item: StorageItem): item is StorageFolder {
  return !("mimeType" in item) || (item as any).mimeType === "folder";
}

export { isFolder };

// ── API client ───────────────────────────────────────────────

const DLF_API = process.env.NEXT_PUBLIC_DLF_API_URL || "http://localhost:8400";

/**
 * Returns the OAuth authorize URL for a provider.
 * Opens in a popup — user grants access, then we get a callback.
 */
export function getAuthUrl(
  provider: StorageProvider,
  redirectUri?: string,
): string {
  const base =
    typeof window !== "undefined" ? window.location.origin : "http://localhost:3000";
  const rd = redirectUri ?? `${base}/api/storage/${provider}/callback`;
  return `/api/storage/${provider}/auth?redirect_uri=${encodeURIComponent(rd)}`;
}

/**
 * List files in a folder (or root) for a connected provider.
 * Returns mixed array of files and folders.
 */
export async function listFiles(
  provider: StorageProvider,
  userId: string,
  folderId?: string,
): Promise<StorageItem[]> {
  const params = new URLSearchParams({ user_id: userId });
  if (folderId) params.set("folder_id", folderId);

  const r = await fetch(`/api/storage/${provider}/files?${params}`);
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: "request failed" }));
    throw new Error(err.error ?? `HTTP ${r.status}`);
  }
  const data = await r.json();
  return data.items ?? [];
}

/**
 * Download a file from cloud storage (proxied through our backend).
 * Returns a Blob ready for FormData upload to /api/parse or /api/template/new.
 */
export async function downloadFile(
  provider: StorageProvider,
  userId: string,
  fileId: string,
): Promise<Blob> {
  const r = await fetch(`/api/storage/${provider}/files`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId, file_id: fileId }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: "download failed" }));
    throw new Error(err.error ?? `HTTP ${r.status}`);
  }
  return r.blob();
}

/**
 * Check which providers are connected for a user.
 */
export async function listConnected(
  userId: string,
): Promise<ConnectionStatus[]> {
  const r = await fetch(`/api/storage/connected?user_id=${encodeURIComponent(userId)}`);
  if (!r.ok) return [];
  const data = await r.json();
  return data.connected ?? [];
}
