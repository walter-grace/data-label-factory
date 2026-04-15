import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { stripe } from "@/lib/stripe";
import { getPlan } from "@/lib/plans";

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { planId } = await req.json();
  const plan = getPlan(planId);

  if (!plan || plan.price === 0) {
    return NextResponse.json({ error: "Invalid plan" }, { status: 400 });
  }

  const origin = req.headers.get("origin") ?? "http://localhost:3000";

  const session = await stripe.checkout.sessions.create({
    mode: plan.recurring ? "subscription" : "payment",
    line_items: [
      {
        price_data: {
          currency: "usd",
          unit_amount: plan.price,
          product_data: {
            name: `Data Label Factory — ${plan.name}`,
            description: plan.description,
          },
          ...(plan.recurring
            ? { recurring: { interval: plan.recurring } }
            : {}),
        },
        quantity: 1,
      },
    ],
    metadata: {
      userId,
      planId: plan.id,
    },
    success_url: `${origin}/dashboard?checkout=success`,
    cancel_url: `${origin}/pricing?checkout=cancelled`,
  });

  return NextResponse.json({ url: session.url });
}
