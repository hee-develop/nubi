package com.nubi.car.map

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MapMathTest {
    private val eps = 1e-6

    @Test
    fun 경도_위도와_정규화_좌표는_서로_되돌아온다() {
        for ((lon, lat) in listOf(126.978 to 37.5665, 124.5 to 33.0, 131.87 to 37.24, 0.0 to 0.0, -73.9 to 40.7)) {
            assertEquals(lon, lonOfX(mercX(lon)), 1e-9)
            assertEquals(lat, latOfY(mercY(lat)), 1e-9)
        }
        assertEquals(0.5, mercX(0.0), eps)
        assertEquals(0.5, mercY(0.0), eps)
        assertTrue(mercY(38.0) < mercY(33.0)) // 북쪽이 y가 작다
    }

    @Test
    fun 화면_중심은_화면_가운데로_투영된다() {
        val vp = Viewport(126.978, 37.5665, 14.0, 2000, 1000)
        assertEquals(1000.0, vp.screenX(126.978), 1e-6)
        assertEquals(500.0, vp.screenY(37.5665), 1e-6)
        assertEquals(126.978, vp.lonAt(1000.0), 1e-9)
        assertEquals(37.5665, vp.latAt(500.0), 1e-9)
    }

    @Test
    fun z14에서_경도_1도는_약_45511픽셀이고_북쪽이_위다() {
        val vp = Viewport(127.0, 37.5, 14.0, 800, 600)
        // 256 * 2^14 / 360 = 11650.8 px/도
        assertEquals(256.0 * 16384 / 360, vp.screenX(128.0) - vp.screenX(127.0), 1e-6)
        assertTrue(vp.screenY(37.6) < vp.screenY(37.5))
        assertTrue(vp.screenX(127.01) > vp.screenX(127.0))
    }

    @Test
    fun 화면_좌표와_정규화_좌표_투영이_같다() {
        val vp = Viewport(127.0, 37.5, 13.3, 1280, 720)
        assertEquals(vp.screenX(127.2), vp.sx(mercX(127.2)), 1e-6)
        assertEquals(vp.screenY(37.4), vp.sy(mercY(37.4)), 1e-6)
        val b = vp.mercBounds()
        assertEquals(0.0, vp.sx(b[0]), 1e-6)
        assertEquals(1280.0, vp.sx(b[2]), 1e-6)
        assertEquals(0.0, vp.sy(b[1]), 1e-6)
        assertEquals(720.0, vp.sy(b[3]), 1e-6)
    }

    @Test
    fun bbox는_화면_네_모서리다() {
        val vp = Viewport(127.0, 37.5, 12.0, 1000, 800)
        val b = vp.bbox()
        assertEquals(vp.lonAt(0.0), b.minLon, 1e-12)
        assertEquals(vp.lonAt(1000.0), b.maxLon, 1e-12)
        assertTrue(b.minLat < 37.5 && b.maxLat > 37.5)
        assertTrue(b.minLon < 127.0 && b.maxLon > 127.0)
    }

    @Test
    fun 끌기는_지도를_손가락_방향으로_옮긴다() {
        val vp = Viewport(127.0, 37.5, 14.0, 1000, 800)
        val moved = vp.panBy(100.0, 50.0)
        // 지도가 오른쪽·아래로 끌려갔으니 화면 가운데에 오는 지점은 원래 가운데보다 서쪽·북쪽
        assertTrue(moved.centerLon < vp.centerLon)
        assertTrue(moved.centerLat > vp.centerLat)
        // 원래 중심 지점은 (600, 450)에 있다
        assertEquals(600.0, moved.screenX(127.0), 1e-6)
        assertEquals(450.0, moved.screenY(37.5), 1e-6)
    }

    @Test
    fun 핀치_확대는_손가락_아래_지점을_고정한다() {
        val vp = Viewport(127.0, 37.5, 12.0, 1000, 800)
        val fx = 700.0
        val fy = 200.0
        val lon = vp.lonAt(fx)
        val lat = vp.latAt(fy)
        val zoomed = vp.zoomBy(1.5, fx, fy)
        assertEquals(13.5, zoomed.zoom, 1e-12)
        assertEquals(fx, zoomed.screenX(lon), 1e-6)
        assertEquals(fy, zoomed.screenY(lat), 1e-6)
    }

    @Test
    fun 확대는_5에서_17점5로_제한된다() {
        val vp = Viewport(127.0, 37.5, 6.0, 100, 100)
        assertEquals(5.0, vp.zoomBy(-10.0).zoom, 0.0)
        assertEquals(17.5, vp.zoomBy(30.0).zoom, 0.0)
        assertEquals(5.0, vp.withZoom(1.0).zoom, 0.0)
    }

    @Test
    fun 전국_보기는_전국_경계가_여백을_두고_화면에_다_들어온다() {
        val vp = Viewport.fit(NATIONAL_BBOX, 1500, 1100, 24)
        val b = vp.bbox()
        assertTrue(b.minLon <= NATIONAL_BBOX.minLon && b.maxLon >= NATIONAL_BBOX.maxLon)
        assertTrue(b.minLat <= NATIONAL_BBOX.minLat && b.maxLat >= NATIONAL_BBOX.maxLat)
        // 가로·세로 중 하나는 거의 꽉 찬다(여백 24px)
        val x0 = vp.screenX(NATIONAL_BBOX.minLon)
        val y1 = vp.screenY(NATIONAL_BBOX.minLat)
        val y0 = vp.screenY(NATIONAL_BBOX.maxLat)
        val x1 = vp.screenX(NATIONAL_BBOX.maxLon)
        assertTrue(x0 >= 23.9 && x1 <= 1500 - 23.9 && y0 >= 23.9 && y1 <= 1100 - 23.9)
        assertTrue(x0 < 24.1 || y0 < 24.1)
        assertTrue(vp.zoom in 7.0..9.0)
    }

    @Test
    fun 서버_z는_내림해_5에서_16으로_맞춘다() {
        assertEquals(14, serverZ(14.0))
        assertEquals(14, serverZ(14.99))
        assertEquals(5, serverZ(5.2))
        assertEquals(16, serverZ(17.4))
        assertEquals(6, serverZ(6.0 + 1e-9))
    }

    @Test
    fun 칸_크기는_서버_bbox_상한_이하다() {
        // 서버 상한: z<9 3°, z<11 2°, z<13 0.5°, 그 위 0.15°
        for (z in 5..16) {
            val limit = if (z < 9) 3.0 else if (z < 11) 2.0 else if (z < 13) 0.5 else 0.15
            assertTrue("z$z", cellSizeDeg(z) <= limit + 1e-9)
        }
    }

    @Test
    fun 칸은_화면을_빈틈없이_덮고_칸_경계는_격자에_맞는다() {
        val box = Bbox(126.9, 37.5, 127.1, 37.6)
        val cells = cellsCovering(box, 14)
        val union = cells.map { it.bbox() }
        assertTrue(union.minOf { it.minLon } <= box.minLon && union.maxOf { it.maxLon } >= box.maxLon)
        assertTrue(union.minOf { it.minLat } <= box.minLat && union.maxOf { it.maxLat } >= box.maxLat)
        assertEquals(cells.size, cells.toSet().size)
        for (c in cells) assertEquals(0.075, c.bbox().width, 1e-9)
        // 격자에 맞아서 같은 지점은 항상 같은 칸이다
        assertEquals(cellsCovering(Bbox(126.95, 37.52, 126.96, 37.53), 14), cellsCovering(Bbox(126.951, 37.521, 126.952, 37.522), 14))
    }

    @Test
    fun 칸이_너무_많으면_중심에_가까운_칸만_남긴다() {
        val cells = cellsCovering(Bbox(120.0, 30.0, 135.0, 40.0), 14, maxCells = 10)
        assertEquals(10, cells.size)
        val cx = 127.5
        val cy = 35.0
        val farthest = cells.maxOf { val b = it.bbox(); Math.abs((b.minLon + b.maxLon) / 2 - cx) }
        assertTrue(farthest < 1.0)
    }

    @Test
    fun 시군구_칸과_z는_확대에_따라_바뀐다() {
        assertEquals(5, regionZ(3.0))
        assertEquals(13, regionZ(16.0))
        assertEquals(16.0, regionCellSizeDeg(5), 0.0)
        assertEquals(0.5, regionCellSizeDeg(13), 0.0)
        assertTrue(regionCellsCovering(NATIONAL_BBOX, 6).size <= 2) // 전국은 한두 칸
    }

    @Test
    fun 방위와_거리() {
        val a = LonLat(127.0, 37.5)
        assertEquals(0.0, bearingDeg(a, LonLat(127.0, 37.6)), 0.5)
        assertEquals(90.0, bearingDeg(a, LonLat(127.1, 37.5)), 0.5)
        assertEquals(180.0, bearingDeg(a, LonLat(127.0, 37.4)), 0.5)
        assertEquals(270.0, bearingDeg(a, LonLat(126.9, 37.5)), 0.5)
        assertEquals(11_119.5, distanceM(a, LonLat(127.0, 37.6)), 5.0)
    }
}
