import { useEffect } from 'react';
import { View } from 'react-native';

type Props = { source: { uri: string }; onError?: () => void; onHttpError?: () => void; onLoadEnd?: () => void; testID?: string; originWhitelist?: string[]; onShouldStartLoadWithRequest?: (r: { url: string }) => boolean };
export const last: { props: Props | null } = { props: null };
export const WebView = (p: Props) => {
  useEffect(() => {
    last.props = p;
  });
  return <View testID={p.testID} />;
};
