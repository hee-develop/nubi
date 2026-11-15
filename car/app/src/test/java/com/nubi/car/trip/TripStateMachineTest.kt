package com.nubi.car.trip

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 거리 함수를 "위도 차이 = 미터"로 바꿔 20.0m·5.0m·50.0m 경계를 정확히 만든다. 시간은 elapsedRealtime 인자로만 판정한다. */
class TripStateMachineTest {
    private fun machine(config: TripConfig = TripConfig()) = TripStateMachine(config, ::latDiffAsMeters)

    /** 위도 = 미터 위치. 벽시계 ts는 판정에 쓰이지 않으므로 elapsed와 무관한 값을 준다. */
    private fun at(meters: Double, ts: Long = 1_000_000) = Sample(tsMillis = ts, lat = meters, lon = 0.0)

    private val minute = 60_000L

    /** 기어 D로 0, 25, 50m 샘플을 1초 간격으로 넣어 트립을 시작시킨다(마지막 샘플 elapsed = 2_000). */
    private fun recording(m: TripStateMachine, gear: Gear? = Gear.D): List<TripEvent> {
        m.onGear(gear, 0)
        return listOf(0.0 to 0L, 25.0 to 1_000L, 50.0 to 2_000L).flatMap { (meters, e) -> m.onLocation(at(meters, 5_000 + e), e) }
    }

    // 채택 --------------------------------------------------------------

    @Test
    fun 직전_채택점에서_20m_이상이면_시간과_상관없이_채택한다() {
        val reject = machine().apply { onGear(Gear.D, 0); onLocation(at(0.0), 0); onLocation(at(19.9), 1) }
        assertEquals(1, reject.pendingSampleCount)
        val accept = machine().apply { onGear(Gear.D, 0); onLocation(at(0.0), 0); onLocation(at(20.0), 1) }
        assertEquals(2, accept.pendingSampleCount)
    }

    @Test
    fun 시간_조건은_정확히_5000ms_이고_5_0m_이상_움직였을_때만_채택한다() {
        fun count(meters: Double, elapsed: Long) = machine().apply {
            onGear(Gear.D, 0)
            onLocation(at(0.0), 0)
            onLocation(at(meters), elapsed)
        }.pendingSampleCount

        assertEquals(1, count(5.0, 4_999))
        assertEquals(2, count(5.0, 5_000))
        assertEquals(1, count(4.9, 5_000))
        assertEquals(1, count(0.0, 10 * minute)) // 정지 중 흔들림: 시간이 아무리 지나도 5m 미만이면 안 쌓인다
        assertEquals(2, count(19.9, 5_000))
    }

    @Test
    fun 채택_판정은_벽시계가_아니라_elapsedRealtime만_본다() {
        val m = machine()
        m.onGear(Gear.D, 0)
        m.onLocation(at(0.0, ts = 10_000_000), 0)
        // 벽시계가 1시간 뒤로 가도 elapsed가 4,999ms면 채택하지 않는다
        m.onLocation(at(5.0, ts = 10_000_000 + 3_600_000), 4_999)
        assertEquals(1, m.pendingSampleCount)
        // 벽시계가 뒤로 가도(NTP 보정) elapsed가 5,000ms면 채택한다
        m.onLocation(at(5.0, ts = 9_000_000), 5_000)
        assertEquals(2, m.pendingSampleCount)
    }

    // 시작 --------------------------------------------------------------

    @Test
    fun 첫_대기_샘플에서_직선_변위가_정확히_50_0m_일_때_시작한다() {
        val almost = machine().apply { onGear(Gear.D, 0) }
        assertTrue(almost.onLocation(at(0.0), 0).isEmpty())
        assertTrue(almost.onLocation(at(25.0), 1_000).isEmpty())
        assertTrue(almost.onLocation(at(49.9), 2_000).isEmpty())
        assertEquals(TripState.IDLE, almost.state)

        val m = machine()
        val started = recording(m).single() as TripEvent.Started
        assertEquals(listOf(0, 1, 2), started.points.map { it.seq })
        assertEquals(5_000L, started.startedAtMillis)
        assertEquals(TripState.RECORDING, m.state)
        assertEquals(3, m.sampleCount)
        assertEquals(50.0, m.distanceM, 1e-9)
        assertEquals(Gear.D, started.points.first().sample.gear)
    }

    @Test
    fun 시작은_직선_변위이고_경로_합이_아니다() {
        val m = machine()
        m.onGear(Gear.D, 0)
        // 0 → 30 → 0 → 30: 경로 합은 90m지만 첫 샘플과의 직선 변위는 30m
        listOf(0.0, 30.0, 0.0, 30.0).forEachIndexed { i, meters -> assertTrue(m.onLocation(at(meters), i * 1_000L).isEmpty()) }
        assertEquals(TripState.IDLE, m.state)
        assertEquals(4, m.pendingSampleCount)
        // 첫 샘플(0m)에서 50m 떨어진 곳에 닿으면 시작한다(그때까지의 대기 샘플 포함)
        val started = m.onLocation(at(50.0), 4_000).single() as TripEvent.Started
        assertEquals(5, started.points.size)
    }

