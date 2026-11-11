import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, TextInput } from 'react-native';
import { Button, Card, Screen, Txt } from '../../components/ui';
import { ConsentBox } from '../../components/ConsentBox';
import { claimErrorKey } from '../../lib/errors';
import { t, type TKey } from '../../lib/i18n';
import { colors, MIN_TOUCH } from '../../lib/theme';
import { useSession } from '../../state/session';

/** 위치정보 이용 동의 화면. 동의 체크 없이는 참여할 수 없고, 서버도 consent:true가 아니면 400을 돌려준다. */
export const GuestConsentScreen = () => {
  const { code = '' } = useLocalSearchParams<{ code?: string }>();
  const router = useRouter();
  const { api, saveGuest } = useSession();
  const [agreed, setAgreed] = useState(false);
  const [nickname, setNickname] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<TKey | null>(null);

  const join = async () => {
    if (!agreed) return;
    setBusy(true);
    setErrorKey(null);
    try {
      const nick = nickname.trim();
      const r = await api.guestClaim({ code, consent: true, ...(nick ? { nickname: nick } : {}) });
      await saveGuest({ sessionId: r.sessionId, token: r.token, ...(nick ? { nickname: nick } : {}) });
      router.replace('/guest');
    } catch (e) {
      setErrorKey(claimErrorKey(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title={t('guest.consent.title')} subtitle={t('guest.consent.subtitle')}>
      <Card>
        <Txt bold>{t('guest.consent.heading')}</Txt>
        <Txt testID="consent-text">{t('guest.consent.body')}</Txt>
        <Txt muted size={13}>{t('guest.consent.retention')}</Txt>
      </Card>
      <Card>
        <ConsentBox testID="consent-check" checked={agreed} onToggle={() => setAgreed((a) => !a)} label={t('guest.consent.check')} />
        <TextInput testID="consent-nickname" style={styles.input} value={nickname} onChangeText={setNickname} placeholder={t('guest.consent.nickname')} placeholderTextColor={colors.muted} maxLength={12} accessibilityLabel={t('guest.consent.nickname')} />
        {errorKey ? <Txt color={colors.danger} testID="consent-error">{t(errorKey)}</Txt> : null}
        <Button testID="consent-join" label={t('guest.consent.join')} onPress={() => void join()} disabled={!agreed || busy || !code} />
        <Button label={t('common.cancel')} variant="secondary" onPress={() => router.back()} />
      </Card>
    </Screen>
  );
};

const styles = StyleSheet.create({
  input: { minHeight: MIN_TOUCH, borderRadius: 12, borderWidth: 1.5, borderColor: colors.line, backgroundColor: colors.panel2, color: colors.text, fontSize: 16, paddingHorizontal: 12 },
});
