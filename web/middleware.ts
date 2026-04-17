import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

/**
 * Auth policy:
 *   Public  — marketing, marketplace browsing, live demos, agent-API endpoints
 *   Gated   — anything that writes templates, stores state, or connects to
 *             paid features (template editor, batch extract, dashboard,
 *             agent registration, cloud storage connections)
 *
 * `auth.protect()` will redirect unauthed users to the sign-in flow.
 */
const isPublicRoute = createRouteMatcher([
  // Marketing + primary flow
  "/",
  "/go",
  "/chat",
  "/pricing",
  "/extract",

  // Auth
  "/sign-in(.*)",
  "/sign-up(.*)",

  // Marketplace (browsing is free, editing is gated)
  "/template/library",

  // Live demos that don't persist data
  "/parse",
  "/play",
  "/play/(.*)",
  "/arena",
  "/community",
  "/community/(.*)",

  // Legacy top-level sections — existing, stay public for now
  "/build(.*)",
  "/train(.*)",
  "/label(.*)",
  "/pipeline(.*)",

  // Agent / MCP / webhook APIs — agents authenticate with their own keys
  "/api/agent(.*)",
  "/api/dlf(.*)",
  "/api/parse(.*)",
  "/api/rewards(.*)",
  "/api/cluster(.*)",
  "/api/webhooks(.*)",
  "/api/moltbook(.*)",
]);

export default clerkMiddleware(async (auth, req) => {
  if (!isPublicRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    // Skip Next.js internals and static files
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes
    "/(api|trpc)(.*)",
  ],
};
