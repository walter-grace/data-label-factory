import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Auth policy:
 *   When Clerk keys are configured → enforce public/gated route policy.
 *   When Clerk keys are missing → pass all requests through (testing mode).
 */

// Clerk 7.x on Next 16 edge runtime imports node-only submodules that fail
// the Vercel build. Middleware temporarily disabled — auth is enforced at the
// page/component level via Clerk hooks where required.
const hasClerk = false;

let clerkMiddleware: any;
let createRouteMatcher: any;

const PUBLIC_PATTERNS = [
  "/",
  "/go",
  "/agents",
  "/chat",
  "/pricing",
  "/extract",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/template/library",
  "/parse",
  "/play",
  "/play/(.*)",
  "/arena",
  "/community",
  "/community/(.*)",
  "/build(.*)",
  "/train(.*)",
  "/label(.*)",
  "/pipeline(.*)",
  "/api/agent(.*)",
  "/api/dlf(.*)",
  "/api/parse(.*)",
  "/api/rewards(.*)",
  "/api/cluster(.*)",
  "/api/webhooks(.*)",
  "/api/moltbook(.*)",
  "/api/chat(.*)",
  "/api/storage(.*)",
  "/api/communities(.*)",
  "/api/community(.*)",
  "/api/health(.*)",
  "/api/providers(.*)",
  "/api/templates(.*)",
  "/api/gather(.*)",
  "/api/label-path(.*)",
  "/api/train-yolo(.*)",
  "/backend(.*)",
];

// Advertise machine-readable surfaces on every HTML response so Cloudflare's
// Agent Readiness scanner (and MCP clients that probe for `rel="mcp-server"`)
// can discover our llms.txt, sitemap, and the gateway's MCP manifest without
// a prior fetch.
const AGENT_LINK_HEADER = [
  '</llms.txt>; rel="alternate"; type="text/markdown"',
  '</sitemap.xml>; rel="sitemap"',
  '</robots.txt>; rel="alternate"; type="text/plain"',
  '<https://dlf-gateway.nico-zahniser.workers.dev/.well-known/mcp.json>; rel="mcp-server"',
  '<https://dlf-gateway.nico-zahniser.workers.dev/v1/pricing>; rel="service-desc"; type="application/json"',
  '<https://dlf-gateway.nico-zahniser.workers.dev/llms.txt>; rel="api-docs"; type="text/markdown"',
].join(", ");

function decorateAgentHeaders(res: NextResponse): NextResponse {
  res.headers.set("Link", AGENT_LINK_HEADER);
  return res;
}

// Markdown content negotiation (isitagentready.com `markdownNegotiation`
// check). When an agent sends `Accept: text/markdown`, rewrite the request
// to our /md route handler which returns a page-specific markdown body
// with the correct Content-Type + x-markdown-tokens header. HTML stays
// default for browsers.
function wantsMarkdown(req: NextRequest): boolean {
  const accept = req.headers.get("accept") || "";
  // Match `text/markdown` as a primary or weighted option.
  return /(^|[,;\s])text\/markdown([,;\s]|$|;q=)/i.test(accept);
}

function shouldNegotiateMarkdown(req: NextRequest): boolean {
  if (!wantsMarkdown(req)) return false;
  const p = req.nextUrl.pathname;
  // Skip asset + api + _next paths — only negotiate on human-facing pages.
  if (p.startsWith("/md/")) return false;
  if (p.startsWith("/_next/") || p.startsWith("/api/")) return false;
  if (/\.(png|jpg|jpeg|svg|gif|webp|ico|css|js|json|xml|txt|md|woff2?)$/i.test(p)) return false;
  return true;
}

function createMiddleware() {
  if (clerkMiddleware && createRouteMatcher) {
    const isPublicRoute = createRouteMatcher(PUBLIC_PATTERNS);
    return clerkMiddleware(async (auth: any, req: NextRequest) => {
      if (!isPublicRoute(req)) {
        await auth.protect();
      }
    });
  }
  return (req: NextRequest) => {
    // Content negotiation first: if the agent asked for markdown, rewrite
    // to /md/<path> before the normal HTML flow runs.
    if (shouldNegotiateMarkdown(req)) {
      const url = req.nextUrl.clone();
      url.pathname = `/md${url.pathname === "/" ? "" : url.pathname}`;
      return decorateAgentHeaders(NextResponse.rewrite(url));
    }
    // Normal flow — pass through with Agent Readiness headers attached.
    return decorateAgentHeaders(NextResponse.next());
  };
}

export default createMiddleware();

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
