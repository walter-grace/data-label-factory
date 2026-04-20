import type { MetadataRoute } from "next";

// Next 15 dynamic sitemap. Regenerated on each edge request. Listed pages
// are the public ones that agents + crawlers should discover. Community
// slug pages are not listed explicitly — let the /community hub introduce
// them via normal page links.

const BASE = "https://data-label-factory.vercel.app";

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  const page = (
    path: string,
    priority: number,
    changeFrequency: MetadataRoute.Sitemap[number]["changeFrequency"] = "weekly",
  ): MetadataRoute.Sitemap[number] => ({
    url: `${BASE}${path}`,
    lastModified: now,
    changeFrequency,
    priority,
  });
  return [
    page("/",            1.0, "daily"),
    page("/agents",      0.9, "daily"),
    page("/arena",       0.9, "hourly"),
    page("/subscribe",   0.9, "weekly"),
    page("/pricing",     0.9, "weekly"),
    page("/pricing/scale", 0.5, "monthly"),
    page("/community",   0.8, "hourly"),
    page("/go",          0.7, "weekly"),
    page("/how-it-works",0.6, "weekly"),
    page("/play",        0.5, "weekly"),
    page("/connect",     0.5, "weekly"),
    page("/dashboard",   0.5, "weekly"),
  ];
}
