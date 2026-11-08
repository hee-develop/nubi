import { serve } from '@hono/node-server';
import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 8787);
const hostname = process.env.HOST ?? '127.0.0.1';

serve({ fetch: createApp().fetch, port, hostname }, (info) => {
  console.log(`누비 서버 실행 중: http://${hostname}:${info.port}`);
});
