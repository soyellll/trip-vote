-- 004: 방 삭제
--   방 목록이 쌓이기만 하면 못 쓰게 됩니다. 다른 테이블과 같은 방식으로
--   x-room-code 헤더를 증명한 클라이언트만 그 방을 지울 수 있게 합니다.
--   places/voters/ballots 는 on delete cascade 로 같이 지워집니다.

drop policy if exists rooms_delete on public.rooms;
create policy rooms_delete on public.rooms for delete to authenticated
  using (id = public.current_room_id());
