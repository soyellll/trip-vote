-- 007: 이미 진행된 방들의 reached 를 실제 기록에서 되살립니다.
--   006 을 default 2 로 넣었기 때문에, 이미 투표까지 한 방도 2 로 남아 있습니다.

update public.rooms r
set reached = greatest(
  r.reached,
  case
    when r.phase = 'done' then 5
    when r.phase in ('choose', 'wheel') then 4
    when exists (select 1 from public.ballots b where b.room_id = r.id and b.round > 1) then 4
    when exists (select 1 from public.ballots b where b.room_id = r.id and b.round = 1) then 3
    when exists (select 1 from public.places p where p.room_id = r.id) then 2
    else 2
  end
);
