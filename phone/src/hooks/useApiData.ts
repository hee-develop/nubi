import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../api';

type Settled<T> = { status: 'ready'; data: T } | { status: 'offline'; data: null } | { status: 'error'; data: null; code: string };
export type DataState<T> = { status: 'loading'; data: null } | Settled<T>;

/**
 * API 호출 결과를 loading/ready/offline/error 상태로 돌려준다. empty와 권한 거부는 화면이 data·권한으로 판단한다.
 * 의존값이 바뀌거나 reload()를 부르면 새 요청 토큰이 만들어지고, 그 결과가 올 때까지 loading이다.
 */
export const useApiData = <T,>(load: () => Promise<T>, deps: readonly unknown[]): DataState<T> & { reload: () => void } => {
  const [settled, setSettled] = useState<{ req: object; state: Settled<T> } | null>(null);
  // 의존값이 바뀌면 렌더 중에 새 요청 토큰을 만든다(파생 상태 패턴).
  const [prev, setPrev] = useState<readonly unknown[]>(deps);
  const [req, setReq] = useState<object>({});
  if (prev.length !== deps.length || prev.some((d, i) => !Object.is(d, deps[i]))) {
    setPrev(deps);
    setReq({});
  }

  useEffect(() => {
    let alive = true;
    load().then(
      (data) => alive && setSettled({ req, state: { status: 'ready', data } }),
      (e: unknown) => {
        if (!alive) return;
        if (e instanceof ApiError && e.kind === 'offline') setSettled({ req, state: { status: 'offline', data: null } });
        else setSettled({ req, state: { status: 'error', data: null, code: e instanceof ApiError ? e.code : 'unknown' } });
      },
    );
    return () => {
      alive = false;
    };
    // load는 이 렌더의 클로저를 그대로 쓴다. 다시 부르는 기준은 req 토큰이다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req]);

  const reload = useCallback(() => setReq({}), []);
  const state: DataState<T> = settled && settled.req === req ? settled.state : { status: 'loading', data: null };
  return { ...state, reload };
};
