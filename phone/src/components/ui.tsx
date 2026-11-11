import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { t, type TKey } from '../lib/i18n';
import { colors, MIN_TOUCH } from '../lib/theme';

export const Screen = ({ title, subtitle, children, scroll = true, right }: { title?: string; subtitle?: string; children: ReactNode; scroll?: boolean; right?: ReactNode }) => (
  <SafeAreaView style={styles.screen} edges={['top', 'left', 'right']}>
    {title ? (
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title} accessibilityRole="header">
            {title}
          </Text>
          {subtitle ? <Text style={styles.muted}>{subtitle}</Text> : null}
        </View>
        {right}
      </View>
    ) : null}
    {scroll ? <ScrollView contentContainerStyle={styles.body}>{children}</ScrollView> : <View style={[styles.body, { flex: 1 }]}>{children}</View>}
  </SafeAreaView>
);

export const Card = ({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) => <View style={[styles.card, style]}>{children}</View>;

export const Txt = ({ children, muted, bold, size, color, style, ...rest }: { children: ReactNode; muted?: boolean; bold?: boolean; size?: number; color?: string; style?: object; testID?: string; numberOfLines?: number }) => (
  <Text style={[styles.text, muted && { color: colors.muted }, bold && { fontWeight: '800' }, size ? { fontSize: size } : null, color ? { color } : null, style]} {...rest}>
    {children}
  </Text>
);

export const Button = ({ label, onPress, variant = 'primary', disabled, testID }: { label: string; onPress: () => void; variant?: 'primary' | 'secondary' | 'danger'; disabled?: boolean; testID?: string }) => (
  <Pressable
    accessibilityRole="button"
    accessibilityLabel={label}
    accessibilityState={{ disabled: !!disabled }}
    testID={testID}
    disabled={disabled}
    onPress={onPress}
    style={({ pressed }) => [styles.btn, variant === 'primary' && styles.btnPrimary, variant === 'secondary' && styles.btnSecondary, variant === 'danger' && styles.btnDanger, (disabled || pressed) && { opacity: 0.6 }]}
  >
    <Text style={[styles.btnText, variant === 'primary' && { color: colors.accentText }, variant === 'danger' && { color: colors.danger }]}>{label}</Text>
  </Pressable>
);

export const Chip = ({ label, on, onPress, testID }: { label: string; on: boolean; onPress: () => void; testID?: string }) => (
  <Pressable accessibilityRole="button" accessibilityState={{ selected: on }} testID={testID} onPress={onPress} style={[styles.chip, on && styles.chipOn]}>
    <Text style={[styles.chipText, on && { color: colors.accentText }]}>{label}</Text>
  </Pressable>
);

export const ProgressBar = ({ ratio, color = colors.accent }: { ratio: number; color?: string }) => (
  <View style={styles.bar} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: Math.round(Math.max(0, Math.min(1, ratio)) * 100) }}>
    <View style={{ width: `${Math.max(0, Math.min(1, ratio)) * 100}%`, height: '100%', backgroundColor: color, borderRadius: 4 }} />
  </View>
);

/** 상태 5종 중 loading/error/offline/empty를 한 곳에서 그린다(권한 거부는 카메라 화면). */
export const StateView = ({ status, onRetry, emptyKey, empty, children, testID }: { status: 'loading' | 'error' | 'offline' | 'ready'; onRetry?: () => void; emptyKey?: TKey; empty?: boolean; children?: ReactNode; testID?: string }) => {
  if (status === 'loading')
    return (
      <View style={styles.state} testID={testID ? `${testID}-loading` : 'state-loading'}>
        <ActivityIndicator color={colors.accent} />
        <Txt muted>{t('state.loading')}</Txt>
      </View>
    );
  if (status === 'offline' || status === 'error')
    return (
      <View style={styles.state} testID={testID ? `${testID}-${status}` : `state-${status}`}>
        <Txt bold>{t(status === 'offline' ? 'state.offline.title' : 'state.error.title')}</Txt>
        <Txt muted style={{ textAlign: 'center' }}>
          {t(status === 'offline' ? 'state.offline.body' : 'state.error.body')}
        </Txt>
        {onRetry ? <Button label={t('state.retry')} onPress={onRetry} variant="secondary" testID="state-retry" /> : null}
      </View>
    );
  if (empty)
    return (
      <View style={styles.state} testID={testID ? `${testID}-empty` : 'state-empty'}>
        <Txt muted style={{ textAlign: 'center' }}>
          {t(emptyKey ?? 'state.empty')}
        </Txt>
      </View>
    );
  return <>{children}</>;
};

export const LevelTag = ({ level, faded }: { level: number; faded?: boolean }) => {
  const dots = '●'.repeat(level) + '○'.repeat(3 - level);
  return (
    <Text style={[styles.level, level === 0 && { color: colors.muted }]}>
      {t(`level.${level}` as TKey)} {dots}
      {faded ? ` · ${t('level.faded')}` : ''}
    </Text>
  );
};

export const levelColor = (level: number, faded?: boolean) => (level === 0 ? colors.none : faded ? colors.lv3Faded : level === 1 ? colors.lv1 : level === 2 ? colors.lv2 : colors.lv3);

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 },
  title: { color: colors.text, fontSize: 24, fontWeight: '800' },
  muted: { color: colors.muted, fontSize: 14 },
  body: { padding: 16, gap: 12 },
  card: { backgroundColor: colors.panel, borderRadius: 16, borderWidth: 1, borderColor: colors.line, padding: 16, gap: 8 },
  text: { color: colors.text, fontSize: 16, lineHeight: 22 },
  btn: { minHeight: MIN_TOUCH, borderRadius: 24, paddingHorizontal: 20, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: colors.line },
  btnPrimary: { backgroundColor: colors.accent, borderColor: colors.accent },
  btnSecondary: { backgroundColor: colors.panel2 },
  btnDanger: { borderColor: colors.danger, backgroundColor: 'transparent' },
  btnText: { color: colors.text, fontSize: 16, fontWeight: '800' },
  chip: { minHeight: MIN_TOUCH, minWidth: MIN_TOUCH, paddingHorizontal: 14, borderRadius: 20, borderWidth: 1.5, borderColor: colors.line, backgroundColor: colors.panel, alignItems: 'center', justifyContent: 'center' },
  chipOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipText: { color: colors.muted, fontSize: 15, fontWeight: '700' },
  bar: { height: 8, borderRadius: 4, backgroundColor: colors.line, overflow: 'hidden' },
  state: { alignItems: 'center', gap: 10, padding: 24 },
  level: { color: colors.text, fontSize: 14, fontWeight: '700' },
});
