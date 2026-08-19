-- 푸시 알림 구독 저장용 테이블. Supabase SQL Editor에 붙여넣고 실행하세요.
-- naver_tokens와 마찬가지로 anon/authenticated 역할에는 아무 권한도 주지 않습니다.
-- (Edge Function이 SERVICE_ROLE 키로만 접근 — 클라이언트 JS에서는 절대 직접 읽거나 쓸 수 없습니다)

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);

create index if not exists push_subscriptions_user_id_idx on public.push_subscriptions(user_id);

alter table public.push_subscriptions enable row level security;
-- 의도적으로 정책(policy)을 추가하지 않습니다 → anon/authenticated 키로는 전혀 접근 불가.


-- ============================================================
-- 아래는 "매일 아침 오늘 일정 요약 푸시"를 자동 실행하는 예약 작업입니다.
-- 1) 먼저 Supabase 대시보드 → Database → Extensions 에서 pg_cron, pg_net 을 켜주세요.
-- 2) 아래에서 YOUR_SERVICE_ROLE_KEY 부분을,
--    Project Settings → API 에 있는 service_role 키(비밀 키! anon 키 아님)로 바꾼 뒤 실행하세요.
--    이 키는 절대 코드/채팅으로 공유하지 말고 여기 SQL Editor에만 붙여넣어주세요.
-- ============================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 매일 한국시간(KST) 오전 8시 = UTC 전날 23시에 실행
select cron.schedule(
  'daily-schedule-push',
  '0 23 * * *',
  $$
  select net.http_post(
    url := 'https://vgqhteollbpdvpdsogsy.supabase.co/functions/v1/push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer YOUR_SERVICE_ROLE_KEY'
    ),
    body := jsonb_build_object('action', 'send-daily-digest')
  );
  $$
);

-- 이미 등록한 예약 작업을 지우고 싶을 때:
-- select cron.unschedule('daily-schedule-push');

-- 예약 작업이 잘 등록됐는지 확인:
-- select * from cron.job;
