import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Modal, ScrollView, StyleSheet, Switch, TextInput, View } from 'react-native';
import { ConfirmModal } from '../../components/ConfirmModal';
import { Button, Card, Chip, Screen, StateView, Txt } from '../../components/ui';
import { ApiError, type VehicleSettings } from '../../api';
import { useApiData } from '../../hooks/useApiData';
import { t, type TKey } from '../../lib/i18n';
import { colors, MIN_TOUCH } from '../../lib/theme';
import { useSession } from '../../state/session';

export const DELETE_WORD = '삭제';

const ToggleRow = ({ label, note, value, onChange, testID, disabled }: { label: string; note?: string; value: boolean; onChange: (v: boolean) => void; testID: string; disabled?: boolean }) => (
  <View style={styles.row}>
    <View style={{ flex: 1 }}>
      <Txt bold>{label}</Txt>
      {note ? <Txt muted size={13}>{note}</Txt> : null}
    </View>
    <Switch testID={testID} accessibilityLabel={label} value={value} onValueChange={onChange} disabled={disabled} trackColor={{ true: colors.accent, false: colors.line }} />
  </View>
);

const RegionPicker = ({ visible, current, onPick, onClose }: { visible: boolean; current: string | null; onPick: (code: string | null) => void; onClose: () => void }) => {
  const { api, pairing } = useSession();
  const [q, setQ] = useState('');
  const list = useApiData(() => (visible ? api.regionsList(pairing?.vehicleId ?? '') : Promise.resolve(null)), [api, pairing?.vehicleId, visible]);
  const items = (list.data?.items ?? []).filter((r) => !q || r.displayName.includes(q)).slice(0, 60);
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <Screen title={t('settings.home.pick')} scroll={false}>
        <TextInput testID="region-filter" style={styles.input} value={q} onChangeText={setQ} placeholder={t('settings.home.search')} placeholderTextColor={colors.muted} accessibilityLabel={t('settings.home.search')} />
        <Chip testID="region-none" label={t('settings.home.none')} on={current === null} onPress={() => onPick(null)} />
        <ScrollView contentContainerStyle={{ gap: 8, paddingVertical: 8 }}>
          <StateView status={list.status} onRetry={list.reload} empty={list.status === 'ready' && items.length === 0} emptyKey="settings.home.noResult" testID="region">
            <View style={styles.wrap}>
              {items.map((r) => (
                <Chip key={r.code} testID={`region-${r.code}`} label={r.displayName} on={current === r.code} onPress={() => onPick(r.code)} />
              ))}
            </View>
          </StateView>
        </ScrollView>
        <Button label={t('common.close')} variant="secondary" onPress={onClose} />
      </Screen>
    </Modal>
  );
};

