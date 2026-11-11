/** 차주 토큰 공급(API 클라이언트가 호출 때마다 읽는다). 세션 저장·삭제 때 SessionProvider가 갱신한다. */
let ownerToken: string | null = null;
export const getOwnerToken = () => ownerToken;
export const setOwnerToken = (t: string | null) => {
  ownerToken = t;
};
