package com.nubi.car

import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FeatureFlagsTest {
    @After
    fun restore() {
        FeatureFlags.applyServerDrivingMap(true)
        FeatureFlags.applyVoicePref(true)
    }

    @Test
    fun 서버_설정은_주행_중_지도를_끌_수_있고_다시_켤_수_있다() {
        FeatureFlags.applyServerDrivingMap(false)
        assertFalse(FeatureFlags.drivingMap)
        FeatureFlags.applyServerDrivingMap(true)
        assertTrue(FeatureFlags.drivingMap)
    }

    @Test
    fun 음성은_사용자_설정으로_끌_수_있다() {
        FeatureFlags.applyVoicePref(false)
        assertFalse(FeatureFlags.voice)
        FeatureFlags.applyVoicePref(true)
        assertTrue(FeatureFlags.voice)
    }

    @Test
    fun 기본값은_모두_켜져_있다() {
        assertTrue(FeatureFlags.parkedMenu && FeatureFlags.guest && FeatureFlags.share && FeatureFlags.intro && FeatureFlags.liveColoring)
    }
}
