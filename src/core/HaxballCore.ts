import config from '../config';
import express from 'express';
import dotenv from 'dotenv';
import HaxballJS from 'haxball.js';
import { attachBot } from '../bot/GameBot';
import HaxballDatabase from '../db/Database';

type BotStatus = {
  up: boolean;
  roomLink: string | null;
  players: number;
  inProgress: boolean;
  lastUpdate: string | null;
};

const botStatus: BotStatus = {
  up: false,
  roomLink: null,
  players: 0,
  inProgress: false,
  lastUpdate: null,
};

function startHealthServer() {
  const app = express();
  const port = parseInt(process.env.HEALTH_PORT || '3000', 10);
  app.get('/health', (req, res) => {
    res.json({ ok: botStatus.up, status: botStatus });
  });
  app.get('/status', (req, res) => {
    res.json(botStatus);
  });
  app.get('/room', (req, res) => {
    res.json({ roomLink: botStatus.roomLink });
  });
  app.listen(port, () => {
    console.log('[core] Health server listening on port', port);
  });
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function applyStatus(status: Partial<BotStatus>) {
  if (!status || typeof status !== 'object') return;

  Object.assign(botStatus, status);
  botStatus.lastUpdate = new Date().toISOString();
}

async function startHeadless(db: HaxballDatabase) {
  if (!config.HEADLESS_TOKEN) {
    throw new Error('HEADLESS_TOKEN is missing');
  }

  console.log('[core] Initializing HaxballJS...');
  const HBInit = await HaxballJS();

  console.log('[core] Creating room...');
  const room = HBInit({
    roomName: config.ROOM.name,
    maxPlayers: config.ROOM.maxPlayers,
    public: config.ROOM.public,
    password: config.ROOM.password,
    geo: config.ROOM.geo,
    noPlayer: true,
    token: config.HEADLESS_TOKEN,
  });
  console.log(config);

  console.log('[core] Attaching bot handlers...');
  attachBot(room, config, db, applyStatus);

  return { room };
}

async function runWithAutoRestart(db: HaxballDatabase) {
  let restartCount = 0;
  const maxRestarts = 5;
  const restartDelay = 5000;

  while (restartCount < maxRestarts) {
    try {
      console.log('[core] Starting bot instance...');
      await startHeadless(db);
      restartCount = 0;
      console.log('[core] Bot running successfully');

      await new Promise(() => {});

    } catch (err: unknown) {
      restartCount++;
      console.error(`[core] Error (attempt ${restartCount}/${maxRestarts}):`, getErrorMessage(err));
      
      if (restartCount < maxRestarts) {
        console.log(`[core] Restarting in ${restartDelay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, restartDelay));
      }
    }
  }

  console.error('[core] Max restart attempts reached. Exiting.');
  process.exit(1);
}

async function main() {
  try {
    dotenv.config();
    
    const db = new HaxballDatabase();
    console.log('[core] Database initialized');
    
    startHealthServer();

    await runWithAutoRestart(db);
  } catch (err: unknown) {
    console.error('[core] Fatal error:', getErrorMessage(err));
    process.exit(1);
  }
}

export { startHeadless, main };
