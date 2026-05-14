import type { DbPlayerStats, PlayerRole } from '../db/Database';
import type GameState from './lib/GameState';
import type CaptainDraft from './lib/CaptainDraft';
import type Logger from './lib/Logger';
import type AutoManager from './lib/AutoManager';

export type TeamId = 0 | 1 | 2;
export type PlayingTeam = 1 | 2;
export type NullableTeam = TeamId | null;

export type AdminEntry = {
  auth: string;
  name?: string;
  role: PlayerRole;
};

export type SavedGamePlayer = {
  id: number;
  name?: string;
  auth?: string | null;
  team: TeamId;
};

export type SaveStatsPayload = {
  winnerTeam: PlayingTeam | null;
  players: SavedGamePlayer[];
};

export type DbBridge = {
  saveStats(payload: SaveStatsPayload): Promise<void>;
  loadStats(playerAuth: string | null | undefined): Promise<DbPlayerStats | null>;
  registerPlayer(playerAuth: string | null | undefined, name: string, role?: PlayerRole): Promise<void>;
  getAlias(playerAuth: string | null | undefined): Promise<{ alias: string } | null>;
  setAlias(playerAuth: string | null | undefined, alias: string): Promise<void>;
  resolveAuthForName(name: string): Promise<string | null>;
};

export type TouchPlayer = {
  id: number;
  name: string;
  team: TeamId;
};

export type BotPlayer = PlayerObject & {
  auth?: string | null;
};

export type BotJoinPlayer = PlayerJoinObject;

export type TouchEntry = {
  player: TouchPlayer;
  time: number;
};

export type ChooseTimers = {
  warn: ReturnType<typeof setTimeout>;
  final: ReturnType<typeof setTimeout>;
};

export type RateLimitState = {
  last: number;
  windowStart: number;
  count: number;
};

export type BotContext = {
  room: RoomObject;
  gameState: GameState;
  captainDraft: CaptainDraft;
  logger: Logger;
  adminList: AdminEntry[];
  afkTimers: Record<number, ReturnType<typeof setTimeout>>;
  touches: {
    lastTouches: [TouchEntry | null, TouchEntry | null];
    lastTeamTouched: TeamId;
  };
  auto: AutoManager;
  db: DbBridge;
  chooseTimers?: ChooseTimers | null;
  rateLimit?: Record<number, RateLimitState>;
};

export type BotCommandResult = boolean | void;

export type BotCommand = {
  name: string;
  trigger: string;
  description: string;
  handle(ctx: BotContext, player: BotPlayer, args: string[]): BotCommandResult;
};
