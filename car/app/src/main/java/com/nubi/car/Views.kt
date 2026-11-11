package com.nubi.car

import android.view.View
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import com.nubi.car.map.NubiMapView

/** activity_main의 뷰 참조 모음(MainActivity가 커지지 않도록 분리). */
class Views(val root: View) {
    private fun <T : View> id(id: Int): T = root.findViewById(id)

    val drivingView: View = id(R.id.driving_view)
    val drivingLegacy: View = id(R.id.driving_legacy)
    val drivingMap: View = id(R.id.driving_map)
    val mapDriving: NubiMapView = id(R.id.map_driving)
    val drivingMapState: TextView = id(R.id.driving_map_state)
    val drivingMapRegion: TextView = id(R.id.driving_map_region)
    val drivingMapHealth: TextView = id(R.id.driving_map_health)
    val drivingState: TextView = id(R.id.driving_state)
    val drivingHealth: TextView = id(R.id.driving_health)
    val drivingStorage: TextView = id(R.id.driving_storage)
    val drivingUpload: TextView = id(R.id.driving_upload)

    val parkedView: View = id(R.id.parked_view)
    val chip: TextView = id(R.id.chip)
    val body: LinearLayout = id(R.id.body)
    val parkedMapArea: View = id(R.id.parked_map_area)
    val mapParked: NubiMapView = id(R.id.map_parked)
    val mapControlCol: View = id(R.id.map_control_col)
    val mapLayerRow: View = id(R.id.map_layer_row)
    val mapBtnRoads: TextView = id(R.id.map_btn_roads)
    val mapBtnRegions: TextView = id(R.id.map_btn_regions)
    val mapBtnZoomIn: TextView = id(R.id.map_btn_zoom_in)
    val mapBtnZoomOut: TextView = id(R.id.map_btn_zoom_out)
    val mapBtnMe: TextView = id(R.id.map_btn_me)
    val mapBtnNational: TextView = id(R.id.map_btn_national)
    val panel: LinearLayout = id(R.id.panel)
    val linesBlock: View = id(R.id.lines_block)
    val guestQrImage: ImageView = id(R.id.guest_qr_image)
    val guestDesc: TextView = id(R.id.guest_desc)
    val guestCode: TextView = id(R.id.guest_code)
    val guestCount: TextView = id(R.id.guest_count)
    val guestAdd: TextView = id(R.id.guest_add)
    val guestEndAll: TextView = id(R.id.guest_end_all)
    val parkedHeader: LinearLayout = parkedView.let { (it as LinearLayout).getChildAt(0) as LinearLayout }
    val leftColumn: LinearLayout = id(R.id.left_column)
    val nowLabel: TextView = id(R.id.now_label)
    val stateText: TextView = id(R.id.state_text)
    val placeTitle: TextView = id(R.id.place_title)
    val stageRow: View = id(R.id.stage_row)
    val stageBadge: TextView = id(R.id.stage_badge)
    val eventText: TextView = id(R.id.event_text)
    val roadText: TextView = id(R.id.road_text)
    val nationalText: TextView = id(R.id.national_text)
    val regionsText: TextView = id(R.id.regions_text)
    val depopText: TextView = id(R.id.depop_text)
    val newRegionsText: TextView = id(R.id.new_regions_text)
    val samplesText: TextView = id(R.id.samples_text)
    val distanceText: TextView = id(R.id.distance_text)
    val uploadText: TextView = id(R.id.upload_text)
    val healthText: TextView = id(R.id.health_text)
    val storageText: TextView = id(R.id.storage_text)
    val restartButton: TextView = id(R.id.restart_button)
    val permissionCard: View = id(R.id.permission_card)
    val permissionConfirm: TextView = id(R.id.permission_confirm)
    val permissionSettings: TextView = id(R.id.permission_settings)
    val guestCard: View = id(R.id.guest_card)

    val neighborCard: View = id(R.id.neighbor_card)
    val neighborName: TextView = id(R.id.neighbor_name)
    val depopTag: TextView = id(R.id.depop_tag)
    val poiRow: View = id(R.id.poi_row)
    val naviCompact: TextView = id(R.id.navi_compact)
    val naviSight: TextView = id(R.id.navi_sight)
    val naviFestival: TextView = id(R.id.navi_festival)
    val poiSource: TextView = id(R.id.poi_source)
    val naviStatus: TextView = id(R.id.navi_status)
}
