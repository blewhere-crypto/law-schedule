// 푸시 알림 구독 관리 + 자동 발송용 Supabase Edge Function
//
// 프런트엔드에서는 sb.functions.invoke("push", { body: { action: "...", ... } })
// 형태로 호출합니다 (일반 로그인 사용자용). 지원 action:
//   subscribe / unsubscribe / status / get-settings / update-settings
//
// action: "send-daily-digest" (매일 아침 요약) / "send-reminders" (일정 N시간 전 알림)
// 은 사람이 아니라 pg_cron이 자동으로 호출합니다. 이 호출은 service_role 키를
// Authorization 헤더에 담아 보내며, 이 함수는 JWT의 role이 "service_role"인지 확인해서
// 일반 사용자가 이 action을 흉내낼 수 없도록 막습니다.
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

const DEFAULT_REMIND_HOURS = 2;

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

async function sendPushToSubs(admin: any, subs: any[], payload: string) {
  const results: any[] = [];
  for (const sub of subs) {
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
  return results;
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

    results.push(...(await sendPushToSubs(admin, byUser[userId], payload)));
  }

  return json({ sent: results.length, results });
}

// 일정 시각(date+time, 한국시간 기준)을 실제 Date 객체로 변환
function eventDateTimeKST(dateStr: string, timeStr: string): Date {
  // dateStr: "YYYY-MM-DD", timeStr: "HH:MM" — 둘 다 한국시간(UTC+9) 벽시계 기준
  return new Date(dateStr + "T" + timeStr + ":00+09:00");
}

async function sendReminders() {
  const admin = adminClient();

  // 사용자가 알람을 등록(remind_enabled=true)한 일정만 대상으로 함.
  // 시간이 지정돼 있고, 아직 완료되지 않았고, 리마인더를 아직 안 보낸 일정만 해당.
  const { data: events, error } = await admin
    .from("events")
    .select("*")
    .eq("done", false)
    .eq("remind_enabled", true)
    .is("reminder_sent_at", null)
    .not("time", "is", null)
    .neq("time", "");
  if (error) return json({ error: error.message }, 500);

  const now = new Date();
  const STALE_GRACE_MS = 24 * 60 * 60 * 1000; // 일정 시각이 24시간 넘게 지났으면 지금 와서 보내지 않음
  const dueEvents = (events || []).filter((e: any) => {
    const eventAt = eventDateTimeKST(e.date, e.time);
    if (isNaN(eventAt.getTime())) return false;
    return eventAt.getTime() > now.getTime() - STALE_GRACE_MS;
  });
  if (dueEvents.length === 0) return json({ sent: 0, checked: (events || []).length });

  // 대상 사용자들의 알림 설정 + 구독 목록을 한 번에 불러옴
  const userIds = Array.from(new Set(dueEvents.map((e: any) => e.user_id)));
  const { data: settingsRows } = await admin
    .from("user_settings")
    .select("*")
    .in("user_id", userIds);
  const settingsByUser: Record<string, number> = {};
  (settingsRows || []).forEach((s: any) => { settingsByUser[s.user_id] = s.remind_hours_before; });

  const { data: subsRows } = await admin
    .from("push_subscriptions")
    .select("*")
    .in("user_id", userIds);
  const subsByUser: Record<string, any[]> = {};
  (subsRows || []).forEach((s: any) => { (subsByUser[s.user_id] = subsByUser[s.user_id] || []).push(s); });

  const results: any[] = [];

  for (const ev of dueEvents) {
    const hoursBefore = settingsByUser[ev.user_id] ?? DEFAULT_REMIND_HOURS;
    const eventAt = eventDateTimeKST(ev.date, ev.time);
    const remindAt = eventAt.getTime() - hoursBefore * 60 * 60 * 1000;
    if (now.getTime() < remindAt) continue; // 아직 알림 시점이 안 됨

    const subs = subsByUser[ev.user_id] || [];
    if (subs.length > 0) {
      const label = ev.case_number + (ev.case_title ? "(" + ev.case_title + ")" : "");
      const title = hoursBefore + "시간 후 " + ev.type;
      const bodyText = label + " · " + ev.date + " " + ev.time;
      const payload = JSON.stringify({ title, body: bodyText });
      results.push(...(await sendPushToSubs(admin, subs, payload)));
    }

    // 구독이 없어도(알림을 꺼둔 상태여도) 다시 검사하지 않도록 발송 시각을 기록함
    await admin.from("events").update({ reminder_sent_at: new Date().toISOString() }).eq("id", ev.id);
  }

  return json({ sent: results.length, eventsNotified: dueEvents.length });
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
    if (action === "send-reminders") {
      if (role !== "service_role") return json({ error: "forbidden" }, 403);
      return await sendReminders();
    }

    // 이하 action은 실제 로그인한 사용자만 사용할 수 있습니다.
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

    if (action === "get-settings") {
      const admin = adminClient();
      const { data } = await admin.from("user_settings").select("remind_hours_before").eq("user_id", user.id).maybeSingle();
      return json({ remindHoursBefore: data ? data.remind_hours_before : DEFAULT_REMIND_HOURS });
    }

    if (action === "update-settings") {
      const hours = Number(body.remindHoursBefore);
      if (!Number.isFinite(hours) || hours <= 0 || hours > 168) {
        return json({ error: "시간 값이 올바르지 않습니다." }, 400);
      }
      const admin = adminClient();
      const { error } = await admin.from("user_settings").upsert(
        { user_id: user.id, remind_hours_before: hours, updated_at: new Date().toISOString() },
        { onConflict: "user_id" }
      );
      if (error) return json({ error: error.message }, 400);
      return json({ remindHoursBefore: hours });
    }

    return json({ error: "알 수 없는 action입니다." }, 400);
  } catch (e: any) {
    return json({ error: String(e && e.message ? e.message : e) }, 500);
  }
});
