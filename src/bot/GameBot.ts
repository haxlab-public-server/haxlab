import helpCmd from './commands/help';
import rrCmd from './commands/rr';
import startCmd from './commands/start';
import addadminCmd from './commands/addadmin';
import afkCmd from './commands/afk';
import statsCmd from './commands/stats';
import statusCmd from './commands/status';
import deanonCmd from './commands/deanon';
import onRoomLink from './events/onRoomLink';
import onPlayerJoin from './events/onPlayerJoin';
import onPlayerLeave from './events/onPlayerLeave';
import onPlayerChat from './events/onPlayerChat';
import onTeamGoal from './events/onTeamGoal';
import onGameStop from './events/onGameStop';
import onGameStart from './events/onGameStart';
import onPlayerBallKick from './events/onPlayerBallKick';
import onPositionsReset from './events/onPositionsReset';
import GameState from './lib/GameState';
import CaptainDraft from './lib/CaptainDraft';
import Logger from './lib/Logger';
import AutoManager from './lib/AutoManager';
import type HaxballDatabase from '../db/Database';
import type { DbPlayer, PlayerRole } from '../db/Database';
import type { AppConfig } from '../config';
import type { AdminEntry, BotContext, BotJoinPlayer, BotPlayer, DbBridge, SaveStatsPayload } from './types';

type StatusPayload = Record<string, string | number | boolean | null>;

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function getErrorStack(error: unknown): string | undefined {
  if (error instanceof Error) return error.stack;
  return undefined;
}

function createDbBridge(db: HaxballDatabase): DbBridge {
  return {
    saveStats(payload: SaveStatsPayload) {
      return Promise.resolve(db.recordGame(payload)).then((): void => undefined);
    },
    loadStats(playerAuth: string | null | undefined) {
      if (!playerAuth) return Promise.resolve(null);
      return Promise.resolve(db.getPlayerStats(playerAuth) ?? null);
    },
    registerPlayer(playerAuth: string | null | undefined, name: string, role: PlayerRole = 'player') {
      if (!playerAuth) return Promise.resolve();
      return Promise.resolve(db.ensurePlayerWithStats(playerAuth, name, role));
    },
    getAlias(playerAuth: string | null | undefined) {
      if (!playerAuth) return Promise.resolve(null);
      return Promise.resolve(db.getAlias(playerAuth) ?? null);
    },
    setAlias(playerAuth: string | null | undefined, alias: string): Promise<void> {
      if (!playerAuth) return Promise.resolve();
      return Promise.resolve(db.setAlias(playerAuth, alias)).then((): void => undefined);
    },
    resolveAuthForName(name: string) {
      if (!name) return Promise.resolve(null);
      const player = db.getPlayerByName(name);
      return Promise.resolve(player ? player.player_auth : null);
    },
  };
}

function attachBot(
  room: RoomObject,
  _config: AppConfig,
  db: HaxballDatabase,
  reportStatus: (payload: StatusPayload) => void
) {
  const logger = new Logger();
  const autoManager = new AutoManager();
  const admins: AdminEntry[] = db.getPrivilegedPlayers().map((p: DbPlayer) => ({ auth: p.player_auth, name: p.name ?? undefined, role: p.role }));
  const commands = [helpCmd, rrCmd, startCmd, addadminCmd, afkCmd, statsCmd, deanonCmd, statusCmd];
  const events = {
    onRoomLink,
    onPlayerJoin,
    onPlayerLeave,
    onPlayerChat,
    onTeamGoal,
    onGameStop,
    onGameStart,
    onPlayerBallKick,
    onPositionsReset,
  };
  const ctx: BotContext = {
    room,
    gameState: new GameState(),
    captainDraft: new CaptainDraft(),
    logger,
    adminList: admins,
    afkTimers: {},
    touches: { lastTouches: [null, null], lastTeamTouched: 0 },
    auto: autoManager,
    db: createDbBridge(db),
  };

  logger.info('Bot runtime starting...');
  logger.info('Loaded ' + admins.length + ' admins from database');

  try {
    logger.info('Configuring room settings...');
    room.setDefaultStadium('Big');
    room.setScoreLimit(1);
    room.setTimeLimit(0);
    room.setTeamsLock(true);
    logger.info('Room configured');

    reportStatus({ up: true });

    room.onRoomLink = (url: string) => {
      try {
        logger.info('onRoomLink event fired with URL: ' + url);
        events.onRoomLink(ctx, url);
        reportStatus({ roomLink: url });
      } catch (e: unknown) {
        console.error('[onRoomLink error]', getErrorMessage(e), getErrorStack(e));
      }
    };
    
    room.onPlayerJoin = (player: BotJoinPlayer) => {
      try {
        logger.info('onPlayerJoin event fired for player: ' + player.name);
        events.onPlayerJoin(ctx, player);
        const s = ctx.gameState.getState();
        reportStatus({ players: Object.keys(s.players).length, size: s.gameSize });
      } catch (e: unknown) {
        console.error('[onPlayerJoin error]', getErrorMessage(e));
      }
    };
    
    room.onPlayerLeave = (player: PlayerObject) => {
      try {
        logger.info('onPlayerLeave event fired for player: ' + player.name);
        events.onPlayerLeave(ctx, player);
        const s = ctx.gameState.getState();
        reportStatus({ players: Object.keys(s.players).length, size: s.gameSize });
      } catch (e: unknown) {
        console.error('[onPlayerLeave error]', getErrorMessage(e));
      }
    };
    
    room.onPlayerChat = (player: BotPlayer, message: string) => {
      try {
        logger.debug('onPlayerChat: ' + player.name + ' said: ' + message);
        return events.onPlayerChat(ctx, player, message, commands);
      } catch (e: unknown) {
        console.error('[onPlayerChat error]', getErrorMessage(e));
        return true;
      }
    };
    
    room.onTeamGoal = (team: 1 | 2) => {
      try {
        logger.info('onTeamGoal event fired for team: ' + team);
        events.onTeamGoal(ctx, team);
      } catch (e: unknown) {
        console.error('[onTeamGoal error]', getErrorMessage(e));
      }
    };
    room.onPlayerBallKick = (player: BotPlayer) => {
      try {
        logger.debug('onPlayerBallKick by: ' + player.name);
        events.onPlayerBallKick(ctx, player);
      } catch (e: unknown) {
        console.error('[onPlayerBallKick error]', getErrorMessage(e));
      }
    };
    room.onPositionsReset = () => {
      try {
        logger.debug('onPositionsReset');
        events.onPositionsReset(ctx);
      } catch (e: unknown) {
        console.error('[onPositionsReset error]', getErrorMessage(e));
      }
    };
    
    room.onGameStop = (_byPlayer: PlayerObject | null) => {
      try {
        logger.info('onGameStop event fired');
        events.onGameStop(ctx);
        reportStatus({ inProgress: false });
      } catch (e: unknown) {
        console.error('[onGameStop error]', getErrorMessage(e));
      }
    };
    
    room.onGameStart = (_byPlayer: PlayerObject | null) => {
      try {
        logger.info('onGameStart event fired');
        events.onGameStart(ctx);
        reportStatus({ inProgress: true, draft: ctx.captainDraft.isDraftActive() });
      } catch (e: unknown) {
        console.error('[onGameStart error]', getErrorMessage(e));
      }
    };
    
    logger.info('All event handlers registered');
  } catch (e: unknown) {
    console.error('[bot] FATAL ERROR:', getErrorMessage(e));
    console.error('[bot] Stack:', getErrorStack(e));
    throw e;
  }

  return { ctx, commands, events };
}

export { attachBot, createDbBridge };
