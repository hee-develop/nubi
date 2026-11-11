import { Modal, StyleSheet, View } from 'react-native';
import type { ReactNode } from 'react';
import { colors } from '../lib/theme';
import { Button, Txt } from './ui';

export const ConfirmModal = ({ visible, title, body, confirmLabel, cancelLabel, onConfirm, onCancel, danger, confirmDisabled, children, testID = 'confirm' }: { visible: boolean; title: string; body: string; confirmLabel: string; cancelLabel: string; onConfirm: () => void; onCancel: () => void; danger?: boolean; confirmDisabled?: boolean; children?: ReactNode; testID?: string }) => (
  <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
    <View style={styles.backdrop}>
      <View style={styles.sheet} testID={testID}>
        <Txt bold size={18}>{title}</Txt>
        <Txt muted>{body}</Txt>
        {children}
        <Button testID={`${testID}-ok`} label={confirmLabel} onPress={onConfirm} variant={danger ? 'danger' : 'primary'} disabled={confirmDisabled} />
        <Button testID={`${testID}-cancel`} label={cancelLabel} onPress={onCancel} variant="secondary" />
      </View>
    </View>
  </Modal>
);

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', padding: 24 },
  sheet: { backgroundColor: colors.panel, borderRadius: 16, borderWidth: 1, borderColor: colors.line, padding: 20, gap: 12 },
});
