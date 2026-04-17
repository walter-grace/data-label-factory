"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  StorageProvider,
  StorageFile,
  StorageItem,
} from "@/lib/storage-providers";
import {
  getAuthUrl,
  listFiles,
  downloadFile,
  listConnected,
  providerLabel,
  isFolder,
} from "@/lib/storage-providers";

/**
 * CloudFilePicker — modal panel for browsing + selecting files from
 * Google Drive, Dropbox, or Bitbucket.
 *
 * Props:
 *   userId       — Clerk user ID (or placeholder)
 *   onSelect     — called with selected StorageFile[] when user confirms
 *   onClose      — dismiss the picker
 *   open         — controlled visibility
 *
 * Usage:
 *   <CloudFilePicker
 *     open={showPicker}
 *     userId={user.id}
 *     onSelect={(files) => uploadFiles(files)}
 *     onClose={() => setShowPicker(false)}
 *   />
 */

type Props = {
  open: boolean;
  userId: string;
  onSelect: (files: StorageFile[]) => void;
  onClose: () => void;
};

type BreadcrumbEntry = { id: string; name: string };

// SVG icons (inline to avoid dependency)
const ICONS: Record<StorageProvider, React.ReactNode> = {
  gdrive: (
    <svg viewBox="0 0 24 24" className="w-5 h-5" fill="currentColor">
      <path d="M7.71 3.5L1.15 15l3.43 5.97L11.14 9.5 7.71 3.5zm1.14 0l6.86 12H22.86l-3.43-6-6.86-12H8.85zM2.29 16l3.43 6h13.72l3.42-6H2.29z" />
    </svg>
  ),
  dropbox: (
    <svg viewBox="0 0 24 24" className="w-5 h-5" fill="currentColor">
      <path d="M6 2l6 3.75L6 9.5 0 5.75 6 2zm12 0l6 3.75-6 3.75-6-3.75L18 2zM0 13.25L6 9.5l6 3.75L6 17 0 13.25zm18-3.75l6 3.75L18 17l-6-3.75L18 9.5zM6 18.25l6-3.75 6 3.75-6 3.75-6-3.75z" />
    </svg>
  ),
  bitbucket: (
    <svg viewBox="0 0 24 24" className="w-5 h-5" fill="currentColor">
      <path d="M.778 1.213a.768.768 0 00-.768.892l3.263 19.81c.084.5.515.868 1.022.873H19.95a.772.772 0 00.77-.646L24.012 2.104a.768.768 0 00-.768-.892H.778zm13.58 14.46H9.74L8.565 8.326h7.173l-1.38 7.347z" />
    </svg>
  ),
};

const PROVIDERS: StorageProvider[] = ["gdrive", "dropbox", "bitbucket"];

