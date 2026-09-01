-- 002: 나라 정보 + 선호 여행 날짜
-- Supabase 대시보드 > SQL Editor 에 붙여넣고 실행하세요. 여러 번 돌려도 안전합니다.

-- 여행지에 나라 정보를 붙입니다. 자유 입력으로 추가한 곳은 전부 null 로 남습니다.
alter table public.places add column if not exists country   text;      -- ISO 3166-1 alpha-2
alter table public.places add column if not exists city      text;
alter table public.places add column if not exists region    text;      -- 동아시아 / 유럽 ...
alter table public.places add column if not exists lat       double precision;
alter table public.places add column if not exists lon       double precision;
alter table public.places add column if not exists hours     double precision;  -- 인천 출발 비행시간
alter table public.places add column if not exists direct    boolean;
alter table public.places add column if not exists price_min integer;    -- 왕복 만원
alter table public.places add column if not exists price_max integer;

-- 참가자가 고른 선호 날짜. ["2027-03-14", ...]
alter table public.voters add column if not exists dates jsonb not null default '[]'::jsonb;

-- 이름 길이 제한을 조금 넉넉하게
alter table public.places drop constraint if exists places_name_check;
alter table public.places add  constraint places_name_check check (char_length(name) between 1 and 40);
