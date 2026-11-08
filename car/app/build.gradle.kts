import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
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

    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        debug {
            // 에뮬레이터에서 PC의 서버(tsx src/index.ts)에 붙는 주소. 포트는 -Pnubi.serverPort=<포트>로 바꾼다(기본 8787).
            val serverPortValue = (project.findProperty("nubi.serverPort") as String?) ?: "8787"
            val serverPort = serverPortValue.toIntOrNull()?.takeIf { it in 1..65535 }
                ?: throw GradleException("nubi.serverPort는 1~65535 사이 숫자여야 합니다: $serverPortValue")
            buildConfigField("String", "SERVER_URL", "\"http://10.0.2.2:$serverPort\"")
        }
        release {
            isMinifyEnabled = false
            buildConfigField("String", "SERVER_URL", "\"https://nubi.invalid\"")
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

    testImplementation("junit:junit:4.13.2")
    // JVM 단위 테스트는 android.jar의 org.json 스텁 대신 이 구현을 쓴다
    testImplementation("org.json:json:20231013")
}
