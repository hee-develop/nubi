import { fireEvent, screen } from '@testing-library/react-native';
import { Pressable, Text } from 'react-native';
import { useSession } from '../state/session';
import { getOwnerToken } from '../state/token';
import { flush, renderApp } from '../test/utils';

const Probe = () => {
  const { pairing, clearPairing, savePairing } = useSession();
  return (
    <>
      <Text testID="who">{pairing?.token ?? '-'}</Text>
      <Pressable testID="clear" onPress={() => void clearPairing()} />
      <Pressable testID="save" onPress={() => void savePairing({ accountId: 'a', token: 'new-tok', vehicleId: 'v' })} />
    </>
  );
};

test('저장된 차주 토큰이 API 클라이언트용 공급자에 반영되고, 해제하면 비워진다', async () => {
  await renderApp(<Probe />);
  expect(getOwnerToken()).toBe('tok');
  await fireEvent.press(screen.getByTestId('clear'));
  await flush();
  expect(getOwnerToken()).toBeNull();
  expect(screen.getByTestId('who').props.children).toBe('-');
  await fireEvent.press(screen.getByTestId('save'));
  await flush();
  expect(getOwnerToken()).toBe('new-tok');
});
