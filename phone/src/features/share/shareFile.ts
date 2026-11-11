import { Asset } from 'expo-asset';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import type { ShareCard } from '../../api';

/** 목 카드는 앱에 든 이미지를 쓴다(서버 PNG 대신). 실서버 카드는 그대로 받아 온다. */
export const MOCK_IMAGE = require('../../../assets/icon.png') as number;
export const isMockCard = (c: ShareCard) => c.imageUrl.startsWith('mock:');

export const cardImageSource = (c: ShareCard) => (isMockCard(c) ? MOCK_IMAGE : { uri: c.imageUrl });

/** 카드 이미지를 캐시에 내려받아 로컬 파일 URI로 만든다. 공유 시트는 로컬 파일이 필요하다. */
export const prepareShareFile = async (c: ShareCard): Promise<string> => {
  if (isMockCard(c)) {
    const a = Asset.fromModule(MOCK_IMAGE);
    await a.downloadAsync();
    return a.localUri ?? a.uri;
  }
  const ext = c.imageUrl.split('?')[0]!.endsWith('.svg') ? 'svg' : 'png';
  const f = await File.downloadFileAsync(c.imageUrl, new File(Paths.cache, `nubi-card-${c.id}.${ext}`), { idempotent: true });
  return f.uri;
};

export const shareCard = async (c: ShareCard): Promise<'shared' | 'unavailable'> => {
  if (!(await Sharing.isAvailableAsync())) return 'unavailable';
  const uri = await prepareShareFile(c);
  await Sharing.shareAsync(uri, { mimeType: uri.endsWith('.svg') ? 'image/svg+xml' : 'image/png', dialogTitle: '누비' });
  return 'shared';
};

