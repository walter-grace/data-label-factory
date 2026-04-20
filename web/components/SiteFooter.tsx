import Link from "next/link";

/**
 * Shared site footer. Mirrors SiteNav link list but styled as a footer row.
 */

export default function SiteFooter() {
  return (
    <footer className="border-t border-zinc-800/50 py-8">
      <div className="mx-auto max-w-5xl px-6 flex flex-col items-center justify-between gap-4 text-sm text-zinc-500 sm:flex-row">
        <div className="flex items-center gap-2">
          <div className="flex h-5 w-5 items-center justify-center rounded bg-blue-600 text-[8px] font-black text-white">
            DLF
          </div>
          <span>Data Label Factory</span>
        </div>
        <div className="flex flex-wrap justify-center gap-4 gap-y-2 sm:gap-6">
          <Link href="/arena" className="transition hover:text-zinc-300">Arena</Link>
          <Link href="/community" className="transition hover:text-zinc-300">Community</Link>
          <Link href="/agents" className="transition hover:text-zinc-300">Claim Key</Link>
          <Link href="/subscribe" className="transition hover:text-zinc-300">Subscribe</Link>
          <Link href="/pricing" className="transition hover:text-zinc-300">Pricing</Link>
          <Link href="/go" className="transition hover:text-zinc-300">Label UI</Link>
          <Link href="/how-it-works" className="transition hover:text-zinc-300">How it works</Link>
          <a
            href="https://github.com/walter-grace/data-label-factory"
            target="_blank"
            rel="noreferrer"
            className="transition hover:text-zinc-300"
          >
            GitHub
          </a>
        </div>
      </div>
    </footer>
  );
}
