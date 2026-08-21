-- 일정관리 앱: Supabase SQL Editor에 붙여넣고 실행하세요 (한 번만 하면 됩니다)

create extension if not exists pgcrypto;

create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  case_number text not null,
  case_title text not null default '',
  type text not null,
  date date not null,
  time text not null default '',
  court text not null default '',
  memo text not null default '',
  done boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.events enable row level security;

create policy "individual read" on public.events
  for select using (auth.uid() = user_id);

create policy "individual insert" on public.events
  for insert with check (auth.uid() = user_id);

create policy "individual update" on public.events
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "individual delete" on public.events
  for delete using (auth.uid() = user_id);

alter publication supabase_realtime add table public.events;


-- 사건별(의뢰인) 보기에서 사용자가 직접 정한 정렬 순서 저장용 (사용자 1명당 1행)
create table if not exists public.case_order (
  user_id uuid primary key references auth.users(id) on delete cascade,
  order_list jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.case_order enable row level security;

create policy "individual read" on public.case_order
  for select using (auth.uid() = user_id);

create policy "individual insert" on public.case_order
  for insert with check (auth.uid() = user_id);

create policy "individual update" on public.case_order
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
