import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/storage/[provider]/auth
 *
 * Initiates OAuth flow for a cloud storage provider.
 * Redirects the user to the provider's authorization page.
 *
 * Required env vars:
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
 *   DROPBOX_CLIENT_ID, DROPBOX_CLIENT_SECRET
 *   BITBUCKET_CLIENT_ID, BITBUCKET_CLIENT_SECRET
 *   NEXT_PUBLIC_APP_URL  (e.g. http://localhost:3000)
 */

type Provider = "gdrive" | "dropbox" | "bitbucket";

const PROVIDER_CONFIG: Record<
  Provider,
  {
    authorizeUrl: string;
    clientIdEnv: string;
    scopes: string;
    extraParams?: Record<string, string>;
  }
> = {
  gdrive: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    clientIdEnv: "GOOGLE_CLIENT_ID",
    scopes: "https://www.googleapis.com/auth/drive.readonly",
    extraParams: { access_type: "offline", prompt: "consent" },
  },
  dropbox: {
    authorizeUrl: "https://www.dropbox.com/oauth2/authorize",
    clientIdEnv: "DROPBOX_CLIENT_ID",
    scopes: "",
    extraParams: { token_access_type: "offline" },
  },
  bitbucket: {
    authorizeUrl: "https://bitbucket.org/site/oauth2/authorize",
    clientIdEnv: "BITBUCKET_CLIENT_ID",
    scopes: "repository:read",
  },
};

function isValidProvider(p: string): p is Provider {
  return p in PROVIDER_CONFIG;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider } = await params;

  if (!isValidProvider(provider)) {
    return NextResponse.json(
      { error: `Unknown provider: ${provider}` },
      { status: 400 },
    );
  }

  const config = PROVIDER_CONFIG[provider];
  const clientId = process.env[config.clientIdEnv];

  if (!clientId) {
    return NextResponse.json(
      {
        error: `${config.clientIdEnv} not configured. Set it in .env.local.`,
      },
      { status: 500 },
    );
  }

  const appUrl =
    process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const redirectUri =
    req.nextUrl.searchParams.get("redirect_uri") ||
    `${appUrl}/api/storage/${provider}/callback`;

  const authParams = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    ...(config.scopes ? { scope: config.scopes } : {}),
    ...(config.extraParams ?? {}),
    // Pass provider in state so callback knows which provider
    state: JSON.stringify({ provider, redirect_uri: redirectUri }),
  });

  const url = `${config.authorizeUrl}?${authParams.toString()}`;
  return NextResponse.redirect(url);
}
