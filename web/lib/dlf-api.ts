import { NextResponse } from "next/server";

/**
 * DLF Python backend URL (liteparse / chandra / storage proxies / moltbook).
 * Set DLF_API_URL env var to a reachable tunnel URL when self-hosting the
 * Python side. Empty or localhost means "not available on this deployment".
 */
export const DLF_API = process.env.DLF_API_URL || "";

/** True when no external DLF backend is configured (i.e., public Vercel). */
export function isSelfHostedOnly(): boolean {
  if (!DLF_API) return true;
  if (DLF_API.startsWith("http://localhost") || DLF_API.startsWith("http://127.0.0.1")) return true;
  return false;
}

/**
 * Standard 503 response for routes that depend on the Python backend when
 * it's not reachable. Gives the caller a clear path forward instead of
 * surfacing `fetch failed`.
 */
export function selfHostedOnlyResponse(feature: string): NextResponse {
  return NextResponse.json(
    {
      error: `${feature} is a self-hosted feature — requires the local DLF Python backend.`,
      self_hosted_only: true,
      install: "pip install data-label-factory && data_label_factory serve --port 8400",
      docs: "https://github.com/walter-grace/data-label-factory",
      alternative: "Use /agents + /community for cloud marketplace labeling (no install).",
    },
    { status: 503 },
  );
}
