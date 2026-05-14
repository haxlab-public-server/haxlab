import dotenv from 'dotenv';
dotenv.config();

type RoomGeo = {
	code: string;
	lat: number;
	lon: number;
};

export type AppConfig = {
	HEADLESS_TOKEN: string | null;
	ROOM: {
		name: string;
		maxPlayers: number;
		public: boolean;
		password: string | null;
		geo: RoomGeo | null;
	};
};

function safeJson<T>(input: string, fallback: T): T {
	try { return JSON.parse(input) as T; } catch { return fallback; }
}

const config: AppConfig = {
	HEADLESS_TOKEN: process.env.HAXBALL_TOKEN || process.env.HEADLESS_TOKEN || null,
	ROOM: {
		name: process.env.ROOM_NAME || 'HaxChill Room',
		maxPlayers: parseInt(process.env.ROOM_MAX || '14', 10),
		public: process.env.ROOM_PUBLIC ? process.env.ROOM_PUBLIC === 'true' : true,
		password: process.env.ROOM_PASSWORD || null,
		geo: process.env.ROOM_GEO ? safeJson<RoomGeo | null>(process.env.ROOM_GEO, null) : null,
	},
};

export default config;
