import { RequirePairing } from '../components/RequirePairing';
import { SettingsScreen } from '../features/settings/SettingsScreen';

export default function SettingsRoute() {
  return (
    <RequirePairing>
      <SettingsScreen />
    </RequirePairing>
  );
}
