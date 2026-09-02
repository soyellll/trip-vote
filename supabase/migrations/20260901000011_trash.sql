-- 011: 휴지통 (소프트 삭제)
--   지금까지 삭제는 곧바로 DELETE 였고 되돌릴 방법이 없었습니다.
--   이제 deleted_at 을 찍어 숨기기만 하고, 휴지통에서 되돌릴 수 있게 합니다.
--   영구 삭제는 휴지통에서 따로, 삭제 코드를 다시 확인한 뒤에만 합니다.

alter table public.rooms   add column if not exists deleted_at timestamptz;
alter table public.places  add column if not exists deleted_at timestamptz;
alter table public.ballots add column if not exists deleted_at timestamptz;

create index if not exists rooms_live_idx   on public.rooms(deleted_at);
create index if not exists places_live_idx  on public.places(room_id, deleted_at);
create index if not exists ballots_live_idx on public.ballots(room_id, round, deleted_at);
