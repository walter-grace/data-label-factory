/**
 * Server-side fetch to the DLF gateway Worker.
 *
 * On Cloudflare: uses the GATEWAY service binding. Same-account
 * Worker-to-Worker via the public URL returns CF error 1042; the
 * binding side-steps that by dispatching directly to the sibling Worker.
 *
 * On Vercel / node / anywhere else: falls through to a normal public
 * fetch. path can be absolute ("https://…/v1/x") or relative ("/v1/x").
 */

const GATEWAY_PUBLIC_URL =
  process.env.DLF_GATEWAY_BASE_URL ||
  "https://dlf-gateway.agentlabel.workers.dev";

type GatewayLike = { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> };

async function tryGetBinding(): Promise<GatewayLike | null> {
  try {
    const mod = await import("@opennextjs/cloudflare");
    const getCtx = (mod as unknown as {
      getCloudflareContext?: () => { env?: { GATEWAY?: GatewayLike } };
    }).getCloudflareContext;
    if (!getCtx) return null;
    const ctx = getCtx();
    return ctx?.env?.GATEWAY ?? null;
  } catch {
    return null;
  }
}

export async function gatewayFetch(
  pathOrUrl: string,
  init?: RequestInit,
): Promise<Response> {
  const abs = pathOrUrl.startsWith("http")
    ? pathOrUrl
    : `${GATEWAY_PUBLIC_URL.replace(/\/$/, "")}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;

  const binding = await tryGetBinding();
  if (binding) return binding.fetch(abs, init);
  return fetch(abs, init);
}
