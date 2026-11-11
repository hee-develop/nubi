import { View } from 'react-native';
import { Card, ProgressBar, Screen, StateView, Txt } from '../../components/ui';
import { useApiData } from '../../hooks/useApiData';
import { fmtDateTime, fmtDuration, fmtKm, fmtMeters, fmtPercent, kstDate, kstMonth } from '../../lib/format';
import { t } from '../../lib/i18n';
import { colors } from '../../lib/theme';
import { useSession } from '../../state/session';

export const HomeScreen = () => {
  const { api, pairing } = useSession();
  const vehicleId = pairing?.vehicleId ?? '';
  const national = useApiData(async () => {
    const [cov, reg] = await Promise.all([api.coverageSummary(vehicleId), api.regionsSummary(vehicleId)]);
    return { cov, reg };
  }, [api, vehicleId]);
  const reports = useApiData(async () => {
    const [daily, monthly] = await Promise.all([api.reportsDaily(vehicleId, kstDate()), api.reportsMonthly(vehicleId, kstMonth())]);
    return { daily, monthly };
  }, [api, vehicleId]);
  const trips = useApiData(() => api.trips(vehicleId, 5), [api, vehicleId]);

  return (
    <Screen title={t('home.title')} subtitle={t('home.subtitle')}>
      <Card>
        <Txt muted>{t('home.national')}</Txt>
        <StateView status={national.status} onRetry={national.reload} testID="home-national">
          {national.data ? (
            <View style={{ gap: 10 }}>
              <Txt size={36} bold color={colors.accent} testID="home-percent">{fmtPercent(national.data.cov.nationalPercent)}%</Txt>
              <Txt muted>{t('home.drivenOf', { driven: fmtKm(national.data.cov.drivenKm), total: fmtKm(national.data.cov.totalKm) })}</Txt>
              <View style={{ gap: 4 }}>
                <Txt testID="home-regions">{t('home.regions', { n: national.data.reg.colored, total: national.data.reg.total })}</Txt>
                <ProgressBar ratio={national.data.reg.total ? national.data.reg.colored / national.data.reg.total : 0} />
              </View>
              <View style={{ gap: 4 }}>
                <Txt testID="home-depop">{t('home.depop', { n: national.data.reg.depop.colored, total: national.data.reg.depop.total })}</Txt>
                <ProgressBar ratio={national.data.reg.depop.total ? national.data.reg.depop.colored / national.data.reg.depop.total : 0} color={colors.depop} />
              </View>
            </View>
          ) : null}
        </StateView>
      </Card>

      <StateView status={reports.status} onRetry={reports.reload} testID="home-reports">
        {reports.data ? (
          <>
            <Card>
              <Txt muted>{t('home.today')}</Txt>
              <Txt size={24} bold testID="home-today">{t('home.newKm', { km: fmtKm(reports.data.daily.newKm) })}</Txt>
              <Txt muted>
                {reports.data.daily.newRegions.length
                  ? t('home.newRegions', { names: reports.data.daily.newRegions.map((r) => r.displayName).join(', ') })
                  : t('home.noNewRegions')}
              </Txt>
            </Card>
            <Card>
              <Txt muted>{t('home.month')}</Txt>
              <Txt size={24} bold testID="home-month">{t('home.newKm', { km: fmtKm(reports.data.monthly.newKm) })}</Txt>
              <Txt muted>{t('home.monthTrips', { n: reports.data.monthly.tripCount, km: fmtKm(reports.data.monthly.distanceKm) })}</Txt>
            </Card>
          </>
        ) : null}
      </StateView>

      <Card>
        <Txt muted>{t('home.recentTrips')}</Txt>
        <StateView status={trips.status} onRetry={trips.reload} empty={trips.status === 'ready' && trips.data.trips.length === 0} emptyKey="home.noTrips" testID="home-trips">
          {trips.data?.trips.map((tr) => (
            <View key={tr.tripId} style={{ flexDirection: 'row', justifyContent: 'space-between' }} testID="home-trip-row">
              <Txt>{fmtDateTime(tr.startedAt)}</Txt>
              <Txt muted>
                {fmtMeters(tr.distanceM)} km · {fmtDuration(tr.durationS)}
              </Txt>
            </View>
          ))}
        </StateView>
      </Card>
    </Screen>
  );
};
