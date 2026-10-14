import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import type { NextFetchEvent, NextRequest } from "next/server";
import { isLocalMode } from "@/lib/mcp/local/mode";

// Public routes that don't require authentication
const isPublicRoute = createRouteMatcher([
  "/",
  "/(.well-known)(.*)",
  // The MCP route validates bearer tokens and returns OAuth discovery challenges.
  "/mcp",
  "/register",
  "/authorize",
  "/oauth-consent",
  "/token",
  // Public only at this narrow relay boundary. The route itself accepts an
  // unauthenticated single-use exchange and validates scoped managed-auth JWTs
  // for retrieve, submit, and events.
  "/managed-auth-proxy/auth/connections/(.*)",
]);

const clerk = clerkMiddleware(async (auth, req) => {
  if (isPublicRoute(req)) return;
  await auth.protect();
});

export default function proxy(req: NextRequest, event: NextFetchEvent) {
  // Local mode has no Clerk keys, and clerkMiddleware throws without a
  // publishable key under next start and in CI.
  if (isLocalMode()) return;
  return clerk(req, event);
}

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
