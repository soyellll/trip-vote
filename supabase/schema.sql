-- 여행지 소거전 — Supabase 스키마
-- Supabase 대시보드 > SQL Editor 에 통째로 붙여넣고 실행하세요.

create extension if not exists pgcrypto;

-- ─────────────────────────────────────────────────────────────
-- 테이블
-- ─────────────────────────────────────────────────────────────

create table if not exists public.rooms (
  id          uuid primary key default gen_random_uuid(),
  code        text unique not null check (char_length(code) between 4 and 16),
  phase       text not null default 'lobby',        -- lobby | vote | result | choose | wheel | done
  round       int  not null default 1,
  candidates  uuid[] not null default '{}',
  finalists   uuid[] not null default '{}',
  tiebreak    text,                                 -- revote | wheel
  winner      uuid,
  spin        jsonb,                                -- {id, deg, idx, order[]}
  created_at  timestamptz not null default now()
);

create table if not exists public.places (
  id        uuid primary key default gen_random_uuid(),
  room_id   uuid not null references public.rooms(id) on delete cascade,
  name      text not null check (char_length(name) between 1 and 28),
  note      text not null default '' check (char_length(note) <= 60),
  added_by  text not null default '' check (char_length(added_by) <= 12),
  sort      bigint not null default 0
);
create index if not exists places_room_idx on public.places(room_id);

create table if not exists public.voters (
  id         uuid primary key default gen_random_uuid(),
  room_id    uuid not null references public.rooms(id) on delete cascade,
  client_id  text not null check (char_length(client_id) <= 64),
  name       text not null check (char_length(name) between 1 and 12),
  rounds     jsonb not null default '{}'::jsonb,    -- {"r1": true, "r2": true}
  joined_at  timestamptz not null default now(),
  unique (room_id, client_id)
);
create index if not exists voters_room_idx on public.voters(room_id);

-- 표. 작성 시각을 일부러 저장하지 않습니다.
-- 시각이 남으면 voters 의 갱신 순서와 대조해 "세 번째로 투표한 사람이 어디에 표를 줬는지"가
-- 그대로 드러납니다. id 도 gen_random_uuid() 라 시간순 정보가 없습니다.
create table if not exists public.ballots (
  id       uuid primary key default gen_random_uuid(),
  room_id  uuid not null references public.rooms(id) on delete cascade,
  round    int not null,
  entries  jsonb not null                            -- [{place: uuid, comment: text}]
);
create index if not exists ballots_room_idx on public.ballots(room_id);

-- AI 변환 호출량. Edge Function 이 service role 로만 접근합니다.
create table if not exists public.tone_usage (
  user_id uuid not null,
  hour    timestamptz not null,
  n       int not null default 0,
  primary key (user_id, hour)
);

-- ─────────────────────────────────────────────────────────────
-- 방 코드 확인 헬퍼
--   클라이언트가 보낸 x-room-code 헤더로 방을 찾습니다.
--   rooms 를 직접 조회하는 정책은 재귀에 걸리므로 security definer 로 감쌉니다.
-- ─────────────────────────────────────────────────────────────

create or replace function public.current_room_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select r.id
  from public.rooms r
  where r.code = nullif(current_setting('request.headers', true)::json ->> 'x-room-code', '')
$$;

-- ─────────────────────────────────────────────────────────────
-- RLS
--   쓰기 : 방 코드를 헤더로 증명해야 함 (모르는 사람이 남의 방을 망칠 수 없음)
--   읽기 : 로그인한 클라이언트면 허용
--          Realtime 구독은 REST 헤더를 전달하지 않기 때문에, 읽기까지 방 코드로 막으면
--          실시간 동기화가 통째로 죽습니다. 트레이드오프는 README 참고.
-- ─────────────────────────────────────────────────────────────

alter table public.rooms      enable row level security;
alter table public.places     enable row level security;
alter table public.voters     enable row level security;
alter table public.ballots    enable row level security;
alter table public.tone_usage enable row level security;   -- 정책 없음 = service role 만 접근

drop policy if exists rooms_read   on public.rooms;
drop policy if exists places_read  on public.places;
drop policy if exists voters_read  on public.voters;
drop policy if exists ballots_read on public.ballots;

create policy rooms_read   on public.rooms   for select to authenticated using (true);
create policy places_read  on public.places  for select to authenticated using (true);
create policy voters_read  on public.voters  for select to authenticated using (true);
create policy ballots_read on public.ballots for select to authenticated using (true);

drop policy if exists rooms_insert on public.rooms;
drop policy if exists rooms_update on public.rooms;

create policy rooms_insert on public.rooms for insert to authenticated
  with check (code = nullif(current_setting('request.headers', true)::json ->> 'x-room-code', ''));
create policy rooms_update on public.rooms for update to authenticated
  using (id = public.current_room_id())
  with check (id = public.current_room_id());

drop policy if exists places_write  on public.places;
drop policy if exists voters_write  on public.voters;
drop policy if exists ballots_write on public.ballots;

create policy places_write on public.places for all to authenticated
  using (room_id = public.current_room_id())
  with check (room_id = public.current_room_id());
create policy voters_write on public.voters for all to authenticated
  using (room_id = public.current_room_id())
  with check (room_id = public.current_room_id());
create policy ballots_write on public.ballots for all to authenticated
  using (room_id = public.current_room_id())
  with check (room_id = public.current_room_id());

-- ─────────────────────────────────────────────────────────────
-- Realtime
--   ballots 는 일부러 뺐습니다. 표가 실시간으로 흘러나가면, 개발자도구를 켜 둔 사람이
--   "표 INSERT" 와 "누가 방금 투표 완료로 바뀌었는지" 를 나란히 보고 짝지을 수 있습니다.
--   표는 결과를 열 때 한 번에 가져옵니다.
-- ─────────────────────────────────────────────────────────────

do $$
begin
  begin execute 'alter publication supabase_realtime add table public.rooms';  exception when duplicate_object then null; end;
  begin execute 'alter publication supabase_realtime add table public.places'; exception when duplicate_object then null; end;
  begin execute 'alter publication supabase_realtime add table public.voters'; exception when duplicate_object then null; end;
end $$;

-- ─────────────────────────────────────────────────────────────
-- AI 변환 쿼터 (Edge Function 전용)
-- ─────────────────────────────────────────────────────────────

create or replace function public.consume_tone_quota(p_user uuid, p_limit int)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hour timestamptz := date_trunc('hour', now());
  v_n int;
begin
  insert into public.tone_usage (user_id, hour, n)
  values (p_user, v_hour, 1)
  on conflict (user_id, hour) do update set n = public.tone_usage.n + 1
  returning n into v_n;

  delete from public.tone_usage where hour < now() - interval '2 days';

  return v_n <= p_limit;
end
$$;

revoke all on function public.consume_tone_quota(uuid, int) from public, anon, authenticated;
