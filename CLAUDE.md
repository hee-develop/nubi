# 누비

Pleos Connect(현대차그룹 AAOS 기반 인포테인먼트) 차량 앱 프로젝트입니다.

## 구조

- `car/`: 차량 앱. Kotlin 네이티브 + Pleos Connect SDK. 독립 Gradle 프로젝트이고 패키지는 `com.nubi.car`
- `phone/`: 휴대폰 앱. React Native(Expo). 패키지는 `@nubi/phone`
- `server/`: 서버. TypeScript + Hono, Node 런타임. 패키지는 `@nubi/server`
- `docs/`: 조사·기획 문서
- JS 쪽(`phone/`, `server/`)은 pnpm 워크스페이스로 묶여 있습니다. 설치는 루트에서 `pnpm install`로 하고, 폰 앱은 서버의 라우트 타입(`AppType`)을 Hono RPC 클라이언트로 가져다 씁니다.

## 폰 앱·서버(JS)

- 설치는 루트에서 `pnpm install`. Expo 패키지는 `pnpm exec expo install`로 추가하고, 라우트는 `phone/src/app/`(Expo Router)에 둡니다.
- 확인: `pnpm typecheck`, `pnpm server:test`, `pnpm phone:test`, `pnpm --filter @nubi/phone lint --max-warnings 0`.
- 서버 라우트는 `app.ts`에서 체이닝으로 연결해 RPC 타입 추론을 유지합니다.
- 웹 타깃을 다시 넣을 때는 `.pnpmfile.cjs` 훅을 지우고 다시 설치합니다(react-dom이 자동 설치되는 버전이 SDK 58의 react와 맞지 않아 훅으로 제거해 두었습니다).

## 검증 환경

- 검증은 Android 기준입니다. Android 에뮬레이터는 `Pixel_10_Pro_XL`을 `-port 5556`으로 쓰고, `emulator-5554`(Pleos 차량 에뮬레이터)는 건드리지 않습니다. adb는 항상 `-s`로 기기를 지정합니다.
- 차량 앱: `cd car && ./gradlew :app:assembleDebug`. 회사망(Zscaler)에서는 `nexus-playground.pleos.ai` 인증서를 JDK가 신뢰하지 못하므로 `~/.gradle/gradle.properties`에 Zscaler 루트를 더한 truststore를 지정해 둡니다. Gradle로 설치할 때도 `ANDROID_SERIAL`을 지정합니다.

## 작업 규칙

- 요구사항(기능)마다 브랜치를 따서 작업하고, `main`에는 squash 병합합니다.
- 기능 완료 기준은 E2E 100% 통과입니다.
- 커밋 전에 변경된 파일만 eslint·prettier로 검사합니다.
