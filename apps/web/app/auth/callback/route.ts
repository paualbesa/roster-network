import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { readPublicSupabaseEnv } from "@/lib/supabase/config";

/** OAuth and email-confirm landing. Sends the browser back to the console. */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const next = safeConsolePath(url.searchParams.get("next"));
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

function safeConsolePath(value: string | null): string {
  if (!value || !value.startsWith("/console") || value.startsWith("//") || value.includes("\\")) {
    return "/console";
  }
  return value;
}
