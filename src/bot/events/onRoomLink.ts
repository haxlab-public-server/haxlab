import type { BotContext } from '../types';

export default function (ctx: BotContext, url: string) {
  ctx.logger.info('onRoomLink triggered with URL: ' + url);
  console.log('[ROOM LINK]', url);
  ctx.room.sendAnnouncement('Ссылка на комнату: ' + url, null, 0x00FF00, 'bold', 1);
  ctx.logger.info('Room link announcement sent');
};
