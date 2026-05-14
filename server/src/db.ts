import Database from 'better-sqlite3';

export const db = new Database(process.env.DB_PATH ?? './data.db');
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
	id TEXT PRIMARY KEY,
	email TEXT UNIQUE,
	github_id TEXT UNIQUE,
	created_at INTEGER NOT NULL,
	plan TEXT NOT NULL DEFAULT 'free',
	stripe_customer_id TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
	token TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS oauth_codes (
	code TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS usage (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id TEXT NOT NULL,
	ts INTEGER NOT NULL,
	model TEXT NOT NULL,
	input_tokens INTEGER NOT NULL,
	output_tokens INTEGER NOT NULL,
	cost_micros INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_user_ts ON usage(user_id, ts);
CREATE TABLE IF NOT EXISTS memory_files (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id TEXT NOT NULL,
	workspace TEXT NOT NULL,
	rel_path TEXT NOT NULL,
	content TEXT NOT NULL,
	updated_at INTEGER NOT NULL,
	UNIQUE(user_id, workspace, rel_path)
);
CREATE TABLE IF NOT EXISTS jobs (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	task TEXT NOT NULL,
	status TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	finished_at INTEGER,
	log TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS telemetry_events (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	client_id TEXT NOT NULL,
	user_id TEXT,
	ts INTEGER NOT NULL,
	kind TEXT NOT NULL,
	props TEXT
);
CREATE INDEX IF NOT EXISTS idx_tel_kind_ts ON telemetry_events(kind, ts);
`);

export interface User { id: string; email: string | null; github_id: string | null; created_at: number; plan: string; stripe_customer_id: string | null; }

export function createUser(opts: { id: string; email?: string; githubId?: string }): User {
	const u: User = {
		id: opts.id,
		email: opts.email ?? null,
		github_id: opts.githubId ?? null,
		created_at: Date.now(),
		plan: 'free',
		stripe_customer_id: null,
	};
	db.prepare(`INSERT INTO users (id, email, github_id, created_at, plan) VALUES (?, ?, ?, ?, ?)`).run(u.id, u.email, u.github_id, u.created_at, u.plan);
	return u;
}

export function getUser(id: string): User | undefined {
	return db.prepare(`SELECT * FROM users WHERE id = ?`).get(id) as User | undefined;
}

export function getUserByGithub(githubId: string): User | undefined {
	return db.prepare(`SELECT * FROM users WHERE github_id = ?`).get(githubId) as User | undefined;
}
