import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

const PUBLIC_PATHS: { path: string; priority: number; changeFrequency: "weekly" | "monthly" }[] = [
  { path: "/", priority: 1, changeFrequency: "weekly" },
  { path: "/docs", priority: 0.8, changeFrequency: "weekly" },
  { path: "/console", priority: 0.7, changeFrequency: "monthly" },
  { path: "/console/guide", priority: 0.6, changeFrequency: "monthly" },
];

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  return PUBLIC_PATHS.map((entry) => ({
    url: `${SITE_URL}${entry.path === "/" ? "" : entry.path}`,
    lastModified,
    changeFrequency: entry.changeFrequency,
    priority: entry.priority,
  }));
}
