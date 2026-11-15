import { readFileSync } from 'node:fs';
import { Hono } from 'hono';

// 빌드(tsc)는 .html을 dist에 복사하지 않으므로 package.json의 build 스크립트가 따로 복사한다.
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');

/** 시연·검증용 지도 뷰어(debug). 정적 HTML 1개이고 vehicleId는 페이지가 쿼리스트링에서 읽는다. */
export const viewerRoutes = () => new Hono().get('/', (c) => c.html(html));
