"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function UsagePage() {
  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold tracking-tight">Usage</h2>
      <div className="grid gap-4 sm:grid-cols-3">
        <Card className="bg-zinc-900/30 border-zinc-800">
          <CardHeader className="pb-2"><CardTitle className="text-sm text-zinc-400">Images Labeled</CardTitle></CardHeader>
          <CardContent><div className="text-3xl font-bold">18 <span className="text-sm text-zinc-500 font-normal">/ 25</span></div></CardContent>
        </Card>
        <Card className="bg-zinc-900/30 border-zinc-800">
          <CardHeader className="pb-2"><CardTitle className="text-sm text-zinc-400">Models Trained</CardTitle></CardHeader>
          <CardContent><div className="text-3xl font-bold">0 <span className="text-sm text-zinc-500 font-normal">/ 0</span></div></CardContent>
        </Card>
        <Card className="bg-zinc-900/30 border-zinc-800">
          <CardHeader className="pb-2"><CardTitle className="text-sm text-zinc-400">API Calls</CardTitle></CardHeader>
          <CardContent><div className="text-3xl font-bold">42</div></CardContent>
        </Card>
      </div>
      <Card className="bg-zinc-900/30 border-zinc-800">
        <CardHeader><CardTitle className="text-base">Current Plan: Free</CardTitle></CardHeader>
        <CardContent>
          <p className="text-sm text-zinc-400">Upgrade to unlock more images, model training, and API access.</p>
          <a href="/pricing" className="mt-4 inline-flex items-center rounded-xl bg-blue-600 px-5 py-2 text-sm font-semibold text-white hover:bg-blue-500 transition">Upgrade Plan</a>
        </CardContent>
      </Card>
    </div>
  );
}
