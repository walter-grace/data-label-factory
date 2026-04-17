import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Auth policy:
 *   When Clerk keys are configured → enforce public/gated route policy.
 *   When Clerk keys are missing → pass all requests through (testing mode).
 */

const hasClerk = !!(
  process.env.CLERK_SECRET_KEY &&
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
);

// Only import Clerk when keys are present
let clerkMiddleware: any;
let createRouteMatcher: any;

if (hasClerk) {
  try {
    const clerk = require("@clerk/nextjs/server");
    clerkMiddleware = clerk.clerkMiddleware;
    createRouteMatcher = clerk.createRouteMatcher;
  } catch {
    // Clerk not installed — pass through
  }
}

const PUBLIC_PATTERNS = [
  "/",
  "/go",
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
