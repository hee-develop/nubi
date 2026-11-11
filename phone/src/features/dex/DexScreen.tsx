import { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { RegionItem } from '../../api';
import { Card, Chip, LevelTag, levelColor, ProgressBar, Screen, StateView, Txt } from '../../components/ui';
import { useApiData } from '../../hooks/useApiData';
import { t } from '../../lib/i18n';
import { colors } from '../../lib/theme';
import { useSession } from '../../state/session';

export const groupBySido = (items: RegionItem[]) => {
  const m = new Map<string, RegionItem[]>();
  for (const r of items) m.set(r.sidoName, [...(m.get(r.sidoName) ?? []), r]);
  return [...m.entries()].map(([sido, regions]) => ({ sido, regions }));
};

const Tile = ({ r }: { r: RegionItem }) => {
  const faded = !!r.faded && r.level > 0;
  return (
    <View
      testID={`dex-tile-${r.code}`}
      accessible
      accessibilityLabel={`${r.displayName} ${t(`level.${r.level}` as never)}${faded ? ` ${t('level.faded')}` : ''}${r.depop92 ? ` ${t('dex.depopTag')}` : ''}`}
      style={[styles.tile, { backgroundColor: levelColor(r.level, faded) }, r.level === 0 && r.depop92 && { backgroundColor: colors.noneDepop }, faded && styles.tileFaded]}
    >
      <Text style={[styles.tileName, r.level >= 3 && { color: colors.accentText }]} numberOfLines={2}>
        {r.name}
      </Text>
      <Text style={[styles.tileLv, r.level >= 3 && { color: colors.accentText }]}>
        {'●'.repeat(r.level) + '○'.repeat(3 - r.level)}
        {faded ? ' ' + t('level.faded') : ''}
      </Text>
    </View>
  );
};

export const DexScreen = () => {
  const { api, pairing, dataVersion } = useSession();
  const vehicleId = pairing?.vehicleId ?? '';
  const [tab, setTab] = useState<'all' | 'depop'>('all');
  const list = useApiData(() => api.regionsList(vehicleId), [api, vehicleId, dataVersion]);
  const data = list.data;
  const shown = useMemo(() => {
    const items = data?.items ?? [];
    return tab === 'depop' ? items.filter((r) => r.depop92) : items;
  }, [data, tab]);
  const groups = useMemo(() => groupBySido(shown), [shown]);
  const colored = shown.filter((r) => r.level >= 1).length;

  return (
    <Screen title={t('dex.title')} subtitle={t('dex.subtitle')}>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Chip testID="dex-tab-all" label={t('dex.tabAll')} on={tab === 'all'} onPress={() => setTab('all')} />
        <Chip testID="dex-tab-depop" label={t('dex.tabDepop')} on={tab === 'depop'} onPress={() => setTab('depop')} />
      </View>
      <StateView status={list.status} onRetry={list.reload} empty={list.status === 'ready' && shown.length === 0} emptyKey="dex.empty" testID="dex">
        <Card>
          <Txt bold testID="dex-count">
            {t(tab === 'all' ? 'dex.countAll' : 'dex.countDepop', { n: colored, total: shown.length })}
          </Txt>
          <ProgressBar ratio={shown.length ? colored / shown.length : 0} color={tab === 'depop' ? colors.depop : colors.accent} />
          <View style={styles.legend}>
            {[0, 1, 2, 3].map((l) => (
              <LevelTag key={l} level={l} />
            ))}
          </View>
          <Txt muted size={13}>{t('dex.fadedNote')}</Txt>
        </Card>
        {groups.map((g) => (
          <View key={g.sido} style={{ gap: 6 }}>
            <Txt bold testID={`dex-sido-${g.sido}`}>
              {g.sido} {g.regions.filter((r) => r.level >= 1).length}/{g.regions.length}
            </Txt>
            <View style={styles.grid}>
              {g.regions.map((r) => (
                <Tile key={r.code} r={r} />
              ))}
            </View>
          </View>
        ))}
      </StateView>
    </Screen>
  );
};

const styles = StyleSheet.create({
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  tile: { width: '23.5%', minHeight: 56, borderRadius: 10, padding: 6, borderWidth: 1, borderColor: colors.line, justifyContent: 'space-between' },
  tileFaded: { borderStyle: 'dashed', borderColor: colors.lv3Faded },
  tileName: { color: colors.text, fontSize: 12, fontWeight: '700' },
  tileLv: { color: colors.muted, fontSize: 10 },
});
