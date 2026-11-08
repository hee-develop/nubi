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
