-- 012: 1차로 되돌아간 방에 남아 있는 결선 잔재 정리
--   결선까지 갔다가 뒤로 돌아오면 finalists / candidates / tiebreak 가 그대로 남아,
--   진행 단계가 실제보다 앞서 보이고 1차 후보가 좁아지는 문제가 있었습니다.
--   앱은 이제 1차에서 이 값들을 쓰지 않지만, 남은 데이터도 함께 정리합니다.

update public.rooms
set finalists = '{}', tiebreak = null, spin = null, candidates = '{}'
where round = 1
  and phase in ('lobby', 'vote', 'result');

-- 도달 단계도 실제 표에 맞춰 다시 계산합니다
update public.rooms r
set reached = case
  when r.phase = 'done' and r.winner is not null then 5
  when r.phase in ('choose', 'wheel') or r.round > 1 then 4
  when exists (select 1 from public.ballots b
               where b.room_id = r.id and b.round > 1 and b.deleted_at is null) then 4
  when exists (select 1 from public.ballots b
               where b.room_id = r.id and b.round = 1 and b.deleted_at is null) then 3
  else 2
end;
