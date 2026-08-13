-- 네이버 캘린더 연동용 테이블. Supabase SQL Editor에 붙여넣고 실행하세요.
-- 이 테이블에는 anon/authenticated 역할에 아무 권한도 주지 않습니다.
-- (Edge Function이 SERVICE_ROLE 키로만 접근 — 클라이언트 JS에서는 절대 직접 읽거나 쓸 수 없습니다)

create table if not exists public.naver_tokens (
  user_id uuid primary key references auth.users(id) on delete cascade,
  access_token text not null,
  refresh_token text not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

alter table public.naver_tokens enable row level security;
-- 의도적으로 정책(policy)을 추가하지 않습니다 → anon/authenticated 키로는 전혀 접근 불가.
