import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/storage/[provider]/callback
 *
 * OAuth callback handler. Exchanges the authorization code for tokens,
 * stores them server-side via the DLF backend, then redirects back to
 * the app with a success/error indicator.
 *
 * Required env vars:
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
 *   DROPBOX_CLIENT_ID, DROPBOX_CLIENT_SECRET
 *   BITBUCKET_CLIENT_ID, BITBUCKET_CLIENT_SECRET
 *   NEXT_PUBLIC_APP_URL
 */

type Provider = "gdrive" | "dropbox" | "bitbucket";

const DLF_API = process.env.DLF_API_URL || "http://localhost:8400";

const TOKEN_ENDPOINTS: Record<Provider, string> = {
  gdrive: "https://oauth2.googleapis.com/token",
  dropbox: "https://api.dropboxapi.com/oauth2/token",
  bitbucket: "https://bitbucket.org/site/oauth2/access_token",
};

const CLIENT_ENV: Record<Provider, { id: string; secret: string }> = {
  gdrive: { id: "GOOGLE_CLIENT_ID", secret: "GOOGLE_CLIENT_SECRET" },
  dropbox: { id: "DROPBOX_CLIENT_ID", secret: "DROPBOX_CLIENT_SECRET" },
  bitbucket: { id: "BITBUCKET_CLIENT_ID", secret: "BITBUCKET_CLIENT_SECRET" },
};

function isValidProvider(p: string): p is Provider {
  return p in TOKEN_ENDPOINTS;
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

  const code = req.nextUrl.searchParams.get("code");
  const error = req.nextUrl.searchParams.get("error");
  const stateRaw = req.nextUrl.searchParams.get("state");
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

  if (error) {
    return NextResponse.redirect(
      `${appUrl}/template/new?storage_error=${encodeURIComponent(error)}`,
    );
  }

  if (!code) {
    return NextResponse.redirect(
      `${appUrl}/template/new?storage_error=no_code`,
    );
  }

  // Parse state to get the redirect_uri used during auth
  let redirectUri = `${appUrl}/api/storage/${provider}/callback`;
  if (stateRaw) {
    try {
      const state = JSON.parse(stateRaw);
      if (state.redirect_uri) redirectUri = state.redirect_uri;
    } catch {
      // Use default redirect_uri
    }
  }

  const envKeys = CLIENT_ENV[provider];
  const clientId = process.env[envKeys.id] || "";
  const clientSecret = process.env[envKeys.secret] || "";

  if (!clientId || !clientSecret) {
    return NextResponse.redirect(
      `${appUrl}/template/new?storage_error=missing_credentials`,
    );
  }

  // Exchange code for tokens
  try {
    const tokenUrl = TOKEN_ENDPOINTS[provider];
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
    });

    // Bitbucket uses Basic auth for token exchange
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
    };
    let fetchBody: string = body.toString();

    if (provider === "bitbucket") {
      const creds = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
      headers["Authorization"] = `Basic ${creds}`;
      // Bitbucket doesn't want client_id/secret in body when using Basic auth
      const bbBody = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      });
      fetchBody = bbBody.toString();
    }

    const tokenResp = await fetch(tokenUrl, {
      method: "POST",
      headers,
      body: fetchBody,
    });

    if (!tokenResp.ok) {
      const errText = await tokenResp.text();
      console.error(`[storage] Token exchange failed for ${provider}:`, errText);
      return NextResponse.redirect(
        `${appUrl}/template/new?storage_error=token_exchange_failed`,
      );
    }

    const tokens = await tokenResp.json();

    // Store tokens server-side via DLF backend
    // For now, use a placeholder user_id. In production, extract from Clerk session.
    // TODO: Extract real user_id from Clerk session cookie
    const userId = req.nextUrl.searchParams.get("user_id") || "default_user";

    const storeResp = await fetch(`${DLF_API}/api/storage/${provider}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: userId,
        tokens: {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expires_in: tokens.expires_in,
          token_type: tokens.token_type,
        },
      }),
    });

    if (!storeResp.ok) {
      console.error("[storage] Failed to store tokens in DLF backend");
      return NextResponse.redirect(
        `${appUrl}/template/new?storage_error=token_store_failed`,
      );
    }

    // Success — redirect back with connected indicator
    return NextResponse.redirect(
      `${appUrl}/template/new?storage_connected=${provider}`,
    );
  } catch (e: any) {
    console.error(`[storage] Callback error for ${provider}:`, e);
    return NextResponse.redirect(
      `${appUrl}/template/new?storage_error=${encodeURIComponent(e.message)}`,
    );
  }
}
