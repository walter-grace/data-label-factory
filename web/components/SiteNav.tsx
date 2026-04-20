"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Shared site navigation. Used across all public pages so updates propagate
 * in one place. Surfaces the LIVE product (Arena + Community + Claim Key)
 * instead of legacy marketing pipeline pages.
 *
 * Visual variants:
 *   - "default" — opaque nav for content pages
 *   - "transparent" — used on landing where the hero bleeds behind the nav
 */

type Variant = "default" | "transparent";

export default function SiteNav({ variant = "default" }: { variant?: Variant } = {}) {
  const pathname = usePathname();
  const isActive = (p: string) =>
    p === "/" ? pathname === "/" : pathname === p || pathname.startsWith(`${p}/`);

  const wrapCls =
    variant === "transparent"
      ? "fixed top-0 z-50 w-full border-b border-white/5 bg-zinc-950/60 backdrop-blur-xl"
      : "sticky top-0 z-50 w-full border-b border-zinc-800 bg-zinc-950/90 backdrop-blur-xl";

  return (
    <nav className={wrapCls}>
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
        <Link href="/" className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-600 text-xs font-black">
            DLF
          </div>
          <span className="text-sm font-semibold tracking-tight">Data Label Factory</span>
        </Link>

        {/* Desktop nav */}
        <div className="hidden items-center gap-7 text-sm text-zinc-400 sm:flex">
          <Link
            href="/arena"
            className={`group flex items-center gap-1.5 transition hover:text-white ${
              isActive("/arena") ? "text-white font-medium" : ""
            }`}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-rose-500 animate-pulse" />
            <span className={isActive("/arena") ? "text-white" : "text-zinc-200"}>Arena</span>
          </Link>
          <Link
            href="/community"
            className={`transition hover:text-white ${isActive("/community") ? "text-white font-medium" : ""}`}
          >
            Community
          </Link>
          <Link
            href="/go"
            className={`transition hover:text-white ${isActive("/go") ? "text-white font-medium" : ""}`}
          >
            Label
          </Link>
          <Link
            href="/subscribe"
            className={`transition hover:text-white ${isActive("/subscribe") ? "text-white font-medium" : ""}`}
          >
            Subscribe
          </Link>
          <Link
            href="/pricing"
            className={`transition hover:text-white ${isActive("/pricing") ? "text-white font-medium" : ""}`}
          >
            Pricing
          </Link>
          <a
            href="https://github.com/walter-grace/data-label-factory"
            target="_blank"
            rel="noreferrer"
            className="transition hover:text-white"
          >
            GitHub
          </a>
        </div>

        {/* Mobile nav */}
        <div className="flex items-center gap-4 text-sm text-zinc-400 sm:hidden">
          <Link href="/arena" className="flex items-center gap-1 text-zinc-200 transition hover:text-white">
            <span className="h-1.5 w-1.5 rounded-full bg-rose-500 animate-pulse" />
            Arena
          </Link>
          <Link href="/community" className="transition hover:text-white">
            Jobs
          </Link>
          <Link href="/pricing" className="transition hover:text-white">
            Pricing
          </Link>
        </div>

        <Link
          href="/agents"
          className="rounded-lg bg-white px-4 py-1.5 text-sm font-medium text-zinc-900 transition hover:bg-zinc-200"
        >
          Claim Key
        </Link>
      </div>
    </nav>
  );
}
