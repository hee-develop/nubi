import { RequirePairing } from '../components/RequirePairing';
import { ShareScreen } from '../features/share/ShareScreen';

export default function ShareRoute() {
  return (
    <RequirePairing>
      <ShareScreen />
    </RequirePairing>
  );
}
