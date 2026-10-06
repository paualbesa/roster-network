import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { readPublicSupabaseEnv } from "@/lib/supabase/config";
import { safeConsoleNextPath } from "@/lib/supabase/oauth";

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const next = safeConsoleNextPath(url.searchParams.get("next"));
  const config = readPublicSupabaseEnv(process.env);
  const redirect = NextResponse.redirect(new URL(next, url.origin));
  if (!config) return redirect;
  const code = url.searchParams.get("code");
  if (!code) return redirect;
  const supabase = createServerClient(config.url, config.anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const cookie of cookiesToSet) {
          redirect.cookies.set(cookie.name, cookie.value, cookie.options);
        }
      },
    },
  });
  await supabase.auth.exchangeCodeForSession(code);
  return redirect;
}
