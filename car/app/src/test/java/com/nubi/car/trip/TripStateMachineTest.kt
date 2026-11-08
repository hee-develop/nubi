package com.nubi.car.trip

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TripStateMachineTest {
    // 위도 0.0002도 ≈ 22.2m
    private fun at(i: Int, stepDeg: Double = 0.0002, tsStep: Long = 1_000) = Sample(tsMillis = 1_000_000 + i * tsStep, lat = 37.5 + i * stepDeg, lon = 127.0)

    @Test
    fun 샘플은_5초_이상이거나_20m_이상일_때만_채택한다() {
        val m = TripStateMachine()
        m.onGear(Gear.D, 0)
        // 1초·5m 간격은 첫 샘플 외 버려진다
        val accepted = (0..3).flatMap { m.onLocation(at(it, 0.00004)) }
        assertTrue(accepted.isEmpty()) // 아직 50m 전이라 시작 전, 내부 채택은 첫 샘플뿐
        assertEquals(TripState.IDLE, m.state)
        // 시간 조건: 5초 지나면 이동이 없어도 채택(대기 중이라 pending에만 쌓임)
        m.onLocation(Sample(1_000_000 + 10_000, 37.5, 127.0))
        // 거리 조건: 1초 간격이어도 20m 이상이면 채택
        val m2 = TripStateMachine()
        m2.onGear(Gear.D, 0)
        val events = (0..3).flatMap { m2.onLocation(at(it)) }
        assertEquals(1, events.filterIsInstance<TripEvent.Started>().size)
    }

    @Test
    fun 누적_50m에_닿으면_그_전_샘플까지_포함해_시작한다() {
        val m = TripStateMachine()
        m.onGear(Gear.D, 0)
        assertTrue(m.onLocation(at(0)).isEmpty())
        assertTrue(m.onLocation(at(1)).isEmpty()) // 22m
        assertTrue(m.onLocation(at(2)).isEmpty()) // 44m
        val started = m.onLocation(at(3)).single() as TripEvent.Started // 67m
        assertEquals(listOf(0, 1, 2, 3), started.points.map { it.seq })
        assertEquals(at(0).tsMillis, started.startedAtMillis)
        assertEquals(TripState.RECORDING, m.state)
        assertEquals(4, m.sampleCount)
        assertTrue(m.distanceM > 60)
        assertEquals(Gear.D, started.points.first().sample.gear)
    }

    @Test
    fun 기록_중에는_채택한_샘플이_이어서_번호를_받는다() {
        val m = TripStateMachine()
        m.onGear(Gear.D, 0)
        (0..3).forEach { m.onLocation(at(it)) }
        val ev = m.onLocation(at(4)).single() as TripEvent.PointsAccepted
        assertEquals(4, ev.points.single().seq)
        assertEquals(5, m.sampleCount)
    }

    @Test
    fun 기어_P가_5분_이어지면_종료하고_종료시각은_마지막_샘플_시각이다() {
        val m = TripStateMachine()
        m.onGear(Gear.D, 0)
        (0..5).forEach { m.onLocation(at(it)) }
        m.onGear(Gear.P, 10_000_000)
        assertTrue(m.onTick(10_000_000 + 299_999).isEmpty())
        val ended = m.onTick(10_000_000 + 300_000).single() as TripEvent.Ended
        assertEquals(at(5).tsMillis, ended.endedAtMillis)
        assertEquals(TripState.ENDED, m.state)
        assertTrue(m.onLocation(at(6)).isEmpty())
    }

    @Test
    fun P에서_다시_D로_나가면_5분_타이머가_초기화된다() {
        val m = TripStateMachine()
        m.onGear(Gear.D, 0)
        (0..5).forEach { m.onLocation(at(it)) }
        m.onGear(Gear.P, 1_000)
        m.onGear(Gear.D, 200_000)
        m.onGear(Gear.P, 250_000)
        assertTrue(m.onTick(250_000 + 299_999).isEmpty())
        assertEquals(1, m.onTick(250_000 + 300_000).size)
    }

    @Test
    fun stop은_기록_중일_때만_종료한다() {
        val idle = TripStateMachine()
        assertTrue(idle.onStop().isEmpty())
        val m = TripStateMachine()
        m.onGear(Gear.D, 0)
        (0..5).forEach { m.onLocation(at(it)) }
        assertEquals(1, m.onStop().filterIsInstance<TripEvent.Ended>().size)
        assertTrue(m.onStop().isEmpty())
    }

    @Test
    fun 기어가_P인_동안_대기_샘플은_쌓이지_않아_트립이_생기지_않는다() {
        val m = TripStateMachine()
        m.onGear(Gear.P, 0)
        val events = (0..10).flatMap { m.onLocation(at(it)) }
        assertTrue(events.isEmpty())
        assertEquals(TripState.IDLE, m.state)
    }

    @Test
    fun 종료_뒤_D로_바뀌면_새_트립을_받을_수_있다() {
        val m = TripStateMachine()
        m.onGear(Gear.D, 0)
        (0..5).forEach { m.onLocation(at(it)) }
        m.onStop()
        m.onGear(Gear.D, 5_000)
        assertEquals(TripState.IDLE, m.state)
        val events = (10..14).flatMap { m.onLocation(at(it)) }
        val started = events.filterIsInstance<TripEvent.Started>().single()
        assertEquals(0, started.points.first().seq)
    }

    @Test
    fun 기어를_모르면_gear는_null로_기록한다() {
        val m = TripStateMachine()
        val started = (0..3).flatMap { m.onLocation(at(it)) }.single() as TripEvent.Started
        assertEquals(null, started.points.first().sample.gear)
    }

    @Test
    fun 하버사인은_위도_0_001도를_약_111m로_계산한다() {
        assertEquals(111.2, haversineM(37.5, 127.0, 37.501, 127.0), 0.5)
    }
}
