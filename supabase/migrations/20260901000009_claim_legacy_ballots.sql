-- 009: client_id 가 없던 시절에 낸 표에 주인을 채웁니다.
--
--   008 이전에 낸 표는 client_id 가 null 이라 "내 표 고치기" 가 뜨지 않습니다.
--   서버가 주인을 몰랐기 때문에 자동으로는 알 수 없고, 방 주인이 알려 준
--   코멘트 내용으로 짝지었습니다. 코멘트 첫 문장이 서로 겹치지 않아
--   확실하게 갈립니다.
--
--   앞으로 낸 표는 낼 때부터 client_id 가 붙으므로 이런 보정이 다시 필요하지 않습니다.

update public.ballots b
set client_id = v.client_id
from public.voters v
where b.client_id is null
  and v.room_id = b.room_id
  and (
    (v.name = '소엘' and b.entries::text like '%오페라하우스에서 공연을 볼 수 있다니%')
    or
    (v.name = '승연' and b.entries::text like '%초원에서 뛰놀고 싶습니다%')
  );
