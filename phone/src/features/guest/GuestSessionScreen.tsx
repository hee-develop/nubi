import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Button, Card, Screen, StateView, Txt } from '../../components/ui';
import { ConfirmModal } from '../../components/ConfirmModal';
import { useApiData } from '../../hooks/useApiData';
import { fmtKm } from '../../lib/format';
import { t } from '../../lib/i18n';
import { colors } from '../../lib/theme';
import { useSession } from '../../state/session';

export const GuestSessionScreen = () => {
  const router = useRouter();
  const { api, guest, clearGuest, pairing } = useSession();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const summary = useApiData(() => (guest ? api.meSummary(guest.token) : Promise.reject(new Error('no guest'))), [api, guest?.token]);

  if (!guest)
    return (
      <Screen title={t('guest.title')}>
        <StateView status="ready" empty emptyKey="guest.none" testID="guest" />
        <Button testID="guest-scan" label={t('guest.scan')} onPress={() => router.push('/scan?mode=guest')} />
        <Button label={t('common.back')} variant="secondary" onPress={() => (pairing ? router.replace('/(tabs)') : router.replace('/connect'))} />
      </Screen>
    );

  const leave = async () => {
    setBusy(true);
    setFailed(false);
    try {
      await api.guestEnd(guest.sessionId, guest.token);
      await clearGuest();
      setConfirm(false);
      router.replace(pairing ? '/(tabs)' : '/connect');
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title={t('guest.title')} subtitle={t('guest.subtitle')}>
      <Card>
        <Txt bold testID="guest-active">{t('guest.active')}</Txt>
        {guest.nickname ? <Txt muted>{t('guest.nickname', { name: guest.nickname })}</Txt> : null}
        <Txt muted size={13}>{t('guest.activeNote')}</Txt>
      </Card>
      <Card>
        <Txt muted>{t('guest.mine')}</Txt>
        <StateView status={summary.status} onRetry={summary.reload} testID="guest-summary">
          {summary.data ? (
            <>
              <Txt size={24} bold testID="guest-regions">{t('guest.regions', { n: summary.data.regionsColored, total: summary.data.regionsTotal })}</Txt>
              <Txt muted>{t('guest.newKm', { km: fmtKm(summary.data.newKm), n: summary.data.tripCount })}</Txt>
            </>
          ) : null}
        </StateView>
      </Card>
      {failed ? <Txt color={colors.danger} testID="guest-leave-error">{t('guest.leaveFailed')}</Txt> : null}
      <Button testID="guest-leave" label={t('guest.leave')} variant="danger" onPress={() => setConfirm(true)} />
      <ConfirmModal visible={confirm} testID="guest-confirm" title={t('guest.leaveTitle')} body={t('guest.leaveBody')} confirmLabel={t('guest.leave')} cancelLabel={t('common.cancel')} danger confirmDisabled={busy} onConfirm={() => void leave()} onCancel={() => setConfirm(false)} />
    </Screen>
  );
};
