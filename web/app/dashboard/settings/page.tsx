"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold tracking-tight">Settings</h2>
      <Card className="bg-zinc-900/30 border-zinc-800">
        <CardHeader><CardTitle className="text-base">API Keys</CardTitle></CardHeader>
        <CardContent>
          <p className="text-sm text-zinc-400 mb-4">Generate API keys for programmatic access to the labeling pipeline.</p>
          <button className="rounded-xl bg-blue-600 px-5 py-2 text-sm font-semibold text-white hover:bg-blue-500 transition">Generate API Key</button>
        </CardContent>
      </Card>
      <Card className="bg-zinc-900/30 border-zinc-800">
        <CardHeader><CardTitle className="text-base">Billing</CardTitle></CardHeader>
        <CardContent>
          <p className="text-sm text-zinc-400 mb-4">Manage your subscription, update payment methods, and view invoices.</p>
          <button className="rounded-xl border border-zinc-700 px-5 py-2 text-sm font-medium text-zinc-300 hover:bg-zinc-800 transition">Manage Billing</button>
        </CardContent>
      </Card>
      <Card className="bg-zinc-900/30 border-zinc-800">
        <CardHeader><CardTitle className="text-base">Notifications</CardTitle></CardHeader>
        <CardContent>
          <p className="text-sm text-zinc-400">Email notifications for completed training jobs and usage alerts.</p>
          <div className="mt-4 flex items-center gap-3">
            <input type="checkbox" id="notify-train" defaultChecked className="rounded border-zinc-600" />
            <label htmlFor="notify-train" className="text-sm text-zinc-300">Training complete</label>
          </div>
          <div className="mt-2 flex items-center gap-3">
            <input type="checkbox" id="notify-quota" defaultChecked className="rounded border-zinc-600" />
            <label htmlFor="notify-quota" className="text-sm text-zinc-300">Usage quota warnings</label>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
