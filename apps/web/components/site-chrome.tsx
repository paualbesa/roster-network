"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

/** Marketing chrome stays on the public site. `/admin` draws its own operator shell. */
export function SiteChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const operator = pathname === "/admin" || pathname.startsWith("/admin/");
  if (operator) return children;
  return (
    <>
      <SiteHeader />
      {children}
      <SiteFooter />
    </>
  );
}
