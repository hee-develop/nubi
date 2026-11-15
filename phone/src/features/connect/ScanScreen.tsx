import { CameraView, useCameraPermissions } from 'expo-camera';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { Button, Card, Screen, Txt } from '../../components/ui';
import { t, type TKey } from '../../lib/i18n';
import { colors } from '../../lib/theme';
import { useSession } from '../../state/session';
import { claimErrorKey } from '../../lib/errors';
import { CodeEntry } from './ConnectScreen';
import { parseQr } from './qr';

/** 카메라는 사용 시점(이 화면)에 권한을 요청한다. 거부되면 설정 열기와 코드 직접 입력으로 이어 간다. */
export const ScanScreen = () => {
  const { mode: modeParam, consent } = useLocalSearchParams<{ mode?: string; consent?: string }>();
  const mode: 'pair' | 'guest' = modeParam === 'guest' ? 'guest' : 'pair';
  const router = useRouter();
  const { api, savePairing } = useSession();
  const [permission, requestPermission] = useCameraPermissions();
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<TKey | null>(null);
  const handled = useRef(false);
  const lastBad = useRef(0);

  const proceed = async (code: string, kind: 'pair' | 'guest' | null) => {
    const k = kind ?? mode;
    if (k !== mode) {
      lastBad.current = Date.now();
      setErrorKey(mode === 'pair' ? 'scan.err.wrongGuest' : 'scan.err.wrongPair');
      handled.current = false;
      return;
    }
    if (mode === 'guest') {
      router.replace({ pathname: '/guest/consent', params: { code } });
      return;
    }
    // 차주 연결은 연결 화면에서 위치정보 이용 동의를 받은 경우에만 보낸다.
    if (consent !== '1') {
      setErrorKey('connect.err.consentNeeded');
      handled.current = false;
      return;
    }
    setBusy(true);
    setErrorKey(null);
    try {
      await savePairing(await api.pairClaim(code, true));
      router.replace('/(tabs)');
    } catch (e) {
      setErrorKey(claimErrorKey(e));
      handled.current = false;
    } finally {
      setBusy(false);
    }
  };

  const onScanned = (raw: string) => {
    if (handled.current) return;
    // 카메라는 같은 QR을 초당 여러 번 알려 준다. 잘못된 QR은 1.5초에 한 번만 처리한다.
    if (Date.now() - lastBad.current < 1500) return;
    const q = parseQr(raw);
    if (!q) {
      lastBad.current = Date.now();
      setErrorKey('scan.err.unknownQr');
      return;
    }
    handled.current = true;
    void proceed(q.code, q.kind);
  };

  const title = t(mode === 'pair' ? 'scan.titlePair' : 'scan.titleGuest');

  if (!permission) return <Screen title={title}><Txt muted testID="scan-loading">{t('state.loading')}</Txt></Screen>;

  if (!permission.granted)
    return (
      <Screen title={title}>
        <Card>
          <Txt bold testID="scan-denied">{t('scan.denied.title')}</Txt>
          <Txt muted>{t('scan.denied.body')}</Txt>
          {permission.canAskAgain ? (
            <Button testID="scan-allow" label={t('scan.denied.allow')} onPress={() => void requestPermission()} />
          ) : (
            <Button testID="scan-settings" label={t('scan.denied.settings')} onPress={() => void Linking.openSettings()} />
          )}
        </Card>
        <Card>
          <Txt bold>{t('scan.manual')}</Txt>
          <CodeEntry mode={mode} busy={busy} errorKey={errorKey} onSubmit={(c) => void proceed(c, null)} />
        </Card>
      </Screen>
    );

  return (
    <Screen title={title} subtitle={t('scan.hint')} scroll={false}>
      <View style={styles.cam}>
        <CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={(e) => onScanned(e.data)} />
      </View>
      {busy ? <Txt muted>{t('state.loading')}</Txt> : null}
      {errorKey ? <Txt color={colors.danger} testID="scan-error">{t(errorKey)}</Txt> : null}
      <Card>
        <Txt muted>{t('scan.manual')}</Txt>
        <CodeEntry mode={mode} busy={busy} errorKey={null} onSubmit={(c) => void proceed(c, null)} />
      </Card>
    </Screen>
  );
};

const styles = StyleSheet.create({
  cam: { height: 300, borderRadius: 16, overflow: 'hidden', borderWidth: 1, borderColor: colors.line, backgroundColor: '#000' },
});
