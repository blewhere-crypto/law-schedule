// 푸시 알림 구독 관리 + 매일 아침 요약 발송용 Supabase Edge Function
//
// 프런트엔드에서는 sb.functions.invoke("push", { body: { action: "subscribe"|"unsubscribe"|"status", ... } })
// 형태로 호출합니다 (일반 로그인 사용자용).
//
// action: "send-daily-digest" 는 사람이 아니라 pg_cron이 매일 자동으로 호출합니다.
// 이 호출은 service_role 키를 Authorization 헤더에 담아 보내며, 이 함수는 JWT의 role이
// "service_role"인지 확인해서 일반 사용자가 이 액션을 흉내낼 수 없도록 막습니다.
//
// 필요한 환경변수(Supabase 프로젝트 → Edge Functions → Secrets):
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT(선택, 기본값 사용)
// SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY는 Supabase가 자동으로 주입합니다.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") || "mailto:admin@example.com";

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

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

function decodeJwtRole(jwt: string): string | null {
  try {
    const payloadB64 = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(payloadB64));
    return payload.role || null;
  } catch (_e) {
    return null;
  }
}

async function getCallingUser(req: Request) {
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data, error } = await supabase.auth.getUser(jwt);
  if (error || !data.user) return null;
  return data.user;
}

function adminClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
}

async function sendDailyDigest() {
  const admin = adminClient();
  const { data: subs, error } = await admin.from("push_subscriptions").select("*");
  if (error) return json({ error: error.message }, 500);

  const todayStr = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" }); // YYYY-MM-DD

  const byUser: Record<string, any[]> = {};
  (subs || []).forEach((s: any) => {
    (byUser[s.user_id] = byUser[s.user_id] || []).push(s);
  });

  const results: any[] = [];

  for (const userId of Object.keys(byUser)) {
    const { data: events } = await admin
      .from("events")
      .select("*")
      .eq("user_id", userId)
      .eq("done", false)
      .eq("date", todayStr);

    const count = (events || []).length;
    if (count === 0) continue; // 오늘 일정이 없으면 발송하지 않음

    const title = "오늘 일정 " + count + "건";
    const bodyText = (events || [])
      .slice(0, 3)
      .map((e: any) => e.case_number + (e.case_title ? "(" + e.case_title + ")" : "") + " · " + e.type)
      .join("\n");
    const payload = JSON.stringify({ title, body: bodyText });

    for (const sub of byUser[userId]) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload
        );
        results.push({ endpoint: sub.endpoint, ok: true });
      } catch (e: any) {
        results.push({ endpoint: sub.endpoint, ok: false, error: String(e) });
        if (e && (e.statusCode === 410 || e.statusCode === 404)) {
          await admin.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
        }
      }
    }
  }

  return json({ sent: results.length, results });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  let body: any = {};
  try {
    body = await req.json();
  } catch (_e) {
    // ignore
  }
  const action = body.action;

  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const role = decodeJwtRole(jwt);

  try {
    if (action === "send-daily-digest") {
      if (role !== "service_role") return json({ error: "forbidden" }, 403);
      return await sendDailyDigest();
    }

    // 이하 액션은 실제 로그인한 사용자만 사용할 수 있습니다.
    const user = await getCallingUser(req);
    if (!user) return json({ error: "로그인이 필요합니다." }, 401);

    if (action === "subscribe") {
      const sub = body.subscription;
      if (!sub || !sub.endpoint || !sub.keys) return json({ error: "구독 정보가 없습니다." }, 400);
      const admin = adminClient();
      const { error } = await admin.from("push_subscriptions").upsert(
        {
          user_id: user.id,
          endpoint: sub.endpoint,
          p256dh: sub.keys.p256dh,
          auth: sub.keys.auth,
        },
        { onConflict: "endpoint" }
      );
      if (error) return json({ error: error.message }, 400);
      return json({ subscribed: true });
    }

    if (action === "unsubscribe") {
      const admin = adminClient();
      await admin.from("push_subscriptions").delete().eq("user_id", user.id).eq("endpoint", body.endpoint || "");
      return json({ subscribed: false });
    }

    if (action === "status") {
      const admin = adminClient();
      const { data } = await admin.from("push_subscriptions").select("id").eq("user_id", user.id).limit(1);
      return json({ subscribed: !!(data && data.length) });
    }

    return json({ error: "알 수 없는 action입니다." }, 400);
  } catch (e: any) {
    return json({ error: String(e && e.message ? e.message : e) }, 500);
  }
});
