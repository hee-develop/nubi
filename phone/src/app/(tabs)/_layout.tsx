import { Redirect, Tabs } from 'expo-router';
import { t } from '../../lib/i18n';
import { colors } from '../../lib/theme';
import { useSession } from '../../state/session';

export default function TabsLayout() {
  const { ready, pairing } = useSession();
  if (!ready) return null;
  if (!pairing) return <Redirect href="/connect" />;
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.muted,
        tabBarStyle: { backgroundColor: colors.panel, borderTopColor: colors.line },
        tabBarLabelStyle: { fontSize: 12, fontWeight: '700' },
        tabBarIcon: () => null,
        tabBarIconStyle: { display: 'none' },
      }}
    >
      <Tabs.Screen name="index" options={{ title: t('tab.home') }} />
      <Tabs.Screen name="map" options={{ title: t('tab.map') }} />
      <Tabs.Screen name="dex" options={{ title: t('tab.dex') }} />
      <Tabs.Screen name="roads" options={{ title: t('tab.roads') }} />
      <Tabs.Screen name="more" options={{ title: t('tab.more') }} />
    </Tabs>
  );
}
