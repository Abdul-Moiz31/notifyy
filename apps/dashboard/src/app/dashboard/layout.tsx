"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { useSession } from "@/lib/use-session";
import { supabase } from "@/lib/supabase-client";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = useSession();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (session === null) {
      router.replace("/login");
    }
  }, [session, router]);

  if (session === undefined) {
    return (
      <div className="page center">
        <p className="muted">Loading…</p>
      </div>
    );
  }

  if (session === null) {
    return null;
  }

  return (
    <>
      <nav className="nav">
        <span className="nav-brand">Notify Engine</span>
        <div className="nav-links">
          <Link href="/dashboard" className={pathname === "/dashboard" ? "active" : ""}>
            Overview
          </Link>
          <Link
            href="/dashboard/events"
            className={pathname.startsWith("/dashboard/events") ? "active" : ""}
          >
            Events
          </Link>
          <button
            className="btn"
            onClick={async () => {
              await supabase.auth.signOut();
              router.replace("/login");
            }}
          >
            Log out
          </button>
        </div>
      </nav>
      <div className="page page-wide">{children}</div>
    </>
  );
}
