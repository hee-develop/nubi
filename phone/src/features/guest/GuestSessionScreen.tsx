import { useRouter } from 'expo-router';
import { useState } from 'react';
import { TextInput } from 'react-native';
import { ApiError } from '../../api';
import { ConfirmModal } from '../../components/ConfirmModal';
import { Button, Card, Screen, StateView, Txt } from '../../components/ui';
import { useApiData } from '../../hooks/useApiData';
import { isGoneError } from '../../lib/errors';
import { fmtKm } from '../../lib/format';
import { t } from '../../lib/i18n';
import { colors, MIN_TOUCH } from '../../lib/theme';
import { useSession } from '../../state/session';

const DELETE_WORD = '삭제';

export const GuestSessionScreen = () => {
  const router = useRouter();
  const { api, guest, saveGuest, clearGuest, pairing } = useSession();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [leaveError, setLeaveError] = useState<'offline' | 'other' | null>(null);
  const [deleteStep, setDeleteStep] = useState<0 | 1 | 2>(0);
  const [typed, setTyped] = useState('');
  const [deleteState, setDeleteState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [version, setVersion] = useState(0);
  const summary = useApiData(() => (guest ? api.meSummary(guest.token) : Promise.reject(new Error('no guest'))), [api, guest?.token, version]);

  const home = () => router.replace(pairing ? '/(tabs)' : '/connect');

  if (!guest)
    return (
      <Screen title={t('guest.title')}>
        <StateView status="ready" empty emptyKey="guest.none" testID="guest" />
        <Button testID="guest-scan" label={t('guest.scan')} onPress={() => router.push('/scan?mode=guest')} />
        <Button label={t('common.back')} variant="secondary" onPress={() => (pairing ? router.replace('/(tabs)') : router.replace('/connect'))} />
      </Screen>
    );

  /** 서버에서 세션 종료를 받았거나(이미 종료 포함) 서버에 세션이 없을 때만 로컬 상태를 바꾼다. */
  const leave = async () => {
    setBusy(true);
    setLeaveError(null);
    try {
      await api.guestEnd(guest.sessionId, guest.token);
      await saveGuest({ ...guest, ended: true });
      setConfirm(false);
    } catch (e) {
      if (isGoneError(e)) {
        // 404 세션 없음·401 토큰 무효: 서버에 남은 세션이 없으니 로컬만 정리한다.
        await clearGuest();
        setConfirm(false);
        home();
      } else {
        setLeaveError(e instanceof ApiError && e.kind === 'offline' ? 'offline' : 'other');
      }
    } finally {
      setBusy(false);
    }
  };

  /** 서버에 닿지 않을 때의 탈출구. 서버에는 세션이 남아 있을 수 있다(차량 쪽 12시간 자동 종료·차주 '모두 내리기'). */
  const leaveLocal = async () => {
    await clearGuest();
    setConfirm(false);
    home();
  };

  const doDelete = async () => {
    setDeleteState('busy');
    try {
      await api.guestDeleteData(guest.sessionId, guest.token);
      setDeleteState('done');
      setDeleteStep(0);
      setTyped('');
      setVersion((v) => v + 1);
    } catch (e) {
      if (isGoneError(e)) {
        await clearGuest();
        setDeleteStep(0);
        home();
        return;
      }
      setDeleteState('error');
    }
  };

  const ended = !!guest.ended;

  return (
    <Screen title={t('guest.title')} subtitle={t('guest.subtitle')}>
      <Card>
        <Txt bold testID={ended ? 'guest-ended' : 'guest-active'}>
          {t(ended ? 'guest.ended' : 'guest.active')}
        </Txt>
        {guest.nickname ? <Txt muted>{t('guest.nickname', { name: guest.nickname })}</Txt> : null}
        <Txt muted size={13}>{t(ended ? 'guest.endedNote' : 'guest.activeNote')}</Txt>
      </Card>
      <Card>
        <Txt muted>{t('guest.mine')}</Txt>
        <StateView status={summary.status} onRetry={summary.reload} testID="guest-summary">
          {summary.data ? (
            <>
              <Txt size={24} bold testID="guest-regions">{t('guest.regions', { n: summary.data.regions?.colored ?? 0, total: summary.data.regions?.total ?? 0 })}</Txt>
              <Txt muted>{t('guest.newKm', { km: fmtKm(summary.data.coverage?.drivenKm ?? 0), n: summary.data.coverage?.roadsStarted ?? 0 })}</Txt>
            </>
          ) : null}
        </StateView>
      </Card>
      {leaveError ? (
        <Card>
          <Txt color={colors.danger} testID="guest-leave-error">{t(leaveError === 'offline' ? 'guest.leaveOffline' : 'guest.leaveFailed')}</Txt>
          {leaveError === 'offline' ? <Button testID="guest-leave-local" label={t('guest.leaveLocal')} variant="secondary" onPress={() => void leaveLocal()} /> : null}
        </Card>
      ) : null}
      {deleteState === 'done' ? <Txt testID="guest-delete-done" color={colors.accent}>{t('guest.deleteDone')}</Txt> : null}
      {!ended ? <Button testID="guest-leave" label={t('guest.leave')} variant="danger" onPress={() => { setLeaveError(null); setConfirm(true); }} /> : null}
      <Button testID="guest-delete" label={t('guest.deleteRecords')} variant="danger" onPress={() => { setDeleteState('idle'); setDeleteStep(1); }} />
      {ended ? <Button testID="guest-forget" label={t('guest.forget')} variant="secondary" onPress={() => { void clearGuest(); home(); }} /> : null}

      <ConfirmModal visible={confirm} testID="guest-confirm" title={t('guest.leaveTitle')} body={t('guest.leaveBody')} confirmLabel={t('guest.leave')} cancelLabel={t('common.cancel')} danger confirmDisabled={busy} onConfirm={() => void leave()} onCancel={() => setConfirm(false)} />
      <ConfirmModal visible={deleteStep === 1} testID="gdelete1" danger title={t('guest.deleteTitle')} body={t('guest.deleteBody')} confirmLabel={t('common.next')} cancelLabel={t('common.cancel')} onConfirm={() => setDeleteStep(2)} onCancel={() => setDeleteStep(0)} />
      <ConfirmModal visible={deleteStep === 2} testID="gdelete2" danger title={t('settings.delete2Title')} body={t('settings.delete2Body', { word: DELETE_WORD })} confirmLabel={t('guest.deleteNow')} cancelLabel={t('common.cancel')} confirmDisabled={typed.trim() !== DELETE_WORD || deleteState === 'busy'} onConfirm={() => void doDelete()} onCancel={() => { setDeleteStep(0); setTyped(''); }}>
        <TextInput testID="gdelete-input" style={{ minHeight: MIN_TOUCH, borderRadius: 12, borderWidth: 1.5, borderColor: colors.line, backgroundColor: colors.panel2, color: colors.text, fontSize: 16, paddingHorizontal: 12 }} value={typed} onChangeText={setTyped} placeholder={DELETE_WORD} placeholderTextColor={colors.muted} accessibilityLabel={t('guest.deleteTitle')} autoCapitalize="none" />
        {deleteState === 'error' ? <Txt color={colors.danger} testID="gdelete-error">{t('guest.deleteFailed')}</Txt> : null}
      </ConfirmModal>
    </Screen>
  );
};
