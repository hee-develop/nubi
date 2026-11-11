import { useState } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import type { ShareCard, ShareKind } from '../../api';
import { Button, Card, Chip, Screen, StateView, Txt } from '../../components/ui';
import { useApiData } from '../../hooks/useApiData';
import { shareErrorKey } from '../../lib/errors';
import { fmtDateTime, fmtMeters } from '../../lib/format';
import { t, type TKey } from '../../lib/i18n';
import { colors } from '../../lib/theme';
import { useSession } from '../../state/session';
import { cardImageSource, shareCard } from './shareFile';

const KINDS: ShareKind[] = ['national', 'trip', 'road'];

export const ShareScreen = () => {
  const { api, pairing, dataVersion } = useSession();
  const vehicleId = pairing?.vehicleId ?? '';
  const [kind, setKind] = useState<ShareKind>('national');
  const [tripId, setTripId] = useState<string | null>(null);
  const [roadKey, setRoadKey] = useState<string | null>(null);
  const [card, setCard] = useState<ShareCard | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<TKey | null>(null);
  const [notice, setNotice] = useState<TKey | null>(null);

  const trips = useApiData(() => api.trips(vehicleId, 8), [api, vehicleId, dataVersion]);
  const roads = useApiData(() => api.coverageRoads(vehicleId, { sort: 'percent', limit: 8 }), [api, vehicleId, dataVersion]);

  const canCreate = kind === 'national' || (kind === 'trip' && !!tripId) || (kind === 'road' && !!roadKey);

  const create = async () => {
    setBusy(true);
    setErrorKey(null);
    setNotice(null);
    setCard(null);
    try {
      setCard(await api.shareCreate({ vehicleId, kind, ...(kind === 'trip' && tripId ? { tripIds: [tripId] } : {}), ...(kind === 'road' && roadKey ? { roadKey } : {}) }));
    } catch (e) {
      setErrorKey(shareErrorKey(e));
    } finally {
      setBusy(false);
    }
  };

  const share = async () => {
    if (!card) return;
    setBusy(true);
    setNotice(null);
    try {
      const r = await shareCard(card);
      setNotice(r === 'unavailable' ? 'share.err.unavailable' : null);
    } catch {
      setNotice('share.err.share');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title={t('share.title')} subtitle={t('share.subtitle')}>
      <View style={styles.chips}>
        {KINDS.map((k) => (
          <Chip key={k} testID={`share-kind-${k}`} label={t(`share.kind.${k}` as TKey)} on={kind === k} onPress={() => { setKind(k); setCard(null); }} />
        ))}
      </View>

      {kind === 'trip' ? (
        <Card>
          <Txt muted>{t('share.pickTrip')}</Txt>
          <StateView status={trips.status} onRetry={trips.reload} empty={trips.status === 'ready' && trips.data.trips.length === 0} emptyKey="home.noTrips" testID="share-trips">
            <View style={styles.chips}>
              {trips.data?.trips.map((tr) => (
                <Chip key={tr.tripId} testID={`share-trip-${tr.tripId}`} label={`${fmtDateTime(tr.startedAt)} · ${fmtMeters(tr.distanceM)}km`} on={tripId === tr.tripId} onPress={() => setTripId(tr.tripId)} />
              ))}
            </View>
          </StateView>
        </Card>
      ) : null}

      {kind === 'road' ? (
        <Card>
          <Txt muted>{t('share.pickRoad')}</Txt>
          <StateView status={roads.status} onRetry={roads.reload} empty={roads.status === 'ready' && roads.data.items.length === 0} emptyKey="roads.empty" testID="share-roads">
            <View style={styles.chips}>
              {roads.data?.items.map((r) => (
                <Chip key={r.roadKey} testID={`share-road-${r.roadKey}`} label={r.displayName} on={roadKey === r.roadKey} onPress={() => setRoadKey(r.roadKey)} />
              ))}
            </View>
          </StateView>
        </Card>
      ) : null}

      <Card>
        <Txt muted size={13}>{t('share.privacy')}</Txt>
        {errorKey ? <Txt color={colors.danger} testID="share-error">{t(errorKey)}</Txt> : null}
        <Button testID="share-create" label={t('share.create')} onPress={() => void create()} disabled={!canCreate || busy} />
      </Card>

      {card ? (
        <Card>
          <Txt bold>{t('share.preview')}</Txt>
          <View style={styles.preview}>
            <Image testID="share-preview" source={cardImageSource(card)} style={{ width: '100%', height: '100%' }} resizeMode="contain" accessibilityLabel={t('share.preview')} />
          </View>
          <Txt muted size={12}>© OpenStreetMap contributors</Txt>
          {notice ? <Txt color={colors.danger} testID="share-notice">{t(notice)}</Txt> : null}
          <Button testID="share-send" label={t('share.send')} onPress={() => void share()} disabled={busy} />
        </Card>
      ) : null}
    </Screen>
  );
};

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  preview: { width: '100%', aspectRatio: 1, borderRadius: 12, backgroundColor: colors.panel2, overflow: 'hidden' },
});
