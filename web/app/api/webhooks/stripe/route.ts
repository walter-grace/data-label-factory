import { NextResponse } from "next/server";
import { stripe } from "@/lib/stripe";
import type Stripe from "stripe";

export async function POST(req: Request) {
  const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
  if (!WEBHOOK_SECRET) {
    return NextResponse.json(
      { error: "STRIPE_WEBHOOK_SECRET not configured" },
      { status: 500 }
    );
  }

  const body = await req.text();
  const sig = req.headers.get("stripe-signature");

  if (!sig) {
    return NextResponse.json({ error: "Missing stripe-signature" }, { status: 400 });
  }

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(body, sig, WEBHOOK_SECRET);
  } catch (err: any) {
    console.error("[stripe webhook] signature verification failed:", err.message);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const userId = session.metadata?.userId;
      const planId = session.metadata?.planId;
      console.log("[stripe webhook] checkout.session.completed", {
        userId,
        planId,
        customerId: session.customer,
        subscriptionId: session.subscription,
      });
      // TODO: Update user's plan in database
      // TODO: Store stripe customer ID and subscription ID
      break;
    }

    case "customer.subscription.updated": {
      const sub = event.data.object as Stripe.Subscription;
      console.log("[stripe webhook] subscription.updated", {
        subId: sub.id,
        status: sub.status,
      });
      // TODO: Sync subscription status to database
      break;
    }

    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      console.log("[stripe webhook] subscription.deleted", {
        subId: sub.id,
      });
      // TODO: Downgrade user to free plan
      break;
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      console.log("[stripe webhook] invoice.payment_failed", {
        customerId: invoice.customer,
      });
      // TODO: Notify user of failed payment
      break;
    }

    default:
      console.log("[stripe webhook] unhandled event:", event.type);
  }

  return NextResponse.json({ received: true });
}
