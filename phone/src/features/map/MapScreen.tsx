import { useState, type ComponentType } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView as RawWebView, type WebViewProps } from 'react-native-webview';
import { Screen, StateView, Txt } from '../../components/ui';
import { t } from '../../lib/i18n';
import { colors } from '../../lib/theme';
import { useSession } from '../../state/session';

// react-native-webview의 클래스 컴포넌트 타입이 React 19 타입과 맞지 않아 함수 컴포넌트 타입으로 좁혀 쓴다.
const WebView = RawWebView as unknown as ComponentType<WebViewProps>;

/** 지도는 서버 `/viewer`를 WebView로 띄운다(지도 라이브러리 신규 도입 없음). 목 모드는 서버가 없어 안내만 보인다. */
export const MapScreen = () => {
  const { api, pairing } = useSession();
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [key, setKey] = useState(0);

  if (!pairing) return <Screen title={t('map.title')}><StateView status="ready" empty emptyKey="map.noVehicle" /></Screen>;
  if (api.mode === 'mock' || !api.baseUrl)
    return (
      <Screen title={t('map.title')}>
        <StateView status="ready" empty emptyKey="map.mockNotice" testID="map-mock" />
      </Screen>
    );

  const retry = () => {
    setStatus('loading');
    setKey((k) => k + 1);
  };

  return (
    <Screen title={t('map.title')} subtitle={t('map.subtitle')} scroll={false}>
      <View style={styles.box}>
        <WebView
          key={key}
          testID="map-webview"
          source={{ uri: api.viewerUrl(pairing.vehicleId) }}
          style={{ flex: 1, backgroundColor: colors.bg }}
          onLoadEnd={() => setStatus((s) => (s === 'error' ? s : 'ready'))}
          onError={() => setStatus('error')}
          onHttpError={() => setStatus('error')}
          startInLoadingState={false}
          setSupportMultipleWindows={false}
        />
        {status !== 'ready' ? (
          <View style={styles.overlay} pointerEvents="box-none">
            {status === 'loading' ? <StateView status="loading" testID="map" /> : <StateView status="offline" onRetry={retry} testID="map" />}
          </View>
        ) : null}
      </View>
      <Txt muted size={12}>© OpenStreetMap contributors</Txt>
    </Screen>
  );
};

const styles = StyleSheet.create({
  box: { flex: 1, borderRadius: 16, overflow: 'hidden', borderWidth: 1, borderColor: colors.line },
  overlay: { ...StyleSheet.absoluteFill, backgroundColor: colors.bg, justifyContent: 'center' },
});
