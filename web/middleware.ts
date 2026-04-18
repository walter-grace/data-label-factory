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

function createMiddleware() {
  if (clerkMiddleware && createRouteMatcher) {
    const isPublicRoute = createRouteMatcher(PUBLIC_PATTERNS);
    return clerkMiddleware(async (auth: any, req: NextRequest) => {
      if (!isPublicRoute(req)) {
        await auth.protect();
      }
    });
  }
  // No Clerk — pass everything through
  return (_req: NextRequest) => NextResponse.next();
}

export default createMiddleware();

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
