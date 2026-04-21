import SiteNav from "@/components/SiteNav";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <SiteNav />
      <main>{children}</main>
    </div>
  );
}
