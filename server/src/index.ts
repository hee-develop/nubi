import { serve } from '@hono/node-server';
import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 8787);
const hostname = process.env.HOST ?? '127.0.0.1';

let app: ReturnType<typeof createApp>;
try {
  app = createApp();
} catch (e) {
  // 필수 설정 누락 같은 시작 오류는 스택 없이 메시지만 보이고 종료한다.
  console.error(`서버를 시작할 수 없습니다: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`누비 서버 실행 중: http://${hostname}:${info.port}`);
});
