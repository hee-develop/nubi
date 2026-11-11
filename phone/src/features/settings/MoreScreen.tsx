import { useRouter } from 'expo-router';
import { Button, Card, Screen, Txt } from '../../components/ui';
import { t } from '../../lib/i18n';
import { useSession } from '../../state/session';

export const MoreScreen = () => {
  const router = useRouter();
  const { guest, api } = useSession();
  return (
    <Screen title={t('more.title')}>
      <Card>
        <Txt bold>{t('more.share')}</Txt>
        <Txt muted>{t('more.shareBody')}</Txt>
        <Button testID="more-share" label={t('more.shareBtn')} onPress={() => router.push('/share')} />
      </Card>
      <Card>
        <Txt bold>{t('more.guest')}</Txt>
        <Txt muted>{t(guest ? 'more.guestActive' : 'more.guestBody')}</Txt>
        <Button testID="more-guest" label={t(guest ? 'more.guestOpen' : 'more.guestScan')} variant="secondary" onPress={() => router.push(guest ? '/guest' : '/scan?mode=guest')} />
      </Card>
      <Card>
        <Txt bold>{t('more.settings')}</Txt>
        <Button testID="more-settings" label={t('more.settingsBtn')} variant="secondary" onPress={() => router.push('/settings')} />
      </Card>
      <Txt muted size={12} testID="more-mode">{t('more.mode', { mode: api.mode })}</Txt>
    </Screen>
  );
};
