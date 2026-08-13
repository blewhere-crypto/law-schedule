// 네이버 캘린더 연동용 Supabase Edge Function
//
// 이 함수는 프런트엔드(index.html)에서 sb.functions.invoke("naver-calendar", {...})로 호출됩니다.
// NAVER_CLIENT_SECRET을 여기서만 다루기 때문에, 브라우저에는 절대 노출되지 않습니다.
//
// 필요한 환경변수(Supabase 프로젝트 → Edge Functions → Secrets):
//   NAVER_CLIENT_ID, NAVER_CLIENT_SECRET
// SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY는 Supabase가 자동으로 주입합니다.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const NAVER_CLIENT_ID = Deno.env.get("NAVER_CLIENT_ID")!;
const NAVER_CLIENT_SECRET = Deno.env.get("NAVER_CLIENT_SECRET")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

async function getCallingUser(req: Request) {
  const authHeader = req.headers.get("Authorization") || "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data, error } = await supabase.auth.getUser(jwt);
  if (error || !data.user) return null;
  return data.user;
}

function adminClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
}

// 네이버 OAuth 토큰 엔드포인트는 GET + 쿼리스트링 방식입니다 (공식 문서 기준).
async function naverTokenRequest(params: Record<string, string>) {
  const url = new URL("https://nid.naver.com/oauth2.0/token");
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString());
  return await res.json();
}

async function saveTokens(userId: string, tokens: any) {
  const admin = adminClient();
  const expiresIn = Number(tokens.expires_in) || 3600;
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
  const { error } = await admin.from("naver_tokens").upsert({
    user_id: userId,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: expiresAt,
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
}

async function getValidAccessToken(userId: string): Promise<string | null> {
  const admin = adminClient();
  const { data } = await admin.from("naver_tokens").select("*").eq("user_id", userId).maybeSingle();
  if (!data) return null;

  const expiringSoon = new Date(data.expires_at).getTime() - Date.now() < 5 * 60 * 1000;
  if (!expiringSoon) return data.access_token;

  const refreshed = await naverTokenRequest({
    grant_type: "refresh_token",
    client_id: NAVER_CLIENT_ID,
    client_secret: NAVER_CLIENT_SECRET,
    refresh_token: data.refresh_token,
  });
  if (!refreshed.access_token) return data.access_token; // 갱신 실패 시 기존 토큰으로 일단 시도
  await saveTokens(userId, { ...refreshed, refresh_token: refreshed.refresh_token || data.refresh_token });
  return refreshed.access_token;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  const user = await getCallingUser(req);
  if (!user) return json({ error: "로그인이 필요합니다." }, 401);

  let body: any = {};
  try {
    body = await req.json();
  } catch (_e) {
    // ignore
  }
  const action = body.action;

  try {
    if (action === "status") {
      const admin = adminClient();
      const { data } = await admin.from("naver_tokens").select("user_id").eq("user_id", user.id).maybeSingle();
      return json({ connected: !!data });
    }

    if (action === "exchange") {
      const { code, state } = body;
      if (!code || !state) return json({ error: "code/state가 없습니다." }, 400);
      const tokens = await naverTokenRequest({
        grant_type: "authorization_code",
        client_id: NAVER_CLIENT_ID,
        client_secret: NAVER_CLIENT_SECRET,
        code,
        state,
      });
      if (!tokens.access_token) {
        return json({ error: tokens.error_description || tokens.error || "토큰 발급 실패" }, 400);
      }
      await saveTokens(user.id, tokens);
      return json({ connected: true });
    }

    if (action === "disconnect") {
      const admin = adminClient();
      await admin.from("naver_tokens").delete().eq("user_id", user.id);
      return json({ connected: false });
    }

    if (action === "createSchedule") {
      const accessToken = await getValidAccessToken(user.id);
      if (!accessToken) return json({ error: "네이버 캘린더가 연결되어 있지 않습니다." }, 400);

      const icalString: string = body.icalString || "";
      const form = new URLSearchParams();
      form.set("calendarId", "defaultCalendarId");
      form.set("scheduleIcalString", icalString);

      const res = await fetch("https://openapi.naver.com/calendar/createSchedule.json", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + accessToken,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
      });
      const data = await res.json();
      if (data.result !== "success") {
        return json({ error: data.message || "네이버 캘린더 등록 실패", raw: data }, 400);
      }
      return json({ success: true, raw: data });
    }

    return json({ error: "알 수 없는 action입니다." }, 400);
  } catch (e) {
    return json({ error: String(e && e.message ? e.message : e) }, 500);
  }
});
