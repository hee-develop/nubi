# 누비

Pleos Connect(현대차그룹 AAOS 기반 인포테인먼트) 차량 앱 프로젝트입니다.

## 구조

- `car/`: 차량 앱. Kotlin 네이티브 + Pleos Connect SDK, 독립 Gradle 프로젝트(`com.nubi.car`)
- `phone/`: 휴대폰 앱. React Native(Expo), `@nubi/phone`
- `server/`: 서버. TypeScript + Hono, `@nubi/server`
- `docs/`: 조사·기획 문서

## 설치와 실행

- 설치(루트): `pnpm install`
- 서버: `pnpm server:dev` / `pnpm server:test`
- 폰 앱: `pnpm phone:start` / `pnpm phone:test`
- 타입체크: `pnpm typecheck`
- 차량 앱: `cd car && ./gradlew :app:assembleDebug` / `pnpm car:test`

## 공개 배포 전 필수 (보안)

서버에는 아직 인증·인가가 없습니다. `/regions/*`·`/coverage/*`·`/trips`(그리고 `/vehicles/*`)는 `vehicleId`만 알면 누구나 읽을 수 있으므로 **공개 배포 전에 인증(기기·계정 토큰)과 소유권 확인, rate limit, TLS 종단을 반드시 붙여야** 합니다(사양 01·03). 현재 조치는 `GET /trips`의 전체 열거 차단(`vehicleId` 없으면 400)뿐입니다.
