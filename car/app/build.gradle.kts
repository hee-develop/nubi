import org.jetbrains.kotlin.gradle.dsl.JvmTarget

import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// release 서명 정보: NUBI_KEYSTORE_PROPS 환경변수 → ~/.nubi/keystore.properties 순. 없으면 서명 없이 빌드한다.
val releaseSigningProps: Properties? = run {
    val file = System.getenv("NUBI_KEYSTORE_PROPS")?.takeIf { it.isNotBlank() }?.let { File(it) }
        ?: File(System.getProperty("user.home"), ".nubi/keystore.properties")
    if (!file.isFile) return@run null
    Properties().apply { file.inputStream().use { load(it) } }
        .takeIf { p -> listOf("storeFile", "storePassword", "keyAlias", "keyPassword").all { !p.getProperty(it).isNullOrBlank() } }
}
if (releaseSigningProps == null) {
    logger.warn("경고: release 서명 속성 파일을 찾지 못했거나 불완전합니다. 서명 없는 APK(app-release-unsigned.apk)가 만들어지며 설치할 수 없습니다. NUBI_KEYSTORE_PROPS 또는 ~/.nubi/keystore.properties를 설정하세요.")
}

// release 서버 주소: -Pnubi.releaseServerUrl=https://... (기본은 자리표시 주소). release는 TLS 필수.
val placeholderServerUrl = "https://nubi.invalid"
val releaseServerUrl = ((project.findProperty("nubi.releaseServerUrl") as String?) ?: placeholderServerUrl).trim()
if (!releaseServerUrl.startsWith("https://")) {
    throw GradleException("nubi.releaseServerUrl은 https:// 로 시작해야 합니다(release는 TLS 필수): $releaseServerUrl")
}

android {
    namespace = "com.nubi.car"
    compileSdk = 36

    // AAOS 표준 Car API 사용
    useLibrary("android.car")

    defaultConfig {
        applicationId = "com.nubi.car"
        // Pleos Connect 요구사항: minSdk 28 이상, 플랫폼은 API 34
        minSdk = 28
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
    }

    testOptions {
        // JVM 단위 테스트에서 android.util.Log 호출이 예외 대신 기본값을 돌려주게 한다
        unitTests.isReturnDefaultValues = true
    }

    buildFeatures {
        buildConfig = true
    }

    signingConfigs {
        releaseSigningProps?.let { p ->
            create("release") {
                storeFile = file(p.getProperty("storeFile"))
                storePassword = p.getProperty("storePassword")
                keyAlias = p.getProperty("keyAlias")
                keyPassword = p.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        debug {
            // 에뮬레이터에서 PC의 서버(tsx src/index.ts)에 붙는 주소. 포트는 -Pnubi.serverPort=<포트>로 바꾼다(기본 8787).
            val serverPortValue = (project.findProperty("nubi.serverPort") as String?) ?: "8787"
            val serverPort = serverPortValue.toIntOrNull()?.takeIf { it in 1..65535 }
                ?: throw GradleException("nubi.serverPort는 1~65535 사이 숫자여야 합니다: $serverPortValue")
            buildConfigField("String", "SERVER_URL", "\"http://10.0.2.2:$serverPort\"")
            buildConfigField("boolean", "SERVER_URL_IS_PLACEHOLDER", "false")
        }
        release {
            isMinifyEnabled = false
            buildConfigField("String", "SERVER_URL", "\"$releaseServerUrl\"")
            buildConfigField("boolean", "SERVER_URL_IS_PLACEHOLDER", (releaseServerUrl == placeholderServerUrl).toString())
            signingConfigs.findByName("release")?.let { signingConfig = it }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

dependencies {
    implementation("ai.pleos.playground:Vehicle:2.3.2")
    implementation("ai.pleos.playground:NaviHelper:3.0.5")
    implementation("ai.pleos.playground:FusedLocation:1.1.3")
    implementation("ai.pleos.playground:TextToSpeech:3.3.1")
    implementation("ai.pleos.playground:SpeechToText:3.3.1")
    // 게스트·차주 연결·공유 QR 인코딩(순수 Java, 네트워크·권한 없음)
    implementation("com.google.zxing:core:3.5.4")

    testImplementation("junit:junit:4.13.2")
    // JVM 단위 테스트는 android.jar의 org.json 스텁 대신 이 구현을 쓴다
    testImplementation("org.json:json:20231013")
}
