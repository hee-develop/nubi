import { fireEvent, screen } from '@testing-library/react-native';
import { Pressable } from 'react-native';
import { ApiError } from '../api';
import { useSession } from '../state/session';
import { DexScreen, groupBySido } from '../features/dex/DexScreen';
import { RoadsScreen } from '../features/roads/RoadsScreen';
import { flush, makeApi, renderApp } from '../test/utils';

const never = () => new Promise<never>(() => undefined);

describe('도감', () => {
  test('시도별 묶음 17개, 칸 229개, 전체 n/229', async () => {
    await renderApp(<DexScreen />);
    expect(screen.getByTestId('dex-count').props.children).toBe('시군구 5/229');
    expect(screen.getByTestId('dex-sido-서울').props.children.join('')).toContain('2/25');
    expect(screen.getAllByTestId(/^dex-tile-/)).toHaveLength(229);
    expect(screen.getAllByTestId(/^dex-sido-/)).toHaveLength(17);
  });
  test('인구감소지역 탭은 92칸', async () => {
    await renderApp(<DexScreen />);
    await fireEvent.press(screen.getByTestId('dex-tab-depop'));
    expect(screen.getAllByTestId(/^dex-tile-/)).toHaveLength(92);
    expect(screen.getByTestId('dex-count').props.children).toMatch(/^인구감소지역 \d+\/92$/);
  });
  test('바램 칸은 글자로도 표시(접근성 라벨·바램 텍스트)', async () => {
    await renderApp(<DexScreen />);
    const faded = screen.getByTestId('dex-tile-51800'); // 양구군: 숙박 + 바램
    expect(faded.props.accessibilityLabel).toContain('바램');
    expect(screen.getByTestId('dex-tile-51720').props.accessibilityLabel).not.toContain('바램');
  });
  test('groupBySido 순서 유지', () => {
    const g = groupBySido([{ sidoName: 'A' }, { sidoName: 'B' }, { sidoName: 'A' }] as never);
    expect(g.map((x) => [x.sido, x.regions.length])).toEqual([['A', 2], ['B', 1]]);
  });
  test('loading / error / offline / empty', async () => {
    await renderApp(<DexScreen />, { api: makeApi({ regionsList: never }) });
    expect(screen.getByTestId('dex-loading')).toBeTruthy();
    await renderApp(<DexScreen />, { api: makeApi({ regionsList: async () => { throw new ApiError('http', 503, 'regions_db_unavailable'); } }) });
    expect(screen.getByTestId('dex-error')).toBeTruthy();
    await renderApp(<DexScreen />, { api: makeApi({ regionsList: async () => { throw new ApiError('offline', 0, 'network'); } }) });
    expect(screen.getByTestId('dex-offline')).toBeTruthy();
    await renderApp(<DexScreen />, { api: makeApi({ regionsList: async () => ({ snapshotMonth: '2026-11', attribution: '', items: [] }) }) });
    expect(screen.getByTestId('dex-empty')).toBeTruthy();
  });
});

describe('도로', () => {
  test("'거의 다 달린 도로'가 상단 카드에 있고 filter=almost로 요청", async () => {
    const api = makeApi();
    const spy = jest.spyOn(api, 'coverageRoads');
    await renderApp(<RoadsScreen />, { api });
    expect(spy.mock.calls.some((c) => c[1]?.filter === 'almost')).toBe(true);
    const texts = screen.getAllByText(/거의 다 달린 도로|내가 달린 도로/).map((n) => n.props.children);
    expect(texts[0]).toBe('거의 다 달린 도로');
    expect(screen.getAllByTestId('road-mock-road-8').length).toBeGreaterThan(0); // 북악산로 82%
  });
  test('완주 도로는 완주 표기, 더 보기로 다음 페이지', async () => {
    const api = makeApi({
      coverageRoads: (async (v: string, q: { limit?: number; offset?: number; filter?: string }) => {
        const all = await makeApi().coverageRoads(v, q as never);
        return q.filter === 'almost' ? all : { ...all, limit: 5, items: all.items.slice(0, 5) };
      }) as never,
    });
    await renderApp(<RoadsScreen />, { api });
    expect(screen.getAllByText('완주').length).toBeGreaterThan(0);
    expect(screen.getByTestId('roads-more')).toBeTruthy();
  });
  test('empty / error / offline', async () => {
    const empty = async () => ({ snapshotMonth: '2026-11', attribution: '', total: 0, limit: 10, offset: 0, items: [] });
    await renderApp(<RoadsScreen />, { api: makeApi({ coverageRoads: empty as never }) });
    expect(screen.getByTestId('roads-almost-empty')).toBeTruthy();
    expect(screen.getByTestId('roads-all-empty')).toBeTruthy();
    await renderApp(<RoadsScreen />, { api: makeApi({ coverageRoads: (async () => { throw new ApiError('offline', 0, 'network'); }) as never }) });
    expect(screen.getByTestId('roads-all-offline')).toBeTruthy();
    await renderApp(<RoadsScreen />, { api: makeApi({ coverageRoads: (async () => { throw new ApiError('http', 500, 'x'); }) as never }) });
    expect(screen.getByTestId('roads-all-error')).toBeTruthy();
    await renderApp(<RoadsScreen />, { api: makeApi({ coverageRoads: never as never }) });
    expect(screen.getByTestId('roads-all-loading')).toBeTruthy();
    await flush();
  });
});

describe('도로 더 보기', () => {
  const pageApi = (failMore: { on: boolean }) =>
    makeApi({
      coverageRoads: (async (v: string, q: { limit?: number; offset?: number; filter?: string }) => {
        if (q.offset && failMore.on) throw new ApiError('offline', 0, 'timeout');
        const all = await makeApi().coverageRoads(v, { ...q, limit: 50, offset: 0 } as never);
        const offset = q.offset ?? 0;
        return q.filter === 'almost' ? all : { ...all, offset, limit: 5, items: all.items.slice(offset, offset + 5) };
      }) as never,
    });

  test('더 보기가 실패하면 오류 문구를 보이고, 다시 누르면 이어서 불러온다', async () => {
    const fail = { on: true };
    await renderApp(<RoadsScreen />, { api: pageApi(fail) });
    await fireEvent.press(screen.getByTestId('roads-more'));
    await flush();
    expect(screen.getByTestId('roads-more-error')).toBeTruthy();
    fail.on = false;
    await fireEvent.press(screen.getByTestId('roads-more'));
    await flush();
    expect(screen.queryByTestId('roads-more-error')).toBeNull();
    expect(screen.getByTestId('road-mock-road-6')).toBeTruthy(); // 둘째 페이지 항목
  });

  test('다시 조회(데이터 무효화)하면 더 불러온 항목을 비우고 첫 페이지부터', async () => {
    const fail = { on: false };
    const Harness = () => {
      const { invalidate } = useSession();
      return (
        <>
          <RoadsScreen />
          <Pressable testID="inv" onPress={invalidate} />
        </>
      );
    };
    await renderApp(<Harness />, { api: pageApi(fail) });
    await fireEvent.press(screen.getByTestId('roads-more'));
    await flush();
    expect(screen.getByTestId('road-mock-road-6')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('inv'));
    await flush();
    expect(screen.queryByTestId('road-mock-road-6')).toBeNull(); // 첫 페이지(5개)만 다시
    expect(screen.getByTestId('roads-more')).toBeTruthy();
  });
});
