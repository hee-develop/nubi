package com.nubi.car.screens

import android.graphics.Bitmap
import android.graphics.Color

/** QR 모듈 행렬을 비트맵으로 그린다(모듈마다 [scale]픽셀, 흰 바탕·검은 칸). 화면에서는 확대해도 번지지 않게 필터 없이 그린다. */
fun qrBitmap(matrix: Array<BooleanArray>, scale: Int = 8): Bitmap {
    val n = matrix.size
    val size = n * scale
    val px = IntArray(size * size) { Color.WHITE }
    for (y in 0 until n) for (x in 0 until n) {
        if (!matrix[y][x]) continue
        for (dy in 0 until scale) {
            val row = (y * scale + dy) * size + x * scale
            for (dx in 0 until scale) px[row + dx] = Color.BLACK
        }
    }
    return Bitmap.createBitmap(px, size, size, Bitmap.Config.ARGB_8888)
}
