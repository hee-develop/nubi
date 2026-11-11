import { Pressable, StyleSheet, View } from 'react-native';
import { colors, MIN_TOUCH } from '../lib/theme';
import { Txt } from './ui';

export const ConsentBox = ({ checked, onToggle, label, testID }: { checked: boolean; onToggle: () => void; label: string; testID: string }) => (
  <Pressable testID={testID} accessibilityRole="checkbox" accessibilityState={{ checked }} onPress={onToggle} style={styles.row}>
    <View style={[styles.box, checked && styles.boxOn]}>{checked ? <Txt color={colors.accentText} bold>✓</Txt> : null}</View>
    <Txt style={{ flex: 1 }}>{label}</Txt>
  </Pressable>
);

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: MIN_TOUCH },
  box: { width: 28, height: 28, borderRadius: 8, borderWidth: 2, borderColor: colors.muted, alignItems: 'center', justifyContent: 'center' },
  boxOn: { backgroundColor: colors.accent, borderColor: colors.accent },
});
