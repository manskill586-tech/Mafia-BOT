const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { Pool } = require("pg");

const DATABASE_URL = process.env.DATABASE_URL || "";
const PGSSL =
  process.env.PGSSL === "1" ||
  process.env.PGSSL === "true" ||
  process.env.RENDER === "true";
const dbPath =
  process.env.MAFIA_DB_PATH || path.join(__dirname, "..", "data", "mafia.db");

let sqlite = null;
let pool = null;

function isPostgres() {
  return Boolean(pool);
}

async function initDb() {
  if (DATABASE_URL) {
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: PGSSL ? { rejectUnauthorized: false } : undefined,
    });
    await migratePostgres();
  } else {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    sqlite = new Database(dbPath);
    migrateSqlite();
  }
}

async function migratePostgres() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS games (
      channel_id TEXT PRIMARY KEY,
      state_json TEXT NOT NULL,
      phase_deadline BIGINT,
      updated_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_prefs (
      user_id TEXT PRIMARY KEY,
      lang TEXT,
      updated_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS channel_prefs (
      channel_id TEXT PRIMARY KEY,
      listed INTEGER,
      channel_type TEXT,
      updated_at BIGINT NOT NULL,
      prompted_at BIGINT,
      listed_by TEXT,
      settings_json TEXT
    );
    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_stats (
      user_id TEXT PRIMARY KEY,
      wins INTEGER,
      losses INTEGER,
      games INTEGER,
      updated_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_channel_stats (
      user_id TEXT,
      channel_id TEXT,
      wins INTEGER,
      losses INTEGER,
      games INTEGER,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (user_id, channel_id)
    );
    CREATE TABLE IF NOT EXISTS user_role_stats (
      user_id TEXT,
      role TEXT,
      wins INTEGER,
      losses INTEGER,
      games INTEGER,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (user_id, role)
    );
    CREATE TABLE IF NOT EXISTS user_cache (
      user_id TEXT PRIMARY KEY,
      platform TEXT,
      display_name TEXT,
      handle TEXT,
      updated_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS channel_cache (
      channel_id TEXT PRIMARY KEY,
      platform TEXT,
      name TEXT,
      is_private BOOLEAN,
      updated_at BIGINT NOT NULL
    );
  `);
  await pool.query(
    "ALTER TABLE channel_prefs ADD COLUMN IF NOT EXISTS settings_json TEXT"
  );
}

function migrateSqlite() {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS games (
      channel_id TEXT PRIMARY KEY,
      state_json TEXT NOT NULL,
      phase_deadline INTEGER,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_prefs (
      user_id TEXT PRIMARY KEY,
      lang TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS channel_prefs (
      channel_id TEXT PRIMARY KEY,
      listed INTEGER,
      channel_type TEXT,
      updated_at INTEGER NOT NULL,
      prompted_at INTEGER,
      listed_by TEXT,
      settings_json TEXT
    );
    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_stats (
      user_id TEXT PRIMARY KEY,
      wins INTEGER,
      losses INTEGER,
      games INTEGER,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_channel_stats (
      user_id TEXT,
      channel_id TEXT,
      wins INTEGER,
      losses INTEGER,
      games INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, channel_id)
    );
    CREATE TABLE IF NOT EXISTS user_role_stats (
      user_id TEXT,
      role TEXT,
      wins INTEGER,
      losses INTEGER,
      games INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, role)
    );
    CREATE TABLE IF NOT EXISTS user_cache (
      user_id TEXT PRIMARY KEY,
      platform TEXT,
      display_name TEXT,
      handle TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS channel_cache (
      channel_id TEXT PRIMARY KEY,
      platform TEXT,
      name TEXT,
      is_private INTEGER,
      updated_at INTEGER NOT NULL
    );
  `);
  const columns = sqlite
    .prepare("PRAGMA table_info(channel_prefs)")
    .all()
    .map((row) => row.name);
  if (!columns.includes("settings_json")) {
    sqlite.exec("ALTER TABLE channel_prefs ADD COLUMN settings_json TEXT");
  }
}

async function dbAll(sqliteSql, pgSql, params = []) {
  if (isPostgres()) {
    const res = await pool.query(pgSql, params);
    return res.rows;
  }
  return sqlite.prepare(sqliteSql).all(...params);
}

async function dbGet(sqliteSql, pgSql, params = []) {
  if (isPostgres()) {
    const res = await pool.query(pgSql, params);
    return res.rows[0] || null;
  }
  return sqlite.prepare(sqliteSql).get(...params) || null;
}

async function dbRun(sqliteSql, pgSql, params = []) {
  if (isPostgres()) {
    await pool.query(pgSql, params);
    return;
  }
  sqlite.prepare(sqliteSql).run(...params);
}

async function saveGame(channelId, stateJson, phaseDeadline, updatedAt) {
  return dbRun(
    "INSERT INTO games (channel_id, state_json, phase_deadline, updated_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(channel_id) DO UPDATE SET state_json=excluded.state_json, phase_deadline=excluded.phase_deadline, updated_at=excluded.updated_at",
    "INSERT INTO games (channel_id, state_json, phase_deadline, updated_at) VALUES ($1, $2, $3, $4) " +
      "ON CONFLICT(channel_id) DO UPDATE SET state_json=excluded.state_json, phase_deadline=excluded.phase_deadline, updated_at=excluded.updated_at",
    [channelId, stateJson, phaseDeadline, updatedAt]
  );
}

async function deleteGame(channelId) {
  return dbRun(
    "DELETE FROM games WHERE channel_id = ?",
    "DELETE FROM games WHERE channel_id = $1",
    [channelId]
  );
}

async function loadAllGames() {
  return dbAll(
    "SELECT state_json, phase_deadline FROM games",
    "SELECT state_json, phase_deadline FROM games",
    []
  );
}

async function getUserLang(userId) {
  return dbGet(
    "SELECT lang FROM user_prefs WHERE user_id = ?",
    "SELECT lang FROM user_prefs WHERE user_id = $1",
    [userId]
  );
}

async function setUserLang(userId, lang, updatedAt) {
  return dbRun(
    "INSERT INTO user_prefs (user_id, lang, updated_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(user_id) DO UPDATE SET lang=excluded.lang, updated_at=excluded.updated_at",
    "INSERT INTO user_prefs (user_id, lang, updated_at) VALUES ($1, $2, $3) " +
      "ON CONFLICT(user_id) DO UPDATE SET lang=excluded.lang, updated_at=excluded.updated_at",
    [userId, lang, updatedAt]
  );
}

async function getChannelPref(channelId) {
  return dbGet(
    "SELECT channel_id, listed, channel_type, updated_at, prompted_at, listed_by, settings_json FROM channel_prefs WHERE channel_id = ?",
    "SELECT channel_id, listed, channel_type, updated_at, prompted_at, listed_by, settings_json FROM channel_prefs WHERE channel_id = $1",
    [channelId]
  );
}

async function upsertChannelPref(
  channelId,
  listed,
  channelType,
  updatedAt,
  promptedAt,
  listedBy,
  settingsJson
) {
  return dbRun(
    "INSERT INTO channel_prefs (channel_id, listed, channel_type, updated_at, prompted_at, listed_by, settings_json) VALUES (?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(channel_id) DO UPDATE SET listed=excluded.listed, channel_type=COALESCE(excluded.channel_type, channel_prefs.channel_type), updated_at=excluded.updated_at, prompted_at=COALESCE(excluded.prompted_at, channel_prefs.prompted_at), listed_by=COALESCE(excluded.listed_by, channel_prefs.listed_by), settings_json=COALESCE(excluded.settings_json, channel_prefs.settings_json)",
    "INSERT INTO channel_prefs (channel_id, listed, channel_type, updated_at, prompted_at, listed_by, settings_json) VALUES ($1, $2, $3, $4, $5, $6, $7) " +
      "ON CONFLICT(channel_id) DO UPDATE SET listed=excluded.listed, channel_type=COALESCE(excluded.channel_type, channel_prefs.channel_type), updated_at=excluded.updated_at, prompted_at=COALESCE(excluded.prompted_at, channel_prefs.prompted_at), listed_by=COALESCE(excluded.listed_by, channel_prefs.listed_by), settings_json=COALESCE(excluded.settings_json, channel_prefs.settings_json)",
    [channelId, listed, channelType, updatedAt, promptedAt, listedBy, settingsJson]
  );
}

async function listListedChannels() {
  return dbAll(
    "SELECT channel_id, listed, channel_type, updated_at, settings_json FROM channel_prefs WHERE listed = 1 ORDER BY updated_at DESC",
    "SELECT channel_id, listed, channel_type, updated_at, settings_json FROM channel_prefs WHERE listed = 1 ORDER BY updated_at DESC",
    []
  );
}

async function listOwnedChannels(userId) {
  return dbAll(
    "SELECT channel_id, listed, channel_type, updated_at, settings_json FROM channel_prefs WHERE listed_by = ? ORDER BY updated_at DESC",
    "SELECT channel_id, listed, channel_type, updated_at, settings_json FROM channel_prefs WHERE listed_by = $1 ORDER BY updated_at DESC",
    [userId]
  );
}

async function getAppState(key) {
  return dbGet(
    "SELECT value FROM app_state WHERE key = ?",
    "SELECT value FROM app_state WHERE key = $1",
    [key]
  );
}

async function setAppState(key, value, updatedAt) {
  return dbRun(
    "INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
    "INSERT INTO app_state (key, value, updated_at) VALUES ($1, $2, $3) " +
      "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
    [key, value, updatedAt]
  );
}

async function getUserStats(userId) {
  return dbGet(
    "SELECT wins, losses, games FROM user_stats WHERE user_id = ?",
    "SELECT wins, losses, games FROM user_stats WHERE user_id = $1",
    [userId]
  );
}

async function upsertUserStats(userId, wins, losses, games, updatedAt) {
  return dbRun(
    "INSERT INTO user_stats (user_id, wins, losses, games, updated_at) VALUES (?, ?, ?, ?, ?) " +
      "ON CONFLICT(user_id) DO UPDATE SET wins=excluded.wins, losses=excluded.losses, games=excluded.games, updated_at=excluded.updated_at",
    "INSERT INTO user_stats (user_id, wins, losses, games, updated_at) VALUES ($1, $2, $3, $4, $5) " +
      "ON CONFLICT(user_id) DO UPDATE SET wins=excluded.wins, losses=excluded.losses, games=excluded.games, updated_at=excluded.updated_at",
    [userId, wins, losses, games, updatedAt]
  );
}

async function getUserChannelStats(userId, channelId) {
  return dbGet(
    "SELECT wins, losses, games FROM user_channel_stats WHERE user_id = ? AND channel_id = ?",
    "SELECT wins, losses, games FROM user_channel_stats WHERE user_id = $1 AND channel_id = $2",
    [userId, channelId]
  );
}

async function upsertUserChannelStats(
  userId,
  channelId,
  wins,
  losses,
  games,
  updatedAt
) {
  return dbRun(
    "INSERT INTO user_channel_stats (user_id, channel_id, wins, losses, games, updated_at) VALUES (?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(user_id, channel_id) DO UPDATE SET wins=excluded.wins, losses=excluded.losses, games=excluded.games, updated_at=excluded.updated_at",
    "INSERT INTO user_channel_stats (user_id, channel_id, wins, losses, games, updated_at) VALUES ($1, $2, $3, $4, $5, $6) " +
      "ON CONFLICT(user_id, channel_id) DO UPDATE SET wins=excluded.wins, losses=excluded.losses, games=excluded.games, updated_at=excluded.updated_at",
    [userId, channelId, wins, losses, games, updatedAt]
  );
}

async function getUserRoleStats(userId, role) {
  return dbGet(
    "SELECT wins, losses, games FROM user_role_stats WHERE user_id = ? AND role = ?",
    "SELECT wins, losses, games FROM user_role_stats WHERE user_id = $1 AND role = $2",
    [userId, role]
  );
}

async function upsertUserRoleStats(userId, role, wins, losses, games, updatedAt) {
  return dbRun(
    "INSERT INTO user_role_stats (user_id, role, wins, losses, games, updated_at) VALUES (?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(user_id, role) DO UPDATE SET wins=excluded.wins, losses=excluded.losses, games=excluded.games, updated_at=excluded.updated_at",
    "INSERT INTO user_role_stats (user_id, role, wins, losses, games, updated_at) VALUES ($1, $2, $3, $4, $5, $6) " +
      "ON CONFLICT(user_id, role) DO UPDATE SET wins=excluded.wins, losses=excluded.losses, games=excluded.games, updated_at=excluded.updated_at",
    [userId, role, wins, losses, games, updatedAt]
  );
}

async function listUserRoleStats(userId) {
  return dbAll(
    "SELECT role, wins, losses, games FROM user_role_stats WHERE user_id = ? ORDER BY games DESC",
    "SELECT role, wins, losses, games FROM user_role_stats WHERE user_id = $1 ORDER BY games DESC",
    [userId]
  );
}

async function getUserCache(userId) {
  return dbGet(
    "SELECT user_id, platform, display_name, handle FROM user_cache WHERE user_id = ?",
    "SELECT user_id, platform, display_name, handle FROM user_cache WHERE user_id = $1",
    [userId]
  );
}

async function upsertUserCache(userId, platform, displayName, handle, updatedAt) {
  return dbRun(
    "INSERT INTO user_cache (user_id, platform, display_name, handle, updated_at) VALUES (?, ?, ?, ?, ?) " +
      "ON CONFLICT(user_id) DO UPDATE SET platform=excluded.platform, display_name=excluded.display_name, handle=excluded.handle, updated_at=excluded.updated_at",
    "INSERT INTO user_cache (user_id, platform, display_name, handle, updated_at) VALUES ($1, $2, $3, $4, $5) " +
      "ON CONFLICT(user_id) DO UPDATE SET platform=excluded.platform, display_name=excluded.display_name, handle=excluded.handle, updated_at=excluded.updated_at",
    [userId, platform, displayName, handle, updatedAt]
  );
}

async function getChannelCache(channelId) {
  return dbGet(
    "SELECT channel_id, platform, name, is_private FROM channel_cache WHERE channel_id = ?",
    "SELECT channel_id, platform, name, is_private FROM channel_cache WHERE channel_id = $1",
    [channelId]
  );
}

async function upsertChannelCache(
  channelId,
  platform,
  name,
  isPrivate,
  updatedAt
) {
  return dbRun(
    "INSERT INTO channel_cache (channel_id, platform, name, is_private, updated_at) VALUES (?, ?, ?, ?, ?) " +
      "ON CONFLICT(channel_id) DO UPDATE SET platform=excluded.platform, name=excluded.name, is_private=excluded.is_private, updated_at=excluded.updated_at",
    "INSERT INTO channel_cache (channel_id, platform, name, is_private, updated_at) VALUES ($1, $2, $3, $4, $5) " +
      "ON CONFLICT(channel_id) DO UPDATE SET platform=excluded.platform, name=excluded.name, is_private=excluded.is_private, updated_at=excluded.updated_at",
    [channelId, platform, name, isPrivate, updatedAt]
  );
}

module.exports = {
  initDb,
  isPostgres,
  saveGame,
  deleteGame,
  loadAllGames,
  getUserLang,
  setUserLang,
  getChannelPref,
  upsertChannelPref,
  listListedChannels,
  listOwnedChannels,
  getAppState,
  setAppState,
  getUserStats,
  upsertUserStats,
  getUserChannelStats,
  upsertUserChannelStats,
  getUserRoleStats,
  upsertUserRoleStats,
  listUserRoleStats,
  getUserCache,
  upsertUserCache,
  getChannelCache,
  upsertChannelCache,
};
