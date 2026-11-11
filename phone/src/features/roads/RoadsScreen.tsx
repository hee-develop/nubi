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
  const { api, pairing, dataVersion } = useSession();
  const vehicleId = pairing?.vehicleId ?? '';
  const almost = useApiData(() => api.coverageRoads(vehicleId, { filter: 'almost', limit: 10 }), [api, vehicleId, dataVersion]);
  const all = useApiData(() => api.coverageRoads(vehicleId, { sort: 'percent', limit: PAGE }), [api, vehicleId, dataVersion]);
  // 더 불러온 항목은 첫 페이지 응답(all.data)에 묶어 둔다. 다시 조회하면 새 응답이라 자동으로 비워진다.
  const [moreState, setMoreState] = useState<{ base: unknown; items: RoadItem[] }>({ base: null, items: [] });
  const more = moreState.base === all.data ? moreState.items : [];
  const [moreBusy, setMoreBusy] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);
  const total = all.data?.total ?? 0;
  const loaded = (all.data?.items.length ?? 0) + more.length;

  const loadMore = useCallback(async () => {
    const base = all.data;
    setMoreBusy(true);
    setMoreFailed(false);
    try {
      const page = await api.coverageRoads(vehicleId, { sort: 'percent', limit: PAGE, offset: loaded });
      setMoreState((m) => ({ base, items: [...(m.base === base ? m.items : []), ...page.items] }));
    } catch {
      setMoreFailed(true);
    } finally {
      setMoreBusy(false);
    }
  }, [api, vehicleId, loaded, all.data]);

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
          {moreFailed ? <Txt color={colors.danger} testID="roads-more-error">{t('roads.moreFailed')}</Txt> : null}
          {loaded < total ? <Button testID="roads-more" label={t('roads.more', { n: total - loaded })} onPress={() => void loadMore()} variant="secondary" disabled={moreBusy} /> : null}
        </StateView>
      </Card>
    </Screen>
  );
};