    @Test
    fun 기어_P인_동안은_샘플을_버리고_시작하지_않는다() {
        val m = machine()
        m.onGear(Gear.P, 0)
        val events = listOf(0.0, 25.0, 50.0, 75.0).flatMapIndexed { i, meters -> m.onLocation(at(meters), i * 1_000L) }
        assertTrue(events.isEmpty())
        assertEquals(0, m.pendingSampleCount)
        assertEquals(TripState.IDLE, m.state)
    }

    @Test
    fun IDLE에서_P로_바뀌면_대기_샘플을_폐기한다() {
        val m = machine()
        m.onGear(Gear.D, 0)
        m.onLocation(at(0.0), 0)
        m.onLocation(at(25.0), 1_000)
        assertEquals(2, m.pendingSampleCount)
        m.onGear(Gear.P, 2_000)
        assertEquals(0, m.pendingSampleCount)
        m.onGear(Gear.D, 3_000)
        // 폐기됐으므로 P 이전 샘플과 이어 붙지 않고 새로 50m가 필요하다
        assertTrue(m.onLocation(at(50.0), 4_000).isEmpty())
        assertEquals(1, m.pendingSampleCount)
    }

    @Test
    fun 기어를_모르면_변위만으로_시작하고_gear는_null로_기록한다() {
        val started = recording(machine(), gear = null).single() as TripEvent.Started
        assertNull(started.points.first().sample.gear)
    }

    @Test
    fun 대기_샘플은_상한을_넘으면_오래된_것부터_버린다() {
        val m = machine(TripConfig(maxPendingSamples = 3))
        m.onGear(Gear.D, 0)
        // 0, 25, 0, 25...를 계속 채택해도(변위 25m) 시작하지 않고 3개까지만 쌓인다
        repeat(20) { i -> assertTrue(m.onLocation(at(if (i % 2 == 0) 0.0 else 25.0), i * 1_000L).isEmpty()) }
        assertEquals(3, m.pendingSampleCount)
        assertEquals(TripState.IDLE, m.state)
    }

    // 기록·종료 ----------------------------------------------------------

    @Test
    fun 기록_중에는_채택한_샘플이_이어서_번호를_받고_거리가_누적된다() {
        val m = machine()
        recording(m)
        val ev = m.onLocation(at(75.0), 3_000).single() as TripEvent.PointsAccepted
        assertEquals(3, ev.points.single().seq)
        assertEquals(4, m.sampleCount)
        assertEquals(75.0, m.distanceM, 1e-9)
    }

    @Test
    fun P_진입_후_5분_유지하면_종료하고_P_이후_샘플은_넣지_않으며_종료시각은_P_직전_마지막_채택_샘플이다() {
        val m = machine()
        recording(m) // 마지막 채택 샘플 ts = 7_000
        m.onGear(Gear.P, 10_000)
        // P 진입 뒤 도착한 샘플은 트립에 넣지 않는다
        assertTrue(m.onLocation(at(80.0, ts = 11_000), 11_000).isEmpty())
        assertTrue(m.onLocation(at(120.0, ts = 12_000), 12_000).isEmpty())
        assertEquals(3, m.sampleCount)
        assertTrue(m.onTick(10_000 + 5 * minute - 1).isEmpty())
        val ended = m.onTick(10_000 + 5 * minute).single() as TripEvent.Ended
        assertEquals(7_000L, ended.endedAtMillis)
        assertEquals(TripState.ENDED, m.state)
    }

    @Test
    fun P에서_5분_안에_다시_나가면_타이머가_초기화된다() {
        val m = machine()
        recording(m)
        m.onGear(Gear.P, 10_000)
        m.onGear(Gear.D, 200_000)
        m.onGear(Gear.P, 250_000)
        assertTrue(m.onTick(250_000 + 5 * minute - 1).isEmpty())
        assertEquals(1, m.onTick(250_000 + 5 * minute).size)
    }

    @Test
    fun P가_반복_통지돼도_진입_시각은_처음_것이다() {
        val m = machine()
        recording(m)
        m.onGear(Gear.P, 10_000)
        m.onGear(Gear.P, 200_000)
        assertEquals(1, m.onTick(10_000 + 5 * minute).size)
    }

    @Test
    fun 기어를_모르는_차량은_채택점_변위_20m_미만이_5분_지속되면_종료한다() {
        val m = machine()
        recording(m, gear = null) // 기준점 = 50m 샘플(elapsed 2_000)
        // 5m씩 천천히 움직여도(채택은 되지만 기준점에서 20m 미만) 정지로 본다
        m.onLocation(at(55.0), 7_000)
        m.onLocation(at(60.0), 12_000)
        assertTrue(m.onTick(2_000 + 5 * minute - 1).isEmpty())
        val ended = m.onTick(2_000 + 5 * minute).single() as TripEvent.Ended
        // 종료 시각은 마지막 채택 샘플(60m, at()의 기본 ts)이다
        assertEquals(1_000_000L, ended.endedAtMillis)
    }

