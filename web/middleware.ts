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

function createMiddleware() {
  if (clerkMiddleware && createRouteMatcher) {
    const isPublicRoute = createRouteMatcher(PUBLIC_PATTERNS);
    return clerkMiddleware(async (auth: any, req: NextRequest) => {
      if (!isPublicRoute(req)) {
        await auth.protect();
      }
    });
  }
  // No Clerk — pass everything through with Agent Readiness headers attached.
  return (_req: NextRequest) => decorateAgentHeaders(NextResponse.next());
}

export default createMiddleware();

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
