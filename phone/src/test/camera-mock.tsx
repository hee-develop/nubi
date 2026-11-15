import { useEffect } from 'react';
import { View } from 'react-native';

type Perm = { granted: boolean; canAskAgain: boolean } | null;
const state: { perm: Perm; onScan?: (e: { data: string }) => void } = { perm: { granted: true, canAskAgain: true } };
export const requestPermission = jest.fn();
export const setPermission = (p: Perm) => {
  state.perm = p;
};
export const scan = (data: string) => state.onScan?.({ data });

export const useCameraPermissions = () => [state.perm, requestPermission] as const;
export const CameraView = (p: { onBarcodeScanned?: (e: { data: string }) => void }) => {
  const cb = p.onBarcodeScanned;
  useEffect(() => {
    state.onScan = cb;
  });
  return <View testID="camera" />;
};