    @Test
    fun 기어를_모르는_차량도_기준점에서_20m_이상_움직이면_정지_타이머가_초기화된다() {
        val m = machine()
        recording(m, gear = null)
        m.onLocation(at(70.0), 4 * minute) // 기준점(50m)에서 20.0m
        assertTrue(m.onTick(2_000 + 5 * minute).isEmpty())
        assertTrue(m.onTick(4 * minute + 5 * minute - 1).isEmpty())
        assertEquals(1, m.onTick(4 * minute + 5 * minute).size)
    }

    @Test
    fun 기어를_아는_차량은_정차해도_P가_아니면_종료하지_않는다() {
        val m = machine()
        recording(m, gear = Gear.D)
        assertTrue(m.onTick(2_000 + 60 * minute).isEmpty())
        assertEquals(TripState.RECORDING, m.state)
    }

    @Test
    fun stop은_기록_중일_때만_마지막_채택_샘플_시각으로_종료한다() {
        assertTrue(machine().onStop().isEmpty())
        val m = machine()
        recording(m)
        val ended = m.onStop().single() as TripEvent.Ended
        assertEquals(7_000L, ended.endedAtMillis)
        assertTrue(m.onStop().isEmpty())
    }

    // 재개 --------------------------------------------------------------

    @Test
    fun 종료_뒤_기어가_D_R_N으로_바뀌면_즉시_새_트립을_받는다() {
        for (g in listOf(Gear.D, Gear.R, Gear.N)) {
            val m = machine()
            recording(m)
            m.onGear(Gear.P, 10_000)
            m.onTick(10_000 + 5 * minute)
            assertEquals(TripState.ENDED, m.state)
            m.onGear(g, 400_000)
            assertEquals(TripState.IDLE, m.state)
            m.onLocation(at(0.0), 401_000)
            val started = m.onLocation(at(50.0), 402_000).single() as TripEvent.Started
            assertEquals(0, started.points.first().seq)
        }
    }

    @Test
    fun 종료_뒤_기어가_P인_채로는_새_트립이_시작되지_않는다() {
        val m = machine()
        recording(m)
        m.onGear(Gear.P, 10_000)
        m.onTick(10_000 + 5 * minute)
        assertTrue(m.onLocation(at(500.0), 400_000).isEmpty())
        assertTrue(m.onLocation(at(900.0), 401_000).isEmpty())
        assertEquals(TripState.ENDED, m.state)
    }

    @Test
    fun 기어를_모르는_차량은_종료_뒤_새_변위_50m로_즉시_새_트립이_시작된다() {
        val m = machine()
        recording(m, gear = null)
        assertEquals(1, m.onTick(2_000 + 5 * minute).size)
        assertEquals(TripState.ENDED, m.state)
        val base = 2_000 + 6 * minute
        assertTrue(m.onLocation(at(50.0), base).isEmpty()) // 새 기준점
        assertTrue(m.onLocation(at(75.0), base + 1_000).isEmpty())
        val started = m.onLocation(at(100.0), base + 2_000).single() as TripEvent.Started
        assertEquals(listOf(0, 1, 2), started.points.map { it.seq })
        assertEquals(TripState.RECORDING, m.state)
    }

    @Test
    fun 하버사인은_위도_0_001도를_약_111m로_계산한다() {
        assertEquals(111.2, haversineM(37.5, 127.0, 37.501, 127.0), 0.5)
    }

    // 마지막 원시 위치 -------------------------------------------------------

    @Test
    fun 기어_P에서도_마지막_위치를_보관하지만_트립에는_넣지_않는다() {
        val m = machine()
        m.onGear(Gear.P, 0)
        assertNull(m.lastRaw)
        assertTrue(m.onLocation(at(10.0), 1_000).isEmpty())
        assertEquals(10.0, m.lastRaw!!.lat, 0.0)
        assertTrue(m.onLocation(at(500.0), 2_000).isEmpty())
        assertEquals(500.0, m.lastRaw!!.lat, 0.0)
        assertEquals(0, m.sampleCount)
        assertEquals(TripState.IDLE, m.state)
    }

    @Test
    fun 채택하지_않은_위치와_트립_종료_뒤에도_마지막_위치가_남고_reset에서만_지워진다() {
        val m = machine()
        recording(m)
        m.onLocation(at(51.0), 3_000) // 5m 미만 이동이라 채택되지 않는다
        assertEquals(51.0, m.lastRaw!!.lat, 0.0)
        m.onGear(Gear.P, 3_500)
        m.onTick(3_500 + 5 * minute)
        assertEquals(TripState.ENDED, m.state)
        assertEquals(51.0, m.lastRaw!!.lat, 0.0)
        m.reset()
        assertNull(m.lastRaw)
    }
}
