-- 006: 이 방이 지금까지 도달한 최고 단계
--   phase 는 뒤로 가기로 되돌아갈 수 있어서, "어디까지 해봤는지" 를 따로 기억합니다.
--   2 여행지 / 3 1차 / 4 결선 / 5 확정  (1 참가·날짜는 개인 단계라 방에 저장하지 않습니다)

alter table public.rooms add column if not exists reached integer not null default 2;
alter table public.rooms drop constraint if exists rooms_reached_check;
alter table public.rooms add constraint rooms_reached_check check (reached between 1 and 5);
