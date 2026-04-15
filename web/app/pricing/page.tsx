"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { PLANS, formatPrice } from "@/lib/plans";

export default function PricingPage() {
  const { isSignedIn } = useAuth();
  const router = useRouter();
  const [loading, setLoading] = useState<string | null>(null);

  const handleCheckout = async (planId: string) => {
    if (!isSignedIn) {
      router.push("/sign-in");
      return;
    }

    setLoading(planId);
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId }),
      });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      }
    } catch (err) {
      console.error("Checkout error:", err);
    } finally {
      setLoading(null);
    }
  };

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* Nav */}
      <nav className="fixed top-0 z-50 w-full border-b border-white/5 bg-zinc-950/80 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
          <Link href="/" className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-600 text-xs font-black">
              DLF
            </div>
            <span className="text-sm font-semibold tracking-tight">Data Label Factory</span>
          </Link>
          <div className="hidden items-center gap-8 text-sm text-zinc-400 sm:flex">
            <Link href="/build" className="transition hover:text-white">Build</Link>
            <Link href="/train" className="transition hover:text-white">Train</Link>
            <Link href="/pricing" className="text-white">Pricing</Link>
          </div>
          {isSignedIn ? (
            <Link
              href="/dashboard"
              className="rounded-lg bg-white px-4 py-1.5 text-sm font-medium text-zinc-900 transition hover:bg-zinc-200"
            >
              Dashboard
            </Link>
          ) : (
            <Link
              href="/sign-in"
              className="rounded-lg bg-white px-4 py-1.5 text-sm font-medium text-zinc-900 transition hover:bg-zinc-200"
            >
              Sign In
            </Link>
          )}
        </div>
      </nav>

      <div className="mx-auto max-w-5xl px-6 pt-32 pb-20">
        <div className="text-center">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            Simple, transparent pricing
          </h1>
          <p className="mx-auto mt-4 max-w-lg text-lg text-zinc-400">
            Start free. Upgrade when you need more images, models, or GPU training.
          </p>
        </div>

        <div className="mt-16 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {PLANS.map((plan) => {
            const isPopular = plan.id === "pro";
            return (
              <div
                key={plan.id}
                className={`relative flex flex-col rounded-2xl border p-6 transition ${
                  isPopular
                    ? "border-blue-500/50 bg-blue-600/5 shadow-lg shadow-blue-600/10"
                    : "border-zinc-800 bg-zinc-900/30"
                }`}
              >
                {isPopular && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-blue-600 px-3 py-0.5 text-xs font-semibold text-white">
                    Most Popular
                  </div>
                )}
                <div>
                  <h3 className="text-lg font-semibold">{plan.name}</h3>
                  <p className="mt-1 text-sm text-zinc-500">{plan.description}</p>
                </div>
                <div className="mt-5">
                  <span className="text-4xl font-bold tracking-tight">
                    {plan.price === 0 ? "Free" : formatPrice(plan.price)}
                  </span>
                  {plan.recurring && (
                    <span className="ml-1 text-sm text-zinc-500">/ {plan.recurring}</span>
                  )}
                  {!plan.recurring && plan.price > 0 && (
                    <span className="ml-1 text-sm text-zinc-500">one-time</span>
                  )}
                </div>
                <ul className="mt-6 flex-1 space-y-3">
                  {plan.features.map((f) => (
                    <li key={f} className="flex items-start gap-2 text-sm text-zinc-300">
                      <svg
                        className="mt-0.5 h-4 w-4 shrink-0 text-blue-400"
                        fill="none"
                        viewBox="0 0 24 24"
                        strokeWidth={2}
                        stroke="currentColor"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                      </svg>
                      {f}
                    </li>
                  ))}
                </ul>
                <div className="mt-8">
                  {plan.price === 0 ? (
                    <Link
                      href={isSignedIn ? "/dashboard" : "/sign-up"}
                      className="block w-full rounded-xl border border-zinc-700 py-2.5 text-center text-sm font-semibold text-zinc-300 transition hover:bg-zinc-800"
                    >
                      {isSignedIn ? "Current Plan" : "Get Started"}
                    </Link>
                  ) : (
                    <button
                      onClick={() => handleCheckout(plan.id)}
                      disabled={loading === plan.id}
                      className={`block w-full rounded-xl py-2.5 text-center text-sm font-semibold transition disabled:opacity-50 ${
                        isPopular
                          ? "bg-blue-600 text-white shadow-lg shadow-blue-600/20 hover:bg-blue-500"
                          : "bg-white text-zinc-900 hover:bg-zinc-200"
                      }`}
                    >
                      {loading === plan.id ? "Redirecting..." : `Get ${plan.name}`}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-16 text-center">
          <p className="text-sm text-zinc-500">
            All plans include COCO + YOLO export. Need a custom plan?{" "}
            <a href="mailto:hello@datalabelfactory.com" className="text-blue-400 hover:text-blue-300">
              Contact us
            </a>
          </p>
        </div>
      </div>
    </main>
  );
}