export const SettingsScreen = () => {
  const router = useRouter();
  const { api, pairing, clearPairing } = useSession();
  const vehicleId = pairing?.vehicleId ?? '';
  const settings = useApiData(() => api.getSettings(vehicleId), [api, vehicleId]);
  const guests = useApiData(() => api.guestSessions(vehicleId), [api, vehicleId]);
  const [local, setLocal] = useState<VehicleSettings | null>(null);
  const [saveError, setSaveError] = useState<TKey | null>(null);
  const [pickRegion, setPickRegion] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [disconnectFailed, setDisconnectFailed] = useState(false);
  const [deleteStep, setDeleteStep] = useState<0 | 1 | 2>(0);
  const [typed, setTyped] = useState('');
  const [deleteState, setDeleteState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');

  const current = local ?? settings.data;

  const save = async (patch: Partial<VehicleSettings>) => {
    if (!current) return;
    const next = { ...current, ...patch };
    setLocal(next);
    setSaveError(null);
    try {
      setLocal(await api.putSettings(vehicleId, next));
    } catch (e) {
      setLocal(current);
      setSaveError(e instanceof ApiError && e.kind === 'offline' ? 'settings.err.offline' : 'settings.err.save');
    }
  };

  const disconnect = async (serverToo: boolean) => {
    setDisconnectFailed(false);
    try {
      if (serverToo && pairing) await api.pairDelete(pairing.token);
      await clearPairing();
      setDisconnectOpen(false);
      router.replace('/connect');
    } catch {
      setDisconnectFailed(true);
    }
  };

  const doDelete = async () => {
    setDeleteState('busy');
    try {
      await api.deleteData(vehicleId);
      setDeleteState('done');
      setDeleteStep(0);
      setTyped('');
      setLocal(null);
      settings.reload();
    } catch {
      setDeleteState('error');
    }
  };

  return (
    <Screen title={t('settings.title')}>
      <Card>
        <Txt muted>{t('settings.recording')}</Txt>
        <StateView status={settings.status} onRetry={settings.reload} testID="settings">
          {current ? (
            <>
              <ToggleRow testID="set-paused" label={t('settings.paused')} note={t('settings.pausedNote')} value={current.recordingPaused} onChange={(v) => void save({ recordingPaused: v })} />
              <ToggleRow testID="set-stats" label={t('settings.stats')} note={t('settings.statsNote')} value={current.statsOptIn} onChange={(v) => void save({ statsOptIn: v })} />
              <ToggleRow testID="set-driving" label={t('settings.drivingMap')} note={t('settings.drivingMapNote')} value={current.drivingMap} onChange={(v) => void save({ drivingMap: v })} />
              <View style={styles.row}>
                <View style={{ flex: 1 }}>
                  <Txt bold>{t('settings.home')}</Txt>
                  <Txt muted size={13} testID="set-home-value">{current.homeRegion ?? t('settings.home.none')}</Txt>
                  <Txt muted size={13}>{t('settings.homeNote')}</Txt>
                </View>
                <Button testID="set-home" label={t('settings.home.change')} variant="secondary" onPress={() => setPickRegion(true)} />
              </View>
              {saveError ? <Txt color={colors.danger} testID="set-error">{t(saveError)}</Txt> : null}
            </>
          ) : null}
        </StateView>
      </Card>

      <Card>
        <Txt muted>{t('settings.guests')}</Txt>
        <StateView status={guests.status} onRetry={guests.reload} testID="settings-guests">
          {guests.data ? <Txt testID="set-guests">{t('settings.guestsActive', { n: guests.data.active })}</Txt> : null}
        </StateView>
      </Card>

      <Card>
        <Txt muted>{t('settings.account')}</Txt>
        <Txt muted size={13}>{t('settings.vehicle', { id: vehicleId.slice(0, 8) })}</Txt>
        <Button testID="set-disconnect" label={t('settings.disconnect')} variant="secondary" onPress={() => setDisconnectOpen(true)} />
        <Button testID="set-delete" label={t('settings.delete')} variant="danger" onPress={() => { setDeleteState('idle'); setDeleteStep(1); }} />
        {deleteState === 'done' ? <Txt testID="set-delete-done" color={colors.accent}>{t('settings.deleteDone')}</Txt> : null}
      </Card>

      <RegionPicker visible={pickRegion} current={current?.homeRegion ?? null} onClose={() => setPickRegion(false)} onPick={(code) => { setPickRegion(false); void save({ homeRegion: code }); }} />

      <ConfirmModal visible={disconnectOpen} testID="disconnect" title={t('settings.disconnectTitle')} body={t('settings.disconnectBody')} confirmLabel={t('settings.disconnect')} cancelLabel={t('common.cancel')} onConfirm={() => void disconnect(true)} onCancel={() => setDisconnectOpen(false)}>
        {disconnectFailed ? (
          <View style={{ gap: 8 }}>
            <Txt color={colors.danger} testID="disconnect-error">{t('settings.disconnectFailed')}</Txt>
            <Button testID="disconnect-local" label={t('settings.disconnectLocal')} variant="secondary" onPress={() => void disconnect(false)} />
          </View>
        ) : null}
      </ConfirmModal>

      <ConfirmModal visible={deleteStep === 1} testID="delete1" danger title={t('settings.delete1Title')} body={t('settings.delete1Body')} confirmLabel={t('common.next')} cancelLabel={t('common.cancel')} onConfirm={() => setDeleteStep(2)} onCancel={() => setDeleteStep(0)} />
      <ConfirmModal visible={deleteStep === 2} testID="delete2" danger title={t('settings.delete2Title')} body={t('settings.delete2Body', { word: DELETE_WORD })} confirmLabel={t('settings.deleteNow')} cancelLabel={t('common.cancel')} confirmDisabled={typed.trim() !== DELETE_WORD || deleteState === 'busy'} onConfirm={() => void doDelete()} onCancel={() => { setDeleteStep(0); setTyped(''); }}>
        <TextInput testID="delete-input" style={styles.input} value={typed} onChangeText={setTyped} placeholder={DELETE_WORD} placeholderTextColor={colors.muted} accessibilityLabel={t('settings.delete2Title')} autoCapitalize="none" />
        {deleteState === 'error' ? <Txt color={colors.danger} testID="delete-error">{t('settings.deleteFailed')}</Txt> : null}
      </ConfirmModal>
    </Screen>
  );
};

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: MIN_TOUCH },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  input: { minHeight: MIN_TOUCH, borderRadius: 12, borderWidth: 1.5, borderColor: colors.line, backgroundColor: colors.panel2, color: colors.text, fontSize: 16, paddingHorizontal: 12 },
});
