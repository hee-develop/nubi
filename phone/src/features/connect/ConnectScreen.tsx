import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { Button, Card, Screen, Txt } from '../../components/ui';
import { ConsentBox } from '../../components/ConsentBox';
import { claimErrorKey } from '../../lib/errors';
import { t, type TKey } from '../../lib/i18n';
import { colors, MIN_TOUCH } from '../../lib/theme';
import { useSession } from '../../state/session';

/** 6자리 코드 입력 + 연결 실행. ScanScreen의 수동 입력도 이 컴포넌트를 쓴다. */
export const CodeEntry = ({ mode, onSubmit, busy, errorKey }: { mode: 'pair' | 'guest'; onSubmit: (code: string) => void; busy: boolean; errorKey: TKey | null }) => {
  const [code, setCode] = useState('');
  const valid = /^\d{6}$/.test(code);
  return (
    <View style={{ gap: 10 }}>
      <TextInput
        testID="code-input"
        style={styles.input}
        value={code}
        onChangeText={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))}
        keyboardType="number-pad"
        maxLength={6}
        placeholder={t('connect.codePlaceholder')}
        placeholderTextColor={colors.muted}
        accessibilityLabel={t('connect.codeLabel')}
        editable={!busy}
      />
      {errorKey ? (
        <Txt color={colors.danger} testID="code-error">
          {t(errorKey)}
        </Txt>
      ) : null}
      <Button testID="code-submit" label={t(mode === 'pair' ? 'connect.submit' : 'guest.codeSubmit')} onPress={() => onSubmit(code)} disabled={!valid || busy} />
    </View>
  );
};

export const ConnectScreen = () => {
  const router = useRouter();
  const { api, savePairing } = useSession();
  const [busy, setBusy] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [errorKey, setErrorKey] = useState<TKey | null>(null);

  const claim = async (code: string) => {
    if (!agreed) return;
    setBusy(true);
    setErrorKey(null);
    try {
      const r = await api.pairClaim(code, true);
      await savePairing(r);
      router.replace('/(tabs)');
    } catch (e) {
      setErrorKey(claimErrorKey(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title={t('connect.title')} subtitle={t('connect.subtitle')}>
      <Card>
        <Txt bold>{t('connect.consent.title')}</Txt>
        <Txt testID="connect-consent-text">{t('connect.consent.body')}</Txt>
        <ConsentBox testID="connect-consent" checked={agreed} onToggle={() => setAgreed((a) => !a)} label={t('connect.consent.check')} />
      </Card>
      <Card>
        <Txt bold>{t('connect.scanTitle')}</Txt>
        <Txt muted>{t('connect.scanBody')}</Txt>
        <Button testID="connect-scan" label={t('connect.scan')} disabled={!agreed} onPress={() => router.push('/scan?mode=pair&consent=1')} />
      </Card>
      <Card>
        <Txt bold>{t('connect.codeTitle')}</Txt>
        <Txt muted>{t('connect.codeBody')}</Txt>
        <CodeEntry mode="pair" onSubmit={claim} busy={busy || !agreed} errorKey={errorKey} />
      </Card>
      <Card>
        <Txt bold>{t('connect.guestTitle')}</Txt>
        <Txt muted>{t('connect.guestBody')}</Txt>
        <Button testID="connect-guest" label={t('connect.guest')} variant="secondary" onPress={() => router.push('/scan?mode=guest')} />
      </Card>
    </Screen>
  );
};

const styles = StyleSheet.create({
  input: { minHeight: MIN_TOUCH, borderRadius: 12, borderWidth: 1.5, borderColor: colors.line, backgroundColor: colors.panel2, color: colors.text, fontSize: 24, letterSpacing: 6, textAlign: 'center', paddingHorizontal: 12 },
});
