import { Redirect } from 'expo-router';
import type { ReactNode } from 'react';
import { useSession } from '../state/session';

/** 연결된 차가 없으면 연결 화면으로 보낸다(탭 밖 라우트용 가드). */
export const RequirePairing = ({ children }: { children: ReactNode }) => {
  const { ready, pairing } = useSession();
  if (!ready) return null;
  if (!pairing) return <Redirect href="/connect" />;
  return <>{children}</>;
};
