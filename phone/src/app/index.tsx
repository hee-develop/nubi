import { Redirect } from 'expo-router';
import { useSession } from '../state/session';

/** 연결된 차가 있으면 탭, 게스트 세션만 있으면 게스트 화면, 아무것도 없으면 연결 화면. */
export default function Index() {
  const { ready, pairing, guest } = useSession();
  if (!ready) return null;
  if (pairing) return <Redirect href="/(tabs)" />;
  return <Redirect href={guest ? '/guest' : '/connect'} />;
}
