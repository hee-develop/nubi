import { useCallback, useState } from 'react';
import { View } from 'react-native';
import type { RoadItem } from '../../api';
import { Button, Card, ProgressBar, Screen, StateView, Txt } from '../../components/ui';
import { useApiData } from '../../hooks/useApiData';
import { fmtMeters } from '../../lib/format';
import { t } from '../../lib/i18n';
import { colors } from '../../lib/theme';
import { useSession } from '../../state/session';

const PAGE = 30;

export const RoadRow = ({ r }: { r: RoadItem }) => (
  <View style={{ gap: 4 }} testID={`road-${r.roadKey}`}>
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
      <Txt bold style={{ flexShrink: 1 }}>{r.displayName}</Txt>
      <Txt color={r.completed ? colors.accent : colors.text}>{r.completed ? t('roads.completed') : `${r.percent.toFixed(1)}%`}</Txt>
    </View>
    <ProgressBar ratio={r.percent / 100} color={r.completed ? colors.road : colors.accent} />
    <Txt muted size={13}>{t('roads.of', { driven: fmtMeters(r.drivenM), total: fmtMeters(r.totalM) })}</Txt>
  </View>
);

export const RoadsScreen = () => {
  const { api, pairing } = useSession();
  const vehicleId = pairing?.vehicleId ?? '';
  const almost = useApiData(() => api.coverageRoads(vehicleId, { filter: 'almost', limit: 10 }), [api, vehicleId]);
  const all = useApiData(() => api.coverageRoads(vehicleId, { sort: 'percent', limit: PAGE }), [api, vehicleId]);
  const [more, setMore] = useState<RoadItem[]>([]);
  const [moreBusy, setMoreBusy] = useState(false);
  const total = all.data?.total ?? 0;
  const loaded = (all.data?.items.length ?? 0) + more.length;

  const loadMore = useCallback(async () => {
    setMoreBusy(true);
    try {
      const page = await api.coverageRoads(vehicleId, { sort: 'percent', limit: PAGE, offset: loaded });
      setMore((m) => [...m, ...page.items]);
    } finally {
      setMoreBusy(false);
    }
  }, [api, vehicleId, loaded]);

  return (
    <Screen title={t('roads.title')} subtitle={t('roads.subtitle')}>
      <Card>
        <Txt bold>{t('roads.almost')}</Txt>
        <Txt muted size={13}>{t('roads.almostNote')}</Txt>
        <StateView status={almost.status} onRetry={almost.reload} empty={almost.status === 'ready' && almost.data.items.length === 0} emptyKey="roads.almostEmpty" testID="roads-almost">
          {almost.data?.items.map((r) => <RoadRow key={r.roadKey} r={r} />)}
        </StateView>
      </Card>
      <Card>
        <Txt bold>{t('roads.all')}</Txt>
        <StateView status={all.status} onRetry={all.reload} empty={all.status === 'ready' && all.data.items.length === 0} emptyKey="roads.empty" testID="roads-all">
          {[...(all.data?.items ?? []), ...more].map((r) => <RoadRow key={r.roadKey} r={r} />)}
          {loaded < total ? <Button testID="roads-more" label={t('roads.more', { n: total - loaded })} onPress={() => void loadMore()} variant="secondary" disabled={moreBusy} /> : null}
        </StateView>
      </Card>
    </Screen>
  );
};
