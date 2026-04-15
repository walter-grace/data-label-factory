import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { Webhook } from "svix";

// Clerk sends webhooks via Svix. Verify signature, then sync user data.
// In production, persist to your database here.

interface ClerkWebhookEvent {
  type: string;
  data: Record<string, unknown>;
}

export async function POST(req: Request) {
  const WEBHOOK_SECRET = process.env.CLERK_WEBHOOK_SECRET;
  if (!WEBHOOK_SECRET) {
    return NextResponse.json(
      { error: "CLERK_WEBHOOK_SECRET not configured" },
      { status: 500 }
    );
  }

  const headerPayload = await headers();
  const svix_id = headerPayload.get("svix-id");
  const svix_timestamp = headerPayload.get("svix-timestamp");
  const svix_signature = headerPayload.get("svix-signature");

  if (!svix_id || !svix_timestamp || !svix_signature) {
    return NextResponse.json({ error: "Missing svix headers" }, { status: 400 });
  }

  const payload = await req.text();

  const wh = new Webhook(WEBHOOK_SECRET);
  let event: ClerkWebhookEvent;

  try {
    event = wh.verify(payload, {
      "svix-id": svix_id,
      "svix-timestamp": svix_timestamp,
      "svix-signature": svix_signature,
    }) as ClerkWebhookEvent;
  } catch {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  // Handle user lifecycle events
  switch (event.type) {
    case "user.created": {
      const { id, email_addresses, first_name, last_name } = event.data as any;
      console.log("[clerk webhook] user.created", {
        id,
        email: email_addresses?.[0]?.email_address,
        name: `${first_name ?? ""} ${last_name ?? ""}`.trim(),
      });
      // TODO: Create user row in your database with plan = "free"
      break;
    }
    case "user.updated": {
      const { id } = event.data as any;
      console.log("[clerk webhook] user.updated", { id });
      // TODO: Sync updated fields to your database
      break;
    }
    case "user.deleted": {
      const { id } = event.data as any;
      console.log("[clerk webhook] user.deleted", { id });
      // TODO: Soft-delete or archive user row
      break;
    }
    default:
      console.log("[clerk webhook] unhandled event:", event.type);
  }

  return NextResponse.json({ received: true });
}
