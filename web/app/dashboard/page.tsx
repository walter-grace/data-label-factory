"use client";

import Link from "next/link";
import { useUser } from "@clerk/nextjs";

// Placeholder data — in production, fetch from your database
const MOCK_PROJECTS = [
  {
    id: "proj_1",
    name: "Fire Hydrants",
    images: 18,
    status: "labeled",
    createdAt: "2026-04-12",
  },
  {
    id: "proj_2",
    name: "Stop Signs",
    images: 42,
    status: "training",
    createdAt: "2026-04-10",
  },
];

const USAGE = {
  plan: "free",
  imagesUsed: 18,
  imagesLimit: 25,
  modelsUsed: 0,
  modelsLimit: 0,
};

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    labeled: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
    training: "bg-blue-500/10 text-blue-400 border-blue-500/20",
    gathering: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
    complete: "bg-zinc-500/10 text-zinc-400 border-zinc-500/20",
  };

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${
        styles[status] ?? styles.complete
      }`}
    >
      {status === "training" && (
        <span className="h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse" />
      )}
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

export default function DashboardPage() {
  const { user } = useUser();

  const usagePercent =
    USAGE.imagesLimit > 0
      ? Math.min(100, Math.round((USAGE.imagesUsed / USAGE.imagesLimit) * 100))
      : 0;

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">
          Welcome back{user?.firstName ? `, ${user.firstName}` : ""}
        </h1>
        <p className="mt-1 text-sm text-zinc-500">
          Manage your projects and track usage.
        </p>
      </div>

      {/* Usage meter */}
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/30 p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-zinc-300">Image Usage</h2>
            <p className="mt-0.5 text-xs text-zinc-500">
              {USAGE.imagesUsed} / {USAGE.imagesLimit} images used this period
            </p>
          </div>
          <Link
            href="/pricing"
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:bg-zinc-800"
          >
            Upgrade Plan
          </Link>
        </div>
        <div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-zinc-800">
          <div
            className={`h-full rounded-full transition-all duration-500 ${
              usagePercent >= 90 ? "bg-red-500" : "bg-blue-600"
            }`}
            style={{ width: `${usagePercent}%` }}
          />
        </div>
        <div className="mt-2 flex justify-between text-xs text-zinc-500">
          <span>{usagePercent}% used</span>
          <span className="capitalize">{USAGE.plan} plan</span>
        </div>
      </div>

      {/* Projects */}
      <div>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Projects</h2>
          <Link
            href="/build"
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-500"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            New Project
          </Link>
        </div>

        {MOCK_PROJECTS.length > 0 ? (
          <div className="mt-4 space-y-3">
            {MOCK_PROJECTS.map((project) => (
              <div
                key={project.id}
                className="group flex items-center justify-between rounded-2xl border border-zinc-800 bg-zinc-900/30 p-5 transition hover:border-zinc-700 hover:bg-zinc-900/60"
              >
                <div className="flex items-center gap-4">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-600/10 text-blue-400">
                    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.41a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5a2.25 2.25 0 002.25-2.25V6.75a2.25 2.25 0 00-2.25-2.25H3.75A2.25 2.25 0 001.5 6.75v12a2.25 2.25 0 002.25 2.25z" />
                    </svg>
                  </div>
                  <div>
                    <h3 className="font-medium">{project.name}</h3>
                    <p className="text-xs text-zinc-500">
                      {project.images} images &middot; Created {project.createdAt}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <StatusBadge status={project.status} />
                  <svg
                    className="h-4 w-4 text-zinc-600 transition group-hover:text-zinc-400"
                    fill="none"
                    viewBox="0 0 24 24"
                    strokeWidth={1.5}
                    stroke="currentColor"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                  </svg>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="mt-4 rounded-2xl border border-dashed border-zinc-800 p-12 text-center">
            <p className="text-sm text-zinc-500">No projects yet.</p>
            <Link
              href="/build"
              className="mt-4 inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white transition hover:bg-blue-500"
            >
              Create your first project
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