export default function CloudFilePicker({
  open,
  userId,
  onSelect,
  onClose,
}: Props) {
  // Connection status
  const [connected, setConnected] = useState<Record<StorageProvider, boolean>>({
    gdrive: false,
    dropbox: false,
    bitbucket: false,
  });

  // Active browsing state
  const [activeProvider, setActiveProvider] = useState<StorageProvider | null>(
    null,
  );
  const [items, setItems] = useState<StorageItem[]>([]);
  const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Selection state
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [downloading, setDownloading] = useState(false);

  // Check connection status on mount
  useEffect(() => {
    if (!open || !userId) return;
    listConnected(userId).then((statuses) => {
      const map: Record<string, boolean> = {};
      for (const s of statuses) map[s.provider] = s.connected;
      setConnected({
        gdrive: !!map.gdrive,
        dropbox: !!map.dropbox,
        bitbucket: !!map.bitbucket,
      });
    });
  }, [open, userId]);

  // Browse a folder
  const browse = useCallback(
    async (provider: StorageProvider, folderId?: string, folderName?: string) => {
      setLoading(true);
      setError(null);
      try {
        const result = await listFiles(provider, userId, folderId);
        setItems(result);
        setActiveProvider(provider);
        if (folderId && folderName) {
          setBreadcrumbs((prev) => [...prev, { id: folderId, name: folderName }]);
        } else {
          setBreadcrumbs([]);
        }
      } catch (e: any) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    },
    [userId],
  );

  // Handle provider button click
  const handleProviderClick = (provider: StorageProvider) => {
    if (connected[provider]) {
      // Browse root
      setSelected(new Set());
      browse(provider);
    } else {
      // Open OAuth popup
      const url = getAuthUrl(provider);
      const popup = window.open(url, `dlf_storage_${provider}`, "width=600,height=700");

      // Poll for popup close (callback will redirect back)
      const timer = setInterval(() => {
        if (popup?.closed) {
          clearInterval(timer);
          // Re-check connection status
          listConnected(userId).then((statuses) => {
            const map: Record<string, boolean> = {};
            for (const s of statuses) map[s.provider] = s.connected;
            const newConn = {
              gdrive: !!map.gdrive,
              dropbox: !!map.dropbox,
              bitbucket: !!map.bitbucket,
            };
            setConnected(newConn);
            if (newConn[provider]) {
              browse(provider);
            }
          });
        }
      }, 500);
    }
  };

  // Navigate breadcrumbs
  const navigateTo = (index: number) => {
    if (!activeProvider) return;
    if (index < 0) {
      // Root
      setBreadcrumbs([]);
      browse(activeProvider);
    } else {
      const target = breadcrumbs[index];
      setBreadcrumbs(breadcrumbs.slice(0, index));
      browse(activeProvider, target.id, target.name);
    }
  };

  // Toggle file selection
  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Upload selected files
  const handleUpload = async () => {
    if (!activeProvider) return;
    setDownloading(true);
    setError(null);

    const selectedFiles: StorageFile[] = items.filter(
      (item): item is StorageFile =>
        !isFolder(item) && selected.has(item.id),
    );

    onSelect(selectedFiles);
    setDownloading(false);
    onClose();
  };

  if (!open) return null;

  const selectedCount = selected.size;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-2xl mx-4 bg-zinc-950 border border-zinc-800 rounded-2xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800">
          <h2 className="text-lg font-semibold text-zinc-100">
            Cloud Storage
          </h2>
          <button
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Provider buttons */}
        <div className="px-6 py-4 flex gap-3 border-b border-zinc-800">
          {PROVIDERS.map((p) => (
            <button
              key={p}
              onClick={() => handleProviderClick(p)}
              className={`
                flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium
                transition-all border
                ${
                  activeProvider === p
                    ? "bg-blue-600/20 border-blue-500/40 text-blue-400"
                    : "bg-zinc-900 border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:text-zinc-300"
                }
              `}
            >
              {ICONS[p]}
              <span>{providerLabel(p)}</span>
              {connected[p] && (
                <span className="flex items-center gap-1 text-xs text-emerald-400">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                  Connected
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Breadcrumbs */}
        {activeProvider && (
          <div className="px-6 py-2 flex items-center gap-1 text-sm text-zinc-500 border-b border-zinc-800/50">
            <button
              onClick={() => navigateTo(-1)}
              className="hover:text-zinc-300 transition-colors"
            >
              {providerLabel(activeProvider)}
            </button>
            {breadcrumbs.map((bc, i) => (
              <span key={bc.id} className="flex items-center gap-1">
                <span className="text-zinc-700">/</span>
                <button
                  onClick={() => navigateTo(i)}
                  className="hover:text-zinc-300 transition-colors"
                >
                  {bc.name}
                </button>
              </span>
            ))}
          </div>
        )}

        {/* File list */}
        <div className="px-6 py-4 max-h-80 overflow-y-auto min-h-[200px]">
          {error && (
            <div className="text-red-400 text-sm bg-red-400/10 rounded-xl px-4 py-3 mb-3">
              {error}
            </div>
          )}

          {loading && (
            <div className="flex items-center justify-center py-12 text-zinc-500">
              <svg className="w-5 h-5 animate-spin mr-2" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" className="opacity-25" />
                <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="opacity-75" />
              </svg>
              Loading...
            </div>
          )}

          {!loading && !activeProvider && (
            <div className="text-center py-12 text-zinc-600 text-sm">
              Select a provider above to browse files.
            </div>
          )}

          {!loading && activeProvider && items.length === 0 && !error && (
            <div className="text-center py-12 text-zinc-600 text-sm">
              No documents found in this folder.
            </div>
          )}

          {!loading &&
            items.map((item) => {
              const folder = isFolder(item);
              const isSelected = selected.has(item.id);

              return (
                <div
                  key={item.id}
                  onClick={() => {
                    if (folder && activeProvider) {
                      browse(activeProvider, item.id, item.name);
                    } else {
                      toggleSelect(item.id);
                    }
                  }}
                  className={`
                    flex items-center gap-3 px-3 py-2.5 rounded-xl cursor-pointer
                    transition-all mb-1
                    ${
                      isSelected
                        ? "bg-blue-600/15 border border-blue-500/30"
                        : "hover:bg-zinc-900 border border-transparent"
                    }
                  `}
                >
                  {/* Checkbox (files only) */}
                  {!folder && (
                    <div
                      className={`
                        w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center
                        ${
                          isSelected
                            ? "bg-blue-600 border-blue-500"
                            : "border-zinc-700"
                        }
                      `}
                    >
                      {isSelected && (
                        <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </div>
                  )}

                  {/* Icon */}
                  {folder ? (
                    <svg className="w-5 h-5 text-yellow-500 flex-shrink-0" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" />
                    </svg>
                  ) : (
                    <svg className="w-5 h-5 text-zinc-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                    </svg>
                  )}

                  {/* Name + meta */}
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-zinc-200 truncate">
                      {item.name}
                    </div>
                    {!folder && "size" in item && (
                      <div className="text-xs text-zinc-600">
                        {formatBytes((item as StorageFile).size)}
                        {(item as StorageFile).modifiedAt && (
                          <span className="ml-2">
                            {new Date((item as StorageFile).modifiedAt).toLocaleDateString()}
                          </span>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Folder arrow */}
                  {folder && (
                    <svg className="w-4 h-4 text-zinc-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  )}
                </div>
              );
            })}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-zinc-800 bg-zinc-950/80">
          <span className="text-sm text-zinc-500">
            {selectedCount > 0
              ? `${selectedCount} file${selectedCount > 1 ? "s" : ""} selected`
              : "Select files to upload"}
          </span>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleUpload}
              disabled={selectedCount === 0 || downloading}
              className={`
                px-5 py-2 rounded-xl text-sm font-medium transition-all
                ${
                  selectedCount > 0 && !downloading
                    ? "bg-blue-600 text-white hover:bg-blue-500"
                    : "bg-zinc-800 text-zinc-600 cursor-not-allowed"
                }
              `}
            >
              {downloading ? "Downloading..." : "Upload selected"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}
