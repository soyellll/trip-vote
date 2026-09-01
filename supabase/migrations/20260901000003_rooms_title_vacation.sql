-- 003: 방 이름/연도 + 휴가 일수
--   방을 코드로 찾지 않고 이름으로 골라 들어가게 바꿉니다.
--   code 는 RLS 게이트용으로 계속 남지만 화면에는 나오지 않습니다.

alter table public.rooms add column if not exists title text;
alter table public.rooms add column if not exists year  integer not null default 2027;

-- 이름 없는 기존 방에 임시 이름
update public.rooms set title = coalesce(title, year || '년도 여행') where title is null;

alter table public.rooms
  drop constraint if exists rooms_title_check;
alter table public.rooms
  add constraint rooms_title_check check (title is null or char_length(title) between 1 and 24);

alter table public.rooms
  drop constraint if exists rooms_year_check;
alter table public.rooms
  add constraint rooms_year_check check (year between 2026 and 2035);

-- 참가자가 쓸 수 있는 휴가 일수 (주말 제외 평일 기준). null = 안 적음
alter table public.voters add column if not exists vacation_days integer;
alter table public.voters
  drop constraint if exists voters_vacation_check;
alter table public.voters
  add constraint voters_vacation_check check (vacation_days is null or vacation_days between 1 and 60);
