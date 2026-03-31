
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const http = require("http");
const { App, LogLevel } = require("@slack/bolt");
const { Telegraf, Markup } = require("telegraf");
const db = require("./db");

const REQUIRED_ENV = [
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "SLACK_SIGNING_SECRET",
];

const missingEnv = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missingEnv.length > 0) {
  console.error(`Missing required env vars: ${missingEnv.join(", ")}`);
  process.exit(1);
}

const DEFAULTS = {
  MIN_PLAYERS: 4,
  DAY_MINUTES: Number(process.env.DAY_DURATION_MINUTES) || 5,
  NIGHT_MINUTES: Number(process.env.NIGHT_DURATION_MINUTES) || 2,
  LOBBY_MINUTES: Number(process.env.LOBBY_DURATION_MINUTES) || 5,
  WARNINGS_MS: [60000, 30000],
  EXTEND_POLICY: "host",
  LOBBY_EXTEND_MINUTES: 2,
  AUTO_SHORTEN: true,
  WHISPER_ENABLED: true,
  ALLOW_ABSTAIN: true,
  ALLOW_NO_KILL: true,
  DOCTOR_SELF_SAVE_LIMIT: 1,
};
const DEV_USER_ID = process.env.DEV_USER_ID || "";
const DEV_CODE = process.env.DEV_CODE || "";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_WEBHOOK_DOMAIN = process.env.TELEGRAM_WEBHOOK_DOMAIN || "";
const TELEGRAM_WEBHOOK_PATH = process.env.TELEGRAM_WEBHOOK_PATH || "/telegram";
const ASSET_BASE_URL = (process.env.ASSET_BASE_URL || process.env.RENDER_EXTERNAL_URL || "")
  .trim()
  .replace(/\/+$/, "");
const KEEP_ALIVE_URL = (process.env.KEEP_ALIVE_URL || "").trim();
const KEEP_ALIVE_INTERVAL_MINUTES =
  Number(process.env.KEEP_ALIVE_INTERVAL_MINUTES) || 10;
const PORT = Number(process.env.PORT) || 3000;
const SLACK_PORT = Number(process.env.SLACK_PORT);
const BUTTON_PAGE_SIZE = 10;
const BUTTONS_PER_ROW = 5;
const FIND_PAGE_SIZE = 5;
const MY_CHANNELS_PAGE_SIZE = 5;
const FAQ_PAGE_SIZE = 8;
const LAST_WORDS_TIMEOUT_MS = 2 * 60 * 1000;
const PHASE_SHORTEN_THRESHOLD = 0.7;
const PHASE_SHORTEN_REMAINING_MS = 60000;
const SPECIAL_TARGETS = {
  ABSTAIN: "__abstain__",
  NO_KILL: "__no_kill__",
};
const TEST_ID_PREFIX = "test:";
const PLATFORM_SLACK = "slack";
const PLATFORM_TELEGRAM = "tg";
const ASSETS_DIR = path.join(__dirname, "..", "assets");
const ASSET_FILES = {
  mafia: "Mafia.jpg",
  peace: "Peace.jpg",
  icon: "icon.jpg",
  day: "day.mp4",
  night: "night.mp4",
};

const LANGS = ["en", "ru"];
const DEFAULT_LANG = "en";

let telegramBot = null;
let telegramMode = "disabled";
let healthServer = null;
const tgUserCache = new Map();
const tgChatCache = new Map();
const tgHandleCache = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startHealthServer() {
  if (healthServer) return;
  if (!Number.isFinite(PORT) || PORT <= 0) return;
  healthServer = http.createServer((req, res) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      if (url.pathname.startsWith("/assets/")) {
        if (req.method !== "GET" && req.method !== "HEAD") {
          res.statusCode = 405;
          res.end("Method Not Allowed");
          return;
        }
        const fileName = path.basename(url.pathname);
        const filePath = path.join(ASSETS_DIR, fileName);
        if (!filePath.startsWith(ASSETS_DIR)) {
          res.statusCode = 403;
          res.end("Forbidden");
          return;
        }
        if (!fs.existsSync(filePath)) {
          res.statusCode = 404;
          res.end("Not Found");
          return;
        }
        const ext = path.extname(filePath).toLowerCase();
        const contentType =
          ext === ".jpg" || ext === ".jpeg"
            ? "image/jpeg"
            : ext === ".png"
            ? "image/png"
            : ext === ".mp4"
            ? "video/mp4"
            : "application/octet-stream";
        res.statusCode = 200;
        res.setHeader("Content-Type", contentType);
        if (req.method === "HEAD") {
          res.end();
          return;
        }
        fs.createReadStream(filePath).pipe(res);
        return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("OK");
    } catch (err) {
      res.statusCode = 500;
      res.end("Server Error");
    }
  });
  healthServer.listen(PORT, () => {
    console.log(`Health server listening on port ${PORT}.`);
  });
}

function startKeepAlive() {
  if (!KEEP_ALIVE_URL) return;
  let url;
  try {
    url = new URL(KEEP_ALIVE_URL);
  } catch {
    console.warn("KEEP_ALIVE_URL is invalid. Skipping keep-alive.");
    return;
  }
  const intervalMs = Math.max(1, KEEP_ALIVE_INTERVAL_MINUTES) * 60 * 1000;
  const lib = url.protocol === "https:" ? require("https") : require("http");
  const ping = () => {
    try {
      const req = lib.request(url, { method: "GET" }, (res) => {
        res.resume();
      });
      req.on("error", () => {});
      req.end();
    } catch {
      // ignore
    }
  };
  ping();
  setInterval(ping, intervalMs).unref?.();
  console.log(`Keep-alive enabled: ${KEEP_ALIVE_URL} every ${KEEP_ALIVE_INTERVAL_MINUTES} min.`);
}

function parsePlatformKey(key) {
  if (!key) return { platform: null, id: key, key };
  const raw = String(key);
  if (raw.startsWith(TEST_ID_PREFIX)) {
    return { platform: "test", id: raw, key: raw };
  }
  const match = raw.match(/^([a-z]+):(.*)$/);
  if (match && (match[1] === PLATFORM_SLACK || match[1] === PLATFORM_TELEGRAM)) {
    return { platform: match[1], id: match[2], key: raw };
  }
  return { platform: PLATFORM_SLACK, id: raw, key: raw };
}

function makeUserKey(platform, id) {
  if (id === null || id === undefined) return id;
  const raw = String(id);
  if (raw.startsWith(TEST_ID_PREFIX)) return raw;
  return `${platform}:${raw}`;
}

function makeChannelKey(platform, id) {
  if (id === null || id === undefined) return id;
  const raw = String(id);
  return `${platform}:${raw}`;
}

function stripPlatformPrefix(key) {
  return parsePlatformKey(key).id;
}

function getPlatformFromKey(key) {
  return parsePlatformKey(key).platform;
}

function isTelegramKey(key) {
  if (!key) return false;
  if (getPlatformFromKey(key) === PLATFORM_TELEGRAM) return true;
  const raw = String(key);
  return /^-?\d+$/.test(raw);
}

function getTelegramMessageId(value) {
  if (!value) return null;
  const str = String(value);
  if (!str.startsWith("tg:")) return null;
  const id = Number(str.slice(3));
  return Number.isFinite(id) ? id : null;
}

function setTelegramMessageId(value) {
  if (value === null || value === undefined) return null;
  return `tg:${value}`;
}

const I18N = {
  en: {
    role: {
      mafia: ":mafia: Mafia" ,
      doctor: ":doctor: Doctor" ,
      detective: ":detective: Detective" ,
      mayor: ":mayor: Mayor" ,
      bodyguard: ":bodyguard: Bodyguard" ,
      town: ":town: Townsperson" ,
      jester: ":jester: Jester" ,
      godfather: ":godfather: Godfather" ,
      lucky: ":lucky: Lucky" ,
      bum: ":bum: Bum" ,
      sergeant: ":sergeant: Sergeant" ,
      lawyer: ":lawyer: Lawyer" ,
      stalker: ":stalker: Stalker" ,
    },
    role_help: {
      mafia:
        ":mafia: You are Mafia. Coordinate at night, choose a target, and reach parity with the town." ,
      godfather:
        ":godfather: You are the Godfather. You are mafia, but the Detective sees you as Town." ,
      doctor:
        ":doctor: You are the Doctor. Each night choose someone to save from death (including yourself within the limit)." ,
      detective:
        ":detective: You are the Detective. Each night you can either check a player or kill a target (only one action)." ,
      mayor:
        ":mayor: You are the Mayor. Your vote counts as 2 during the day." ,
      bodyguard:
        ":bodyguard: You are the Bodyguard. Choose a player to protect; if mafia attacks them, you take the hit." ,
      jester:
        ":jester: You are the Jester. If you are executed by vote, you win instantly." ,
      town:
        ":town: You are a Townsperson. Find mafia and vote them out." ,
      lucky:
        ":lucky: You are Lucky. Each night you have a 50% chance to survive any killing attempt." ,
      bum:
        ":bum: You are the Bum. Visit someone at night; if they die, you witness who killed them." ,
      sergeant:
        ":sergeant: You are the Sergeant. The Detective shares results with you. If the Detective dies, you get their actions." ,
      lawyer:
        ":lawyer: You are the Lawyer. At night protect a player; if you protect mafia, the Detective sees them as Town. Your goal is mafia victory." ,
      stalker:
        ":stalker: You are the Stalker. You have a contract on a role. Kill that role yourself to score a win." ,
    },
    time: {
      sec: ":timer: {seconds} sec" ,
      min: ":timer: {minutes} min" ,
      min_sec: ":timer: {minutes} min {seconds} sec" ,
    },
    button: {
      join: ":join: Join" ,
      leave: ":leave: Leave" ,
      start: ":start: Start" ,
      extend: ":extend: Extend +2m" ,
      end: ":end: End" ,
      ready: ":ready: Ready" ,
      abstain: ":abstain: Abstain" ,
      no_kill: ":no_kill: No kill" ,
      role_help: ":help: What to do?" ,
      detective_check: ":check: Check" ,
      detective_kill: ":kill: Kill" ,
      prev: ":prev: Prev" ,
      next: ":next: Next" ,
      page: ":page: Page {page}/{total}" ,
      help_add: ":help: Add bot" ,
      help_commands: ":help: Commands" ,
      help_settings: ":settings: Settings" ,
      find_games: ":find: Find games" ,
      my_channels: ":card_index_dividers: My channels" ,
      faq: ":question: FAQ" ,
      back: ":back: Back" ,
      public: ":public: Public" ,
      private: ":private: Private" ,
      filter_active: ":active: Active" ,
      filter_recruiting: ":recruiting: Recruiting" ,
      filter_inactive: ":inactive: Inactive" ,
      filter_lang_all: ":globe_with_meridians: All" ,
      filter_lang_en: ":globe_with_meridians: ENG" ,
      filter_lang_ru: ":globe_with_meridians: RU" ,
      lang_en: ":globe_with_meridians: English" ,
      lang_ru: ":globe_with_meridians: Russian" ,
    },
    dashboard: {
      title: ":dashboard: Game Dashboard" ,
      phase: ":phase: Phase: {phase}" ,
      timer: ":timer: Timer: {time}" ,
      alive: ":alive: Alive ({count}): {list}" ,
      ready: ":ready: Ready: {ready}/{total}" ,
    },
    home: {
      title: ":mafia: MafiaBot" ,
      tagline: ":home: Your Mafia game control center for Slack. (Developer: @bob)" ,
      quickstart:
        ":rocket: * Quick Start*\n"   +
        ":rocket: 1  Add me to a channel: `/invite @MafiaBot`\n"   +
        ":rocket: 2  Create a lobby: `@MafiaBot create`\n"   +
        ":rocket: 3  Players press `Join`, host presses `Start` or everyone `Ready`" ,
      controls:
        ":card_index_dividers: * Lobby Controls*\n"   +
        ":card_index_dividers: - Buttons: `Join`, `Leave`, `Ready`, `Start`, `Extend`, `End`\n"   +
        ":speech_balloon: - Commands: `@MafiaBot join`, `leave`, `start`, `extend 2`, `status`, `config`" ,
      gameplay:
        ":speech_balloon: * During the Game*\n"   +
        ":night: - Night actions and day voting arrive in DM\n"   +
        ":speech_balloon: - `whisper <text>` in DM once per day\n"   +
        ":last_words: - If eliminated, you get one “last words” DM" ,
      features:
        ":mag_right: * Highlights*\n"   +
        ":mafia: - Roles: Mafia, Doctor, Detective, Mayor, Bodyguard, Jester, Godfather, Lucky, Bum, Sergeant, Lawyer, Stalker\n"   +
        ":timer: - Anonymous voting, auto-timers, saved state (SQLite)\n"   +
        ":graveyard: - Mafia room + graveyard (if permissions allow)" ,
      tips:
        ":bulb: * Tips*\n"   +
        ":mag_right: - If you have multiple games, include `#channel` in DM commands\n"   +
        ":globe_with_meridians: - Change language in DM: `lang en` / `lang ru`\n"   +
        ":settings: - Edit channel defaults in DM: `My channels`\n"   +
        ":question: - Open FAQ in DM: `FAQ`" ,
      stats_title: ":chart: Your stats" ,
      stats_line:
        ":chart: Games: {games} • Wins: {wins} • Losses: {losses} • Winrate: {rate}%" ,
      channel_stats_title: ":chart: This channel" ,
      channel_stats_line:
        ":chart: Games: {games} • Wins: {wins} • Losses: {losses} • Winrate: {rate}%" ,
      role_stats_title: ":chart: Role stats" ,
      role_stats_empty: ":chart: No role stats yet." ,
      current_title: ":phase: Current game" ,
      current_none: ":inactive: No active game." ,
      current_line:
        ":card_index_dividers: Channel: {channel}\n"   +
        ":phase: Phase: {phase}\n"   +
        ":timer: Timer: {time}\n"   +
        ":alive: Alive: {alive}\n"   +
        ":speech_balloon: You: {status}\n"   +
        ":card_index_dividers: Role: {role}" ,
      status_alive: ":alive: Alive" ,
      status_dead: ":skull: Eliminated" ,
      role_unknown: ":question: Unknown" ,
      history_title: ":night: Last 3 nights" ,
      history_empty: ":night: No night results yet." ,
      history_line: ":night: Night {round}: {text}" ,
    },
    find: {
      prompt_public: ":public: Make {channel} public in Find Games?" ,
      set_public: ":public: {channel} is now public in Find Games." ,
      set_private: ":private: {channel} is private and won't be listed." ,
      private_not_allowed: ":error: Private channels can't be listed in Find Games." ,
      title: ":find: Find games" ,
      empty: ":inactive: No channels match this filter." ,
      status_active: ":active: Active — {phase} {round} • Alive {alive}" ,
      status_recruiting: ":recruiting: Recruiting — {count}/{min}, starts in {time}" ,
      status_inactive: ":inactive: Inactive — no active game" ,
      filters: ":mag_right: Filter: "  ,
      filter_lang: ":globe_with_meridians: Language: "  ,
      lang_label_en: ":globe_with_meridians: ENG" ,
      lang_label_ru: ":globe_with_meridians: RU" ,
    },
    faq: {
      title: ":question: FAQ" ,
      intro:
        ":question: Choose a question below. You can also type `faq <id>` in DM to open a specific answer." ,
      id_label: ":question: FAQ ID: `faq {id}`" ,
      not_found: ":warn: Question not found. Showing FAQ list." ,
      command_open: ":help: Open the FAQ: "  ,
      command_detail: ":help: Open FAQ question `{id}`: "  ,
      open_button: ":question: Open FAQ" ,
    },
    my_channels: {
      title: ":card_index_dividers: My channels" ,
      empty: ":inactive: No channels yet." ,
      status_public: ":public: Public" ,
      status_private: ":private: Private" ,
      not_owner: ":lock: You are not the owner for this channel." ,
      saved: ":ok: Channel settings saved." ,
      edit_intro: ":settings: Editing {channel}" ,
    },
    settings: {
      title: ":settings: Channel settings" ,
      privacy_label: ":public: Find Games visibility" ,
      privacy_public: ":public: Public" ,
      privacy_private: ":private: Private" ,
      channel_lang: ":globe_with_meridians: Channel language" ,
      channel_lang_en: ":globe_with_meridians: English (ENG)" ,
      channel_lang_ru: ":globe_with_meridians: Russian (RU)" ,
      day_minutes: ":timer: Day minutes" ,
      night_minutes: ":timer: Night minutes" ,
      lobby_minutes: ":timer: Lobby minutes" ,
      min_players: ":alive: Minimum players" ,
      extend_policy: ":extend: Who can extend lobby?" ,
      extend_host: ":extend: Host only" ,
      extend_any: ":extend: Anyone" ,
      warning_1: ":warn: Warning #1 (sec)" ,
      warning_2: ":warn: Warning #2 (sec)" ,
      auto_shorten: ":timer: Auto-shorten phase" ,
      whisper_enabled: ":speech_balloon: Whisper enabled" ,
      allow_abstain: ":abstain: Allow abstain" ,
      allow_no_kill: ":no_kill: Allow no-kill" ,
      doctor_self_save: ":doctor: Self-save limit" ,
      toggle_on: ":ok: On" ,
      toggle_off: ":lock: Off" ,
      submit: ":ok: Save" ,
      cancel: ":back: Cancel" ,
      invalid_number: ":error: Enter a valid number." ,
      invalid_min_players: ":error: Min players must be at least 4." ,
      invalid_warning: ":error: Warnings must be > 0." ,
      invalid_self_save: ":error: Self-save limit must be >= 0." ,
    },
    dm: {
      lang_prompt:
        ":globe_with_meridians: Choose language below (English / Русский). You can change later with `lang en` / `lang ru`." ,
      lang_set_en: ":ok: Language set to English." ,
      lang_set_ru: ":ok: Language set to Russian." ,
      lang_usage: ":help: Usage: `lang en` or `lang ru`." ,
      lang_change_command:
        ":help: Language is already set. Change it with `lang en` / `lang ru`." ,
      help_intro_tg:
        ":wave: Hi! I'm MafiaBot for Telegram.\n"   +
        ":rocket: How to start:\n"   +
        ":rocket: 1) Add me to a group\n"   +
        ":rocket: 2) In group: `/create` to open a lobby\n"   +
        ":rocket: 3) Players `/join`, host `/start`\n"   +
        ":speech_balloon: DM: `whisper <text>` (once per day)\n"   +
        ":globe_with_meridians: Change language: `lang en` / `lang ru`.\n"   +
        ":mag_right: Use `/find` to browse public lobbies.\n"   +
        ":card_index_dividers: Use `/mychannels` to edit your channel settings.\n"   +
        ":question: Use `/faq` for common questions." ,
      help_add_tg:
        ":rocket: Add me to a Telegram group. Optional: give admin rights so I can delete messages from eliminated players." ,
      help_commands_tg:
        ":speech_balloon: Group commands: `/create`, `/join`, `/leave`, `/start`, `/extend 2`, `/status`, `/config`, `/end`" ,
      help_settings_tg:
        ":settings: Settings: use `/config` in the group, and `/mychannels` here to edit default channel settings." ,
      help_intro:
        ":wave: Hi! I'm MafiaBot.\n"   +
        ":rocket: How to start:\n"   +
        ":rocket: 1) Add me to a channel: `/invite @MafiaBot`\n"   +
        ":rocket: 2) Create a lobby: `@MafiaBot create` (or button)\n"   +
        ":rocket: 3) Players join with `Join`, host starts with `Start`\n"   +
        ":bulb: If you have multiple games, include the channel in DM: `vote @user #channel`\n"   +
        ":speech_balloon: DM: `whisper <text>` (once per day)\n"   +
        ":globe_with_meridians: Change language: `lang en` / `lang ru`.\n"   +
        ":mag_right: Use `Find games` to browse public lobbies.\n"   +
        ":card_index_dividers: Use `My channels` to edit your channel settings.\n"   +
        ":question: Use `FAQ` for common questions." ,
      help_add:
        ":rocket: To add me to a channel:\n"   +
        ":rocket: 1) Open the channel\n"   +
        ":rocket: 2) Type `/invite @MafiaBot`\n"   +
        ":start: Then create a lobby with `@MafiaBot create` or the button." ,
      help_commands:
        ":speech_balloon: Channel commands:\n"   +
        ":speech_balloon: - `@MafiaBot create` — create lobby\n"   +
        ":speech_balloon: - `@MafiaBot join` / `leave`\n"   +
        ":speech_balloon: - `@MafiaBot start` — start (host)\n"   +
        ":speech_balloon: - `@MafiaBot extend 2` — extend lobby\n"   +
        ":speech_balloon: - `@MafiaBot status`, `config`, `end`\n"   +
        ":speech_balloon: DM: `whisper <text>` (once per day)\n"   +
        ":globe_with_meridians: Change language: `lang en` / `lang ru`.\n"   +
        ":find: Find games: use the `Find games` button in DM.\n"   +
        ":card_index_dividers: My channels: `mychannels` in DM.\n"   +
        ":card_index_dividers: My channels: use the `My channels` button in DM.\n"   +
        ":question: FAQ: use the `FAQ` button in DM." ,
      help_settings:
        ":settings: Settings (lobby only):\n"   +
        ":timer: - `@MafiaBot config day 5`\n"   +
        ":timer: - `@MafiaBot config night 2`\n"   +
        ":timer: - `@MafiaBot config lobby 5`\n"   +
        ":alive: - `@MafiaBot config min 4`\n"   +
        ":extend: - `@MafiaBot config extend host|any`\n"   +
        ":globe_with_meridians: Change language: `lang en` / `lang ru`.\n"   +
        ":find: Find games: use the `Find games` button in DM.\n"   +
        ":card_index_dividers: My channels: use the `My channels` button in DM.\n"   +
        ":question: FAQ: use the `FAQ` button in DM." ,
    },
    dev: {
      panel: {
        title: ":hammer_and_wrench: Dev panel" ,
        status_on: ":maint: Maintenance: ON" ,
        status_off: ":maint: Maintenance: OFF" ,
        button_enable: ":maint: Enable maintenance" ,
        button_disable: ":maint: Disable maintenance" ,
      },
      not_authorized: ":lock: You are not authorized to use developer commands." ,
      code_invalid: ":error: Invalid developer code." ,
      help: ":hammer_and_wrench: Dev: `dev <code>` • `test setup #channel Alice,Bob` • `as Alice vote Bob`" ,
    },
    maintenance: {
      reply: ":maint: MafiaBot is updating and will be back soon." ,
      blocked: ":maint: MafiaBot is updating. New lobbies are temporarily disabled." ,
      lobby_closed: ":maint: Lobby closed due to maintenance." ,
      done: ":maint: All active games finished. You can update the bot now." ,
    },
    last_words: {
      prompt:
        ":last_words: You are eliminated. Send one last message within 2 minutes. It will be posted in {channel}." ,
      received: ":last_words: Your last words were posted." ,
      expired: ":last_words: Time is up. Last words were not sent." ,
      post: ":last_words: Last words from {name}: {text}" ,
    },
    dead: {
      no_talk: ":lock: You are eliminated and cannot speak in this channel." ,
      message_deleted: ":lock: You are eliminated and cannot speak in this channel." ,
    },
    graveyard: {
      unavailable:
        ":graveyard: Graveyard channel is unavailable (missing permission to create/invite)." ,
    },
    mafia_room: {
      intro: ":mafia: Mafia room created. Discuss here during the night." ,
    },
    whisper: {
      usage: ":speech_balloon: Usage: `whisper <text>`" ,
      not_day: ":warn: Whisper is only available during the day." ,
      disabled: ":lock: Whisper is disabled for this channel." ,
      already_used: ":warn: You already used a whisper this day." ,
      sent: ":ok: Your whisper was sent anonymously." ,
      post: ":speech_balloon: Anonymous whisper: {text}" ,
    },
    lobby: {
      title: ":mafia: Mafia lobby" ,
      host: ":card_index_dividers: Host: {host}" ,
      players: ":alive: Players: {count}/{min}" ,
      ready: ":ready: Ready: {ready}/{total}" ,
      start_in: ":timer: Starts in: {time}" ,
      player_list: ":card_index_dividers: Party: {list}" ,
      created:
        ":recruiting: Lobby created. Host: {host}. Join with `@MafiaBot join` or the button." ,
      joined: ":recruiting: {user} joined. Players: {count}" ,
      left: ":recruiting: {user} left. Players: {count}" ,
      empty_closed: ":warn: Lobby is empty. Game removed." ,
      closed_not_enough:
        ":warn: Lobby closed: need at least {min} players, now {count}." ,
      timeout_start: ":start: Lobby time ended. Starting game!" ,
      host_start: ":start: Host started the game." ,
      ready_start: ":ready: All players are ready. Starting game!" ,
      extended: ":extend: Lobby extended by {minutes} min." ,
      closed: ":end: Lobby closed." ,
      starting: ":start: Lobby closed. Game starting." ,
      end: ":end: Game ended." ,
      panel_summary: ":card_index_dividers: Lobby players {count}/{min}." ,
    },
    warn: {
      day: ":warn: Day ends in {seconds} sec." ,
      night: ":warn: Night ends in {seconds} sec." ,
      lobby: ":warn: Lobby auto-start in {seconds} sec." ,
      shortened_day: ":warn: Day shortened due to high activity." ,
      shortened_night: ":warn: Night shortened due to high activity." ,
    },
    reminder: {
      night_action: ":night: Night action"  ,
      vote: ":vote: Vote"  ,
      text: ":warn: Reminder: finish {action} for the game in {channel}." ,
    },
    phase: {
      night_start: ":night: Night {round}. The city falls silent as shadows move..." ,
      day_start: ":day: Day {round}. The city wakes to whispers and suspicion..." ,
      card_title_night: ":night: Night {round}" ,
      card_title_day: ":day: Day {round}" ,
      card_stats: ":alive: Alive {alive} • :timer: {time}" ,
    },
    night: {
      ended_killed: ":night: Night is over. Killed: {targets}." ,
      ended_none: ":night: Night is over. Nobody died." ,
      bodyguard: ":bodyguard: Bodyguard took the hit." ,
    },
    day: {
      ended_executed: ":day: Voting ended. Executed: {target} ({role})." ,
      ended_tie: ":day: Voting ended. Tie — nobody executed." ,
    },
    auto: {
      applied: ":ok: Auto actions applied." ,
    },
    winner: {
      mafia: ":mafia: Mafia wins!" ,
      town: ":town: Town wins!" ,
      jester: ":jester: Jester wins!" ,
      summary: ":trophy: {winner}\n:mafia: Mafia: {mafia}\n:town: Town: {town}" ,
      summary_jester: ":trophy: {winner}\n:jester: Jester: {jester}\n:mafia: Mafia: {mafia}\n:town: Town: {town}" ,
    },
    prompt: {
      mafia: ":mafia: Game in {channel}. Who should be killed?" ,
      doctor: ":doctor: Game in {channel}. Who should be saved tonight?" ,
      detective_mode: ":detective: Choose your action for tonight."  ,
      detective: ":detective: Game in {channel}. Who should be checked?" ,
      detective_kill: ":kill: Game in {channel}. Who should be killed?" ,
      bodyguard: ":bodyguard: Game in {channel}. Who should be protected?" ,
      bum: ":bum: Game in {channel}. Who should be visited tonight?" ,
      lawyer: ":lawyer: Game in {channel}. Who should be protected?" ,
      stalker: ":stalker: Contract role: {role}. Who should be killed?" ,
      day: ":vote: Game in {channel}. Who should be eliminated today?" ,
    },
    select: {
      player: ":mag_right: Select a player" ,
      target: ":mag_right: Select a target" ,
    },
    help: {
      commands:
        ":help: Commands: create, join, leave, start, status, end, config, extend. Voting and night actions are in DM." ,
    },
    config: {
      summary:
        ":settings: Settings: day={day}m, night={night}m, lobby={lobby}m, min={min}, extend={extend}" ,
    },
    status: {
      text: ":phase: Status: {state}. Host: {host}. Alive: {alive}" ,
    },
    state: {
      lobby: ":recruiting: lobby" ,
      day: ":day: day" ,
      night: ":night: night" ,
      ended: ":inactive: ended" ,
    },
    err: {
      channel_unknown: ":error: Could not determine channel." ,
      already_in_other: ":error: You are already in a lobby or game in {channel}." ,
      lobby_not_active: ":error: Lobby is not active." ,
      lobby_exists: ":error: A lobby already exists in this channel." ,
      lobby_none: ":error: No lobby right now. Create: @MafiaBot create" ,
      already_in: ":error: You are already in the game." ,
      lobby_only: ":error: You can leave only in the lobby." ,
      not_in_lobby: ":error: You are not in the lobby." ,
      lobby_start_none: ":error: No active lobby to start." ,
      only_host_start: ":error: Only the host can start the game." ,
      need_min_players: ":error: Need at least {min} players." ,
      game_not_created: ":error: Game not created." ,
      config_lobby_only: ":error: Configuration is only available in the lobby." ,
      config_host_only: ":error: Only the host can configure the game." ,
      config_usage_extend: ":error: Usage: @MafiaBot config extend host|any" ,
      config_usage_numbers:
        ":error: Usage: @MafiaBot config day 5 | night 2 | lobby 5 | min 4" ,
      config_options: ":error: Available settings: day, night, lobby, min, extend" ,
      extend_lobby_only: ":error: You can extend only in the lobby." ,
      extend_not_allowed: ":error: Only the host or an allowed participant can extend." ,
      no_active_game: ":error: No active game." ,
      only_host_end: ":error: Only the host can end the game." ,
      unknown_command: ":error: Unknown command. Type @MafiaBot help" ,
    },
    ok: {
      settings_updated: ":ok: Settings updated." ,
    },
    action: {
      role_dm: ":card_index_dividers: Your role in the game {channel}: *{role}*." ,
      failed: ":error: Failed to process selection." ,
      game_ended: ":inactive: Game already ended." ,
      not_in_game: ":lock: You are not in the game or you are eliminated." ,
      not_day: ":warn: It is not day now." ,
      choose_alive: ":alive: Choose a living player." ,
      already_acted: ":lock: You already acted this phase." ,
      already_voted: ":lock: Your vote is already locked." ,
      vote_recorded: ":vote: Your vote recorded: {target}." ,
      vote_abstain: ":abstain: You abstained." ,
      not_night: ":warn: It is not night now." ,
      mafia_only: ":error: :mafia: Only mafia can do that." ,
      no_mafia_target: ":warn: You cannot choose mafia." ,
      choice_recorded: ":ok: Your choice: {target}." ,
      no_kill: ":no_kill: Your choice: no kill." ,
      doctor_only: ":error: :doctor: Only the doctor can do that." ,
      detective_only: ":error: :detective: Only the detective can do that." ,
      bodyguard_only: ":error: :bodyguard: Only the bodyguard can do that." ,
      bum_only: ":error: :bum: Only the Bum can do that." ,
      lawyer_only: ":error: :lawyer: Only the Lawyer can do that." ,
      stalker_only: ":error: :stalker: Only the Stalker can do that." ,
      doctor_self_save_limit: ":lock: You can only save yourself once per game." ,
      doctor_save: ":doctor: You save: {target}." ,
      detective_check: ":detective: You check: {target}." ,
      detective_kill: ":kill: You kill: {target}." ,
      detective_result: ":check: Check result: {target} is {result}." ,
      bodyguard_protect: ":bodyguard: You protect: {target}." ,
      bum_visit: ":bum: You visit: {target}." ,
      lawyer_protect: ":lawyer: You protect: {target}." ,
      stalker_kill: ":stalker: You hunt: {target}." ,
      result_mafia: ":mafia: mafia" ,
      result_not_mafia: ":town: not mafia" ,
    },
    bum: {
      witness: ":bum: You witnessed a murder: {killer} killed {victim}." ,
      nothing: ":bum: You saw nothing tonight." ,
    },
    stalker: {
      target_assigned: ":stalker: Your contract role: {role}." ,
      success: ":trophy: Contract completed! Wins: {wins}. New target: {role}." ,
      failed: ":warn: Contract failed. New target: {role}." ,
      no_targets: ":inactive: No available roles to target right now." ,
    },
    sergeant: {
      promoted: ":sergeant: The Detective is dead. You take over their actions." ,
      info: ":detective: Detective result: {target} is {result}." ,
    },
    dm_cmd: {
      no_game: ":inactive: No active game for this command." ,
      need_alive: ":alive: You must mention a living player." ,
      day_only: ":warn: Day actions are only available during the day." ,
      night_only: ":warn: Night actions are only available at night." ,
      mafia_only: ":error: :mafia: Only mafia can do that." ,
      no_mafia_target: ":warn: You cannot choose mafia." ,
      abstain_disabled: ":lock: Abstain is disabled in this channel." ,
      no_kill_disabled: ":lock: No-kill is disabled in this channel." ,
      doctor_only: ":error: :doctor: Only the doctor can do that." ,
      detective_only: ":error: :detective: Only the detective can do that." ,
      bodyguard_only: ":error: :bodyguard: Only the bodyguard can do that." ,
      bum_only: ":error: :bum: Only the Bum can do that." ,
      lawyer_only: ":error: :lawyer: Only the Lawyer can do that." ,
      stalker_only: ":error: :stalker: Only the Stalker can do that." ,
      doctor_self_save_limit: ":lock: You can only save yourself once per game." ,
      vote_recorded: ":vote: Your vote recorded: {target}." ,
      choice_recorded: ":ok: Your choice: {target}." ,
      doctor_save: ":doctor: You save: {target}." ,
      detective_check: ":detective: You check: {target}." ,
      detective_kill: ":kill: You kill: {target}." ,
      detective_result: ":check: Check result: {target} is {result}." ,
      result_mafia: ":mafia: mafia" ,
      result_not_mafia: ":town: not mafia" ,
      bodyguard_protect: ":bodyguard: You protect: {target}." ,
      bum_visit: ":bum: You visit: {target}." ,
      lawyer_protect: ":lawyer: You protect: {target}." ,
      stalker_kill: ":stalker: You hunt: {target}." ,
      unknown_command:
        ":help: Unknown command. Use kill/save/check/protect/visit/defend/stalk @user." ,
    },
    test: {
      not_dev: ":lock: Only the developer can use test commands." ,
      setup_usage: ":help: Usage: `test setup #channel Alice,Bob,Charlie`" ,
      list_usage: ":help: Usage: `test list #channel`" ,
      setup_ok:
        ":ok: Test lobby ready in {channel}. Players: {players}\n:help: Use: `as <name> <action>`." ,
      duplicate_names: ":warn: Duplicate test names: {names}." ,
      active_game: ":warn: Can't setup test mode during an active game." ,
      real_players: ":warn: Remove real players from the lobby before using test mode." ,
      no_game: ":inactive: No test game found. Use `test setup` or specify #channel." ,
      list: ":card_index_dividers: Test players in {channel}: {players}" ,
      as_usage: ":help: Usage: `as <name> <action> [target]`" ,
      actor_not_found: ":error: Test player `{name}` not found." ,
      target_not_found: ":error: Target not found: `{name}`." ,
      roles_summary: ":card_index_dividers: *Test roles* in {channel}:\n:card_index_dividers: {list}" ,
      actions_reminder_night:
        ":night: *Test actions (night)* in {channel}:\n:night: {list}\n:help: Use: `as <name> <action> <target>`" ,
      actions_reminder_day:
        ":day: *Test actions (day)* in {channel}:\n:day: {list}\n:help: Use: `as <name> vote <target>` or `as <name> abstain`" ,
    },
  },
  ru: {
    role: {
      mafia: ":mafia: Мафия" ,
      doctor: ":doctor: Доктор" ,
      detective: ":detective: Детектив" ,
      mayor: ":mayor: Мэр" ,
      bodyguard: ":bodyguard: Телохранитель" ,
      town: ":town: Мирный" ,
      jester: ":jester: Шут" ,
      godfather: ":godfather: Крёстный отец" ,
      lucky: ":lucky: Счастливчик" ,
      bum: ":bum: Бомж" ,
      sergeant: ":sergeant: Сержант" ,
      lawyer: ":lawyer: Адвокат" ,
      stalker: ":stalker: Сталкер" ,
    },
    role_help: {
      mafia:
        ":mafia: Ты — Мафия. Ночью выбирайте цель и добейтесь паритета с городом." ,
      godfather:
        ":godfather: Ты — Крёстный отец. Ты мафия, но Детектив видит тебя как мирного." ,
      doctor:
        ":doctor: Ты — Доктор. Ночью выбираешь кого спасти (включая себя в пределах лимита)." ,
      detective:
        ":detective: Ты — Детектив. Ночью можешь либо проверить игрока, либо убить цель (только одно действие)." ,
      mayor:
        ":mayor: Ты — Мэр. Твой дневной голос считается за 2." ,
      bodyguard:
        ":bodyguard: Ты — Телохранитель. Защищай цель; если мафия атакует её, ты принимаешь удар." ,
      jester:
        ":jester: Ты — Шут. Если тебя казнят голосованием — ты выигрываешь мгновенно." ,
      town:
        ":town: Ты — Мирный житель. Найди мафию и казни её днём." ,
      lucky:
        ":lucky: Ты — Счастливчик. Каждую ночь у тебя 50% шанс выжить при убийстве." ,
      bum:
        ":bum: Ты — Бомж. Ночью заходишь к игроку; если его убьют, ты увидишь убийцу." ,
      sergeant:
        ":sergeant: Ты — Сержант. Детектив делится с тобой результатами. Если детектив погибнет, ты получишь его действия." ,
      lawyer:
        ":lawyer: Ты — Адвокат. Ночью защищаешь игрока; если защищаешь мафию, детектив видит её как мирную. Твоя цель — победа мафии." ,
      stalker:
        ":stalker: Ты — Сталкер. У тебя контракт на роль. Убей цель лично, чтобы получить победу." ,
    },
    time: {
      sec: ":timer: {seconds} сек." ,
      min: ":timer: {minutes} мин." ,
      min_sec: ":timer: {minutes} мин {seconds} сек." ,
    },
    button: {
      join: ":join: Войти" ,
      leave: ":leave: Выйти" ,
      start: ":start: Старт" ,
      extend: ":extend: Продлить +2м" ,
      end: ":end: Завершить" ,
      ready: ":ready: Готов" ,
      abstain: ":abstain: Воздержаться" ,
      no_kill: ":no_kill: Не убивать" ,
      role_help: ":help: Что делать?" ,
      detective_check: ":check: Проверить" ,
      detective_kill: ":kill: Убить" ,
      prev: ":prev: Назад" ,
      next: ":next: Вперёд" ,
      page: ":page: Стр. {page}/{total}" ,
      help_add: ":help: Как добавить бота" ,
      help_commands: ":help: Команды" ,
      help_settings: ":settings: Настройки" ,
      find_games: ":find: Найти игры" ,
      my_channels: ":card_index_dividers: Мои каналы" ,
      faq: ":question: FAQ" ,
      back: ":back: Назад" ,
      public: ":public: Публичный" ,
      private: ":private: Частный" ,
      filter_active: ":active: Активные" ,
      filter_recruiting: ":recruiting: В наборе" ,
      filter_inactive: ":inactive: Не активные" ,
      filter_lang_all: ":globe_with_meridians: Все" ,
      filter_lang_en: ":globe_with_meridians: ENG" ,
      filter_lang_ru: ":globe_with_meridians: RU" ,
      lang_en: ":globe_with_meridians: English" ,
      lang_ru: ":globe_with_meridians: Русский" ,
    },
    dashboard: {
      title: ":dashboard: Панель игры" ,
      phase: ":phase: Фаза: {phase}" ,
      timer: ":timer: Таймер: {time}" ,
      alive: ":alive: Живые ({count}): {list}" ,
      ready: ":ready: Готовы: {ready}/{total}" ,
    },
    home: {
      title: ":mafia: MafiaBot" ,
      tagline: ":home: Ваш центр управления мафией в Slack. (Разработчик: @bob)" ,
      quickstart:
        ":rocket: * Быстрый старт*\n"   +
        ":rocket: 1  Добавьте меня в канал: `/invite @MafiaBot`\n"   +
        ":rocket: 2  Создайте лобби: `@MafiaBot create`\n"   +
        ":rocket: 3  Игроки жмут `Join`, хост жмёт `Start` или все `Ready`" ,
      controls:
        ":card_index_dividers: * Управление лобби*\n"   +
        ":card_index_dividers: - Кнопки: `Join`, `Leave`, `Ready`, `Start`, `Extend`, `End`\n"   +
        ":speech_balloon: - Команды: `@MafiaBot join`, `leave`, `start`, `extend 2`, `status`, `config`" ,
      gameplay:
        ":speech_balloon: * Во время игры*\n"   +
        ":night: - Ночные действия и дневное голосование приходят в личку\n"   +
        ":speech_balloon: - `whisper <текст>` в личке раз в день\n"   +
        ":last_words: - После смерти есть «последние слова» в личке" ,
      features:
        ":mag_right: * Возможности*\n"   +
        ":mafia: - Роли: Мафия, Доктор, Детектив, Мэр, Телохранитель, Шут, Крёстный отец, Счастливчик, Бомж, Сержант, Адвокат, Сталкер\n"   +
        ":timer: - Анонимные голосования, авто-таймеры, сохранение в SQLite\n"   +
        ":graveyard: - Комната мафии + кладбище (если есть права)" ,
      tips:
        ":bulb: * Подсказки*\n"   +
        ":mag_right: - Если несколько игр, указывайте `#channel` в личных командах\n"   +
        ":globe_with_meridians: - Смена языка в личке: `lang en` / `lang ru`\n"   +
        ":settings: - Редактирование настроек: `Мои каналы` в личке\n"   +
        ":question: - Открыть FAQ: `FAQ` в личке" ,
      stats_title: ":chart: Ваша статистика" ,
      stats_line:
        ":chart: Игры: {games} • Победы: {wins} • Поражения: {losses} • Винрейт: {rate}%" ,
      channel_stats_title: ":chart: В этом канале" ,
      channel_stats_line:
        ":chart: Игры: {games} • Победы: {wins} • Поражения: {losses} • Винрейт: {rate}%" ,
      role_stats_title: ":chart: Статистика по ролям" ,
      role_stats_empty: ":chart: Пока нет статистики по ролям." ,
      current_title: ":phase: Текущая игра" ,
      current_none: ":inactive: Активной игры нет." ,
      current_line:
        ":card_index_dividers: Канал: {channel}\n"   +
        ":phase: Фаза: {phase}\n"   +
        ":timer: Таймер: {time}\n"   +
        ":alive: Живые: {alive}\n"   +
        ":speech_balloon: Вы: {status}\n"   +
        ":card_index_dividers: Роль: {role}" ,
      status_alive: ":alive: Жив" ,
      status_dead: ":skull: Выбыли" ,
      role_unknown: ":question: Неизвестно" ,
      history_title: ":night: Последние 3 ночи" ,
      history_empty: ":night: Пока нет итогов ночи." ,
      history_line: ":night: Ночь {round}: {text}" ,
    },
    find: {
      prompt_public: ":public: Сделать {channel} публичным в «Найти игры»?" ,
      set_public: ":public: {channel} теперь публичный в «Найти игры»." ,
      set_private: ":private: {channel} приватный и не будет отображаться." ,
      private_not_allowed:
        ":error: Приватные каналы нельзя показывать в «Найти игры»." ,
      title: ":find: Найти игры" ,
      empty: ":inactive: Нет каналов для этого фильтра." ,
      status_active: ":active: Активна — {phase} {round} • Живых {alive}" ,
      status_recruiting: ":recruiting: В наборе — {count}/{min}, старт через {time}" ,
      status_inactive: ":inactive: Не активна — игра не идёт" ,
      filters: ":mag_right: Фильтр: "  ,
      filter_lang: ":globe_with_meridians: Язык: "  ,
      lang_label_en: ":globe_with_meridians: ENG" ,
      lang_label_ru: ":globe_with_meridians: RU" ,
    },
    faq: {
      title: ":question: FAQ" ,
      intro:
        ":question: Выберите вопрос ниже. Можно написать в личку `faq <id>`, чтобы открыть конкретный ответ." ,
      id_label: ":question: FAQ ID: `faq {id}`" ,
      not_found: ":warn: Вопрос не найден. Открываю список FAQ." ,
      command_open: ":help: Открыть FAQ: "  ,
      command_detail: ":help: Открыть вопрос FAQ `{id}`: "  ,
      open_button: ":question: Открыть FAQ" ,
    },
    my_channels: {
      title: ":card_index_dividers: Мои каналы" ,
      empty: ":inactive: Пока нет каналов." ,
      status_public: ":public: Публичный" ,
      status_private: ":private: Частный" ,
      not_owner: ":lock: Вы не владелец этого канала." ,
      saved: ":ok: Настройки канала сохранены." ,
      edit_intro: ":settings: Настройка {channel}" ,
    },
    settings: {
      title: ":settings: Настройки канала" ,
      privacy_label: ":public: Видимость в «Найти игры»" ,
      privacy_public: ":public: Публичный" ,
      privacy_private: ":private: Частный" ,
      channel_lang: ":globe_with_meridians: Язык канала" ,
      channel_lang_en: ":globe_with_meridians: English (ENG)" ,
      channel_lang_ru: ":globe_with_meridians: Русский (RU)" ,
      day_minutes: ":timer: День (мин.)" ,
      night_minutes: ":timer: Ночь (мин.)" ,
      lobby_minutes: ":timer: Лобби (мин.)" ,
      min_players: ":alive: Минимум игроков" ,
      extend_policy: ":extend: Кто может продлевать?" ,
      extend_host: ":extend: Только хост" ,
      extend_any: ":extend: Все" ,
      warning_1: ":warn: Предупреждение #1 (сек.)" ,
      warning_2: ":warn: Предупреждение #2 (сек.)" ,
      auto_shorten: ":timer: Автосокращение фазы" ,
      whisper_enabled: ":speech_balloon: Шёпот включён" ,
      allow_abstain: ":abstain: Разрешить воздержание" ,
      allow_no_kill: ":no_kill: Разрешить «без убийства»" ,
      doctor_self_save: ":doctor: Лимит self-save" ,
      toggle_on: ":ok: Вкл" ,
      toggle_off: ":lock: Выкл" ,
      submit: ":ok: Сохранить" ,
      cancel: ":back: Отмена" ,
      invalid_number: ":error: Введите корректное число." ,
      invalid_min_players: ":error: Минимум игроков должен быть >= 4." ,
      invalid_warning: ":error: Предупреждения должны быть > 0." ,
      invalid_self_save: ":error: Лимит self-save должен быть >= 0." ,
    },
    dm: {
      lang_prompt:
        ":globe_with_meridians: Выберите язык кнопками ниже. Позже можно изменить командой `lang en` / `lang ru`." ,
      lang_set_en: ":ok: Language set to English." ,
      lang_set_ru: ":ok: Язык установлен: русский." ,
      lang_usage: ":help: Использование: `lang en` или `lang ru`." ,
      lang_change_command:
        ":help: Язык уже установлен. Измените его командой `lang en` / `lang ru`." ,
      help_intro_tg:
        ":wave: Привет! Я MafiaBot для Telegram.\n"   +
        ":rocket: Как начать:\n"   +
        ":rocket: 1) Добавьте меня в группу\n"   +
        ":rocket: 2) В группе: `/create` чтобы открыть лобби\n"   +
        ":rocket: 3) Игроки `/join`, хост `/start`\n"   +
        ":speech_balloon: Личка: `whisper <текст>` (раз в день)\n"   +
        ":globe_with_meridians: Смена языка: `lang en` / `lang ru`.\n"   +
        ":mag_right: Поиск игр: `/find` в личке.\n"   +
        ":card_index_dividers: Настройки канала: `/mychannels` в личке.\n"   +
        ":question: FAQ: `/faq` в личке." ,
      help_add_tg:
        ":rocket: Добавьте меня в Telegram-группу. По желанию дайте админ-права, чтобы удалять сообщения выбывших." ,
      help_commands_tg:
        ":speech_balloon: Команды в группе: `/create`, `/join`, `/leave`, `/start`, `/extend 2`, `/status`, `/config`, `/end`" ,
      help_settings_tg:
        ":settings: Настройки: `/config` в группе и `/mychannels` в личке для дефолтных параметров." ,
      help_intro:
        ":wave: Привет! Я MafiaBot.\n"   +
        ":rocket: Как начать:\n"   +
        ":rocket: 1) Добавьте меня в нужный канал: `/invite @MafiaBot`\n"   +
        ":rocket: 2) В канале создайте лобби: `@MafiaBot create` (или кнопка)\n"   +
        ":rocket: 3) Игроки заходят через `Join`, хост запускает `Start`\n"   +
        ":bulb: Если у вас несколько игр, указывайте канал в личке: `vote @user #channel`\n"   +
        ":speech_balloon: Личка: `whisper <текст>` (раз в день)\n"   +
        ":globe_with_meridians: Смена языка: `lang en` / `lang ru`.\n"   +
        ":mag_right: Поиск игр: кнопка `Найти игры` в личке.\n"   +
        ":card_index_dividers: `Мои каналы` — редактирование настроек.\n"   +
        ":question: `FAQ` — ответы на частые вопросы." ,
      help_add:
        ":rocket: Чтобы добавить меня в канал:\n"   +
        ":rocket: 1) Откройте нужный канал\n"   +
        ":rocket: 2) Напишите `/invite @MafiaBot`\n"   +
        ":start: Далее создайте лобби командой `@MafiaBot create` или кнопкой." ,
      help_commands:
        ":speech_balloon: Команды в канале:\n"   +
        ":speech_balloon: - `@MafiaBot create` — создать лобби\n"   +
        ":speech_balloon: - `@MafiaBot join` / `leave`\n"   +
        ":speech_balloon: - `@MafiaBot start` — старт (хост)\n"   +
        ":speech_balloon: - `@MafiaBot extend 2` — продлить лобби\n"   +
        ":speech_balloon: - `@MafiaBot status`, `config`, `end`\n"   +
        ":speech_balloon: Личка: `whisper <текст>` (раз в день)\n"   +
        ":globe_with_meridians: Смена языка: `lang en` / `lang ru`.\n"   +
        ":find: Поиск игр: кнопка `Найти игры` в личке.\n"   +
        ":card_index_dividers: Мои каналы: `mychannels` в личке.\n"   +
        ":card_index_dividers: Кнопка `Мои каналы` — редактирование настроек.\n"   +
        ":question: Кнопка `FAQ` — ответы на частые вопросы." ,
      help_settings:
        ":settings: Настройки (только в лобби):\n"   +
        ":timer: - `@MafiaBot config day 5`\n"   +
        ":timer: - `@MafiaBot config night 2`\n"   +
        ":timer: - `@MafiaBot config lobby 5`\n"   +
        ":alive: - `@MafiaBot config min 4`\n"   +
        ":extend: - `@MafiaBot config extend host|any`\n"   +
        ":globe_with_meridians: Смена языка: `lang en` / `lang ru`.\n"   +
        ":find: Поиск игр: кнопка `Найти игры` в личке.\n"   +
        ":card_index_dividers: Кнопка `Мои каналы` — редактирование настроек.\n"   +
        ":question: Кнопка `FAQ` — ответы на частые вопросы." ,
    },
    dev: {
      panel: {
        title: ":hammer_and_wrench: Панель разработчика" ,
        status_on: ":maint: Обновление: ВКЛ" ,
        status_off: ":maint: Обновление: ВЫКЛ" ,
        button_enable: ":maint: Включить обновление" ,
        button_disable: ":maint: Выключить обновление" ,
      },
      not_authorized: ":lock: У вас нет доступа к командам разработчика." ,
      code_invalid: ":error: Неверный код разработчика." ,
      help: ":hammer_and_wrench: Dev: `dev <code>` • `test setup #channel Alice,Bob` • `as Alice vote Bob`" ,
    },
    maintenance: {
      reply: ":maint: MafiaBot обновляется и скоро вернётся." ,
      blocked: ":maint: Идёт обновление. Новые лобби временно недоступны." ,
      lobby_closed: ":maint: Лобби закрыто из-за обновления." ,
      done: ":maint: Все активные игры завершены. Можно обновлять бота." ,
    },
    last_words: {
      prompt:
        ":last_words: Вы выбыли. Напишите одно последнее сообщение в течение 2 минут — оно будет опубликовано в {channel}." ,
      received: ":last_words: Ваши последние слова опубликованы." ,
      expired: ":last_words: Время вышло. Последние слова не отправлены." ,
      post: ":last_words: Последние слова от {name}: {text}" ,
    },
    dead: {
      no_talk: ":lock: Вы выбыли и не можете писать в этом канале." ,
      message_deleted: ":lock: Вы выбыли и не можете писать в этом канале." ,
    },
    graveyard: {
      unavailable:
        ":graveyard: Кладбище недоступно (нет прав на создание/приглашение)." ,
    },
    mafia_room: {
      intro: ":mafia: Мафия-комната создана. Обсуждайте здесь ночью." ,
    },
    whisper: {
      usage: ":speech_balloon: Использование: `whisper <текст>`" ,
      not_day: ":warn: Шёпот доступен только днём." ,
      disabled: ":lock: Шёпот отключён для этого канала." ,
      already_used: ":warn: Вы уже использовали шёпот сегодня." ,
      sent: ":ok: Ваш шёпот отправлен анонимно." ,
      post: ":speech_balloon: Анонимный шёпот: {text}" ,
    },
    lobby: {
      title: ":mafia: Лобби мафии" ,
      host: ":card_index_dividers: Хост: {host}" ,
      players: ":alive: Игроки: {count}/{min}" ,
      ready: ":ready: Готовы: {ready}/{total}" ,
      start_in: ":timer: Старт через: {time}" ,
      player_list: ":card_index_dividers: Состав: {list}" ,
      created:
        ":recruiting: Создано лобби. Хост: {host}. Присоединяйтесь через `@MafiaBot join` или кнопку." ,
      joined: ":recruiting: {user} присоединился. Игроков: {count}" ,
      left: ":recruiting: {user} вышел. Игроков: {count}" ,
      empty_closed: ":warn: Лобби пустое. Игра удалена." ,
      closed_not_enough:
        ":warn: Лобби закрыто: нужно минимум {min} игроков, сейчас {count}." ,
      timeout_start: ":start: Время лобби истекло. Начинаем игру!" ,
      host_start: ":start: Хост запускает игру." ,
      ready_start: ":ready: Все игроки готовы. Начинаем игру!" ,
      extended: ":extend: Лобби продлено на {minutes} мин." ,
      closed: ":end: Лобби закрыто." ,
      starting: ":start: Лобби закрыто. Игра стартует." ,
      end: ":end: Игра завершена." ,
      panel_summary: ":card_index_dividers: Лобби: игроков {count}/{min}." ,
    },
    warn: {
      day: ":warn: До конца дня осталось {seconds} сек." ,
      night: ":warn: До конца ночи осталось {seconds} сек." ,
      lobby: ":warn: До автозапуска лобби осталось {seconds} сек." ,
      shortened_day: ":warn: День сокращён из-за высокой активности." ,
      shortened_night: ":warn: Ночь сокращена из-за высокой активности." ,
    },
    reminder: {
      night_action: ":night: ночное действие"  ,
      vote: ":vote: голосование" ,
      text: ":warn: Напоминание: завершите {action} для игры в {channel}." ,
    },
    phase: {
      night_start: ":night: Ночь {round}. Город замирает, и тени оживают..." ,
      day_start: ":day: День {round}. Город просыпается в тревоге и шёпоте..." ,
      card_title_night: ":night: Ночь {round}" ,
      card_title_day: ":day: День {round}" ,
      card_stats: ":alive: Живые {alive} • :timer: {time}" ,
    },
    night: {
      ended_killed: ":night: Ночь окончена. Убиты: {targets}." ,
      ended_none: ":night: Ночь окончена. Никто не погиб." ,
      bodyguard: ":bodyguard: Телохранитель принял удар на себя." ,
    },
    day: {
      ended_executed: ":day: Голосование завершено. Казнен: {target} ({role})." ,
      ended_tie: ":day: Голосование завершено. Ничья, никто не казнен." ,
    },
    auto: {
      applied: ":ok: Автодействия применены." ,
    },
    winner: {
      mafia: ":mafia: Победа мафии!" ,
      town: ":town: Победа мирных!" ,
      jester: ":jester: Победа шута!" ,
      summary: ":trophy: {winner}\n:mafia: Мафия: {mafia}\n:town: Мирные: {town}" ,
      summary_jester: ":trophy: {winner}\n:jester: Шут: {jester}\n:mafia: Мафия: {mafia}\n:town: Мирные: {town}" ,
    },
    prompt: {
      mafia: ":mafia: Игра в {channel}. Кого убить?" ,
      doctor: ":doctor: Игра в {channel}. Кого вылечить этой ночью?" ,
      detective_mode: ":detective: Выберите действие на эту ночь."  ,
      detective: ":detective: Игра в {channel}. Кого проверить?" ,
      detective_kill: ":kill: Игра в {channel}. Кого застрелить?" ,
      bodyguard: ":bodyguard: Игра в {channel}. Кого защитить?" ,
      bum: ":bum: Игра в {channel}. К кому зайти этой ночью?" ,
      lawyer: ":lawyer: Игра в {channel}. Кого прикрыть?" ,
      stalker: ":stalker: Контракт: {role}. Кого устранить?" ,
      day: ":vote: Игра в {channel}. За кого голосовать сегодня?" ,
    },
    select: {
      player: ":mag_right: Выберите игрока" ,
      target: ":mag_right: Выберите цель" ,
    },
    help: {
      commands:
        ":help: Команды: create, join, leave, start, status, end, config, extend. Голосование и ночные действия приходят в личку." ,
    },
    config: {
      summary:
        ":settings: Настройки: day={day}m, night={night}m, lobby={lobby}m, min={min}, extend={extend}" ,
    },
    status: {
      text: ":phase: Статус: {state}. Хост: {host}. Живые: {alive}" ,
    },
    state: {
      lobby: ":recruiting: лобби" ,
      day: ":day: день" ,
      night: ":night: ночь" ,
      ended: ":inactive: завершено" ,
    },
    err: {
      channel_unknown: ":error: Не удалось определить канал." ,
      already_in_other: ":error: Вы уже находитесь в лобби или игре в {channel}." ,
      lobby_not_active: ":error: Лобби не активно." ,
      lobby_exists: ":error: Игра уже создана в этом канале." ,
      lobby_none: ":error: Сейчас нет лобби. Создайте: @MafiaBot create" ,
      already_in: ":error: Вы уже в игре." ,
      lobby_only: ":error: Покинуть можно только лобби." ,
      not_in_lobby: ":error: Вас нет в лобби." ,
      lobby_start_none: ":error: Нет активного лобби для старта." ,
      only_host_start: ":error: Запускать игру может только хост." ,
      need_min_players: ":error: Нужно минимум {min} игроков." ,
      game_not_created: ":error: Игра не создана." ,
      config_lobby_only: ":error: Настройка доступна только в лобби." ,
      config_host_only: ":error: Настраивать игру может только хост." ,
      config_usage_extend: ":error: Использование: @MafiaBot config extend host|any" ,
      config_usage_numbers:
        ":error: Использование: @MafiaBot config day 5 | night 2 | lobby 5 | min 4" ,
      config_options: ":error: Доступные настройки: day, night, lobby, min, extend" ,
      extend_lobby_only: ":error: Продлевать можно только в лобби." ,
      extend_not_allowed: ":error: Продлевать может только хост или участник по настройке." ,
      no_active_game: ":error: Нет активной игры." ,
      only_host_end: ":error: Завершить игру может только хост." ,
      unknown_command: ":error: Неизвестная команда. Напишите @MafiaBot help" ,
    },
    ok: {
      settings_updated: ":ok: Настройки обновлены." ,
    },
    action: {
      role_dm: ":card_index_dividers: Ваша роль в игре {channel}: *{role}*." ,
      failed: ":error: Не удалось обработать выбор." ,
      game_ended: ":inactive: Игра уже завершена." ,
      not_in_game: ":lock: Вы не участвуете или выбыли." ,
      not_day: ":warn: Сейчас не день." ,
      choose_alive: ":alive: Нужно выбрать живого игрока." ,
      already_acted: ":lock: Вы уже сделали действие в этой фазе." ,
      already_voted: ":lock: Ваш голос уже зафиксирован." ,
      vote_recorded: ":vote: Ваш голос учтен: {target}." ,
      vote_abstain: ":abstain: Вы воздержались." ,
      not_night: ":warn: Сейчас не ночь." ,
      mafia_only: ":error: :mafia: Команда доступна только мафии." ,
      no_mafia_target: ":warn: Нельзя выбрать мафию." ,
      abstain_disabled: ":lock: Воздержание отключено в этом канале." ,
      no_kill_disabled: ":lock: «Без убийства» отключено в этом канале." ,
      choice_recorded: ":ok: Ваш выбор: {target}." ,
      no_kill: ":no_kill: Ваш выбор: не убивать." ,
      doctor_only: ":error: :doctor: Команда доступна только доктору." ,
      detective_only: ":error: :detective: Команда доступна только детективу." ,
      bodyguard_only: ":error: :bodyguard: Команда доступна только телохранителю." ,
      bum_only: ":error: :bum: Команда доступна только Бомжу." ,
      lawyer_only: ":error: :lawyer: Команда доступна только Адвокату." ,
      stalker_only: ":error: :stalker: Команда доступна только Сталкеру." ,
      doctor_self_save_limit: ":lock: Себя можно спасать только один раз за игру." ,
      doctor_save: ":doctor: Вы спасаете: {target}." ,
      detective_check: ":detective: Вы проверяете: {target}." ,
      detective_kill: ":kill: Вы убиваете: {target}." ,
      detective_result: ":check: Результат проверки: {target} — {result}." ,
      bodyguard_protect: ":bodyguard: Вы защищаете: {target}." ,
      bum_visit: ":bum: Вы заходите к: {target}." ,
      lawyer_protect: ":lawyer: Вы защищаете: {target}." ,
      stalker_kill: ":stalker: Вы охотитесь на: {target}." ,
      result_mafia: ":mafia: мафия" ,
      result_not_mafia: ":town: не мафия" ,
    },
    bum: {
      witness: ":bum: Вы стали свидетелем убийства: {killer} убил {victim}." ,
      nothing: ":bum: Сегодня вы ничего не увидели." ,
    },
    stalker: {
      target_assigned: ":stalker: Ваша цель по роли: {role}." ,
      success: ":trophy: Контракт выполнен! Побед: {wins}. Новая цель: {role}." ,
      failed: ":warn: Контракт провален. Новая цель: {role}." ,
      no_targets: ":inactive: Нет доступных ролей для цели." ,
    },
    sergeant: {
      promoted: ":sergeant: Детектив погиб. Теперь его действия доступны вам." ,
      info: ":detective: Результат детектива: {target} — {result}." ,
    },
    dm_cmd: {
      no_game: ":inactive: Нет активной игры для этой команды." ,
      need_alive: ":alive: Нужно указать живого игрока." ,
      day_only: ":warn: Дневные действия доступны только днём." ,
      night_only: ":warn: Ночные действия доступны только ночью." ,
      mafia_only: ":error: :mafia: Команда доступна только мафии." ,
      no_mafia_target: ":warn: Нельзя выбрать мафию." ,
      doctor_only: ":error: :doctor: Команда доступна только доктору." ,
      detective_only: ":error: :detective: Команда доступна только детективу." ,
      bodyguard_only: ":error: :bodyguard: Команда доступна только телохранителю." ,
      bum_only: ":error: :bum: Команда доступна только Бомжу." ,
      lawyer_only: ":error: :lawyer: Команда доступна только Адвокату." ,
      stalker_only: ":error: :stalker: Команда доступна только Сталкеру." ,
      doctor_self_save_limit: ":lock: Себя можно спасать только один раз за игру." ,
      vote_recorded: ":vote: Ваш голос учтен: {target}." ,
      choice_recorded: ":ok: Ваш выбор: {target}." ,
      doctor_save: ":doctor: Вы спасаете: {target}." ,
      detective_check: ":detective: Вы проверяете: {target}." ,
      detective_kill: ":kill: Вы убиваете: {target}." ,
      detective_result: ":check: Результат проверки: {target} — {result}." ,
      result_mafia: ":mafia: мафия" ,
      result_not_mafia: ":town: не мафия" ,
      bodyguard_protect: ":bodyguard: Вы защищаете: {target}." ,
      bum_visit: ":bum: Вы заходите к: {target}." ,
      lawyer_protect: ":lawyer: Вы защищаете: {target}." ,
      stalker_kill: ":stalker: Вы охотитесь на: {target}." ,
      unknown_command:
        ":help: Команда не распознана. Используйте kill/save/check/protect/visit/defend/stalk @user." ,
    },
    test: {
      not_dev: ":lock: Только разработчик может использовать тест-команды." ,
      setup_usage: ":help: Использование: `test setup #channel Alice,Bob,Charlie`" ,
      list_usage: ":help: Использование: `test list #channel`" ,
      setup_ok:
        ":ok: Тестовое лобби готово в {channel}. Игроки: {players}\n:help: Команда: `as <name> <action>`." ,
      duplicate_names: ":warn: Повторяющиеся имена: {names}." ,
      active_game: ":warn: Нельзя включить тест-режим во время активной игры." ,
      real_players:
        ":warn: Уберите реальных игроков из лобби перед включением тест-режима." ,
      no_game: ":inactive: Тестовая игра не найдена. Используйте `test setup` или укажите #channel." ,
      list: ":card_index_dividers: Тестовые игроки в {channel}: {players}" ,
      as_usage: ":help: Использование: `as <name> <action> [target]`" ,
      actor_not_found: ":error: Тестовый игрок `{name}` не найден." ,
      target_not_found: ":error: Цель не найдена: `{name}`." ,
      roles_summary: ":card_index_dividers: *Роли тест-игроков* в {channel}:\n:card_index_dividers: {list}" ,
      actions_reminder_night:
        ":night: *Тест-действия (ночь)* в {channel}:\n:night: {list}\n:help: Команда: `as <name> <action> <target>`" ,
      actions_reminder_day:
        ":day: *Тест-действия (день)* в {channel}:\n:day: {list}\n:help: Команда: `as <name> vote <target>` или `as <name> abstain`" ,
    },
  },
};

const FAQ_ITEMS = [
  {
    id: "add-bot" ,
    q: {
      en: ":question: How do I add the bot to a channel?" ,
      ru: ":question: Как добавить бота в канал?" ,
    },
    a: {
      en:
        ":help: Open the channel and type `/invite @MafiaBot`. The bot must be in the channel to run a game." ,
      ru:
        ":help: Откройте канал и напишите `/invite @MafiaBot`. Бот должен быть в канале, чтобы вести игру." ,
    },
  },
  {
    id: "create-lobby" ,
    q: {
      en: ":question: How do I create a lobby?" ,
      ru: ":question: Как создать лобби?" ,
    },
    a: {
      en:
        ":help: In the channel: `@MafiaBot create` (or use the lobby buttons). The creator becomes the host." ,
      ru:
        ":help: В канале: `@MafiaBot create` (или кнопки лобби). Создатель становится хостом." ,
    },
  },
  {
    id: "join-leave" ,
    q: {
      en: ":question: How do players join or leave?" ,
      ru: ":question: Как игрокам войти или выйти?" ,
    },
    a: {
      en:
        ":help: Press `Join` / `Leave` in the lobby panel or use `@MafiaBot join` / `leave`." ,
      ru:
        ":help: Нажмите `Войти` / `Выйти` в панели лобби или используйте `@MafiaBot join` / `leave`." ,
    },
  },
  {
    id: "ready" ,
    q: {
      en: ":question: What does Ready do?" ,
      ru: ":question: Что делает кнопка «Готов»?" ,
    },
    a: {
      en:
        ":help: When all players are Ready and minimum players is reached, the game auto-starts." ,
      ru:
        ":help: Если все нажали «Готов» и достигнут минимум игроков, игра стартует автоматически." ,
    },
  },
  {
    id: "start-game" ,
    q: {
      en: ":question: How do I start the game?" ,
      ru: ":question: Как начать игру?" ,
    },
    a: {
      en:
        ":help: The host presses `Start` in the lobby panel or uses `@MafiaBot start`." ,
      ru:
        ":help: Хост нажимает `Старт` в панели лобби или пишет `@MafiaBot start`." ,
    },
  },
  {
    id: "lobby-timer" ,
    q: {
      en: ":question: How long does the lobby last and how to extend it?" ,
      ru: ":question: Сколько длится лобби и как его продлить?" ,
    },
    a: {
      en:
        ":help: Default is 5 minutes. Use `Extend +2m` or `@MafiaBot extend 2` (host or allowed)." ,
      ru:
        ":help: По умолчанию 5 минут. Используйте `Продлить +2м` или `@MafiaBot extend 2` (хост или разрешённые)." ,
    },
  },
  {
    id: "night-actions" ,
    q: {
      en: ":question: How do night actions work?" ,
      ru: ":question: Как работают ночные действия?" ,
    },
    a: {
      en:
        ":help: At night the bot sends DMs with buttons for mafia/doctor/detective/bodyguard. Choices are private." ,
      ru:
        ":help: Ночью бот отправляет личные сообщения с кнопками для мафии/доктора/детектива/телохранителя. Выборы приватные." ,
    },
  },
  {
    id: "day-vote" ,
    q: {
      en: ":question: How does daytime voting work?" ,
      ru: ":question: Как работает дневное голосование?" ,
    },
    a: {
      en:
        ":help: During the day each alive player receives a DM with vote buttons. Votes are anonymous." ,
      ru:
        ":help: Днём каждый живой получает личку с кнопками голосования. Голосование анонимное." ,
    },
  },
  {
    id: "roles" ,
    q: {
      en: ":question: What roles exist in this bot?" ,
      ru: ":question: Какие роли есть в этом боте?" ,
    },
    a: {
      en:
        ":help: Main roles: Mafia, Doctor, Detective, Mayor, Bodyguard, Jester, Godfather, Lucky, Bum, Sergeant, Lawyer, Stalker, Town." ,
      ru:
        ":help: Основные роли: Мафия, Доктор, Детектив, Мэр, Телохранитель, Шут, Крёстный отец, Счастливчик, Бомж, Сержант, Адвокат, Сталкер, Мирный." ,
    },
  },
  {
    id: "mafia-room" ,
    q: {
      en: ":question: What is the mafia room?" ,
      ru: ":question: Что такое комната мафии?" ,
    },
    a: {
      en:
        ":help: If permissions allow, the bot creates a private mafia chat (MPIM) for discussion at night." ,
      ru:
        ":help: Если права позволяют, бот создаёт приватный чат мафии (MPIM) для обсуждения ночью." ,
    },
  },
  {
    id: "graveyard" ,
    q: {
      en: ":question: What is the graveyard?" ,
      ru: ":question: Что такое кладбище?" ,
    },
    a: {
      en:
        ":help: A private channel for eliminated players. If permissions allow, the bot invites dead players there." ,
      ru:
        ":help: Приватный канал для выбывших. Если права позволяют, бот приглашает туда мёртвых." ,
    },
  },
  {
    id: "last-words" ,
    q: {
      en: ":question: What are last words?" ,
      ru: ":question: Что такое «последние слова»?" ,
    },
    a: {
      en:
        ":help: After elimination, you get 2 minutes to send one DM. It will be posted in the game channel." ,
      ru:
        ":help: После выбывания даётся 2 минуты, чтобы отправить одно сообщение в личку. Оно будет опубликовано в канале." ,
    },
  },
  {
    id: "whisper" ,
    q: {
      en: ":question: What is Whisper?" ,
      ru: ":question: Что такое «шёпот»?" ,
    },
    a: {
      en:
        ":help: Once per day you can DM `whisper <text>` and it will be posted anonymously in the channel." ,
      ru:
        ":help: Раз в день можно написать в личку `whisper <текст>` — сообщение появится анонимно в канале." ,
    },
  },
  {
    id: "find-games" ,
    q: {
      en: ":question: What is Find Games?" ,
      ru: ":question: Что такое «Найти игры»?" ,
    },
    a: {
      en:
        ":help: It lists public channels where the bot was marked as Public. Use the `Find games` button in DM." ,
      ru:
        ":help: Это список публичных каналов, где бот помечен как Public. Откройте кнопкой `Найти игры` в личке." ,
    },
  },
  {
    id: "privacy" ,
    q: {
      en: ":question: Public vs Private listing — what does it mean?" ,
      ru: ":question: Публичный/Частный список — что это значит?" ,
    },
    a: {
      en:
        ":help: Public channels appear in Find Games. Private channels are hidden and cannot be listed." ,
      ru:
        ":help: Публичные каналы показываются в «Найти игры». Приватные скрыты и не могут быть в списке." ,
    },
  },
  {
    id: "durations" ,
    q: {
      en: ":question: What do Day/Night/Lobby minutes change?" ,
      ru: ":question: Что меняют минуты дня/ночи/лобби?" ,
    },
    a: {
      en:
        ":help: They set the default duration for each phase. Warnings are sent before the timer ends." ,
      ru:
        ":help: Это длительность каждой фазы. Предупреждения приходят заранее." ,
    },
  },
  {
    id: "min-players" ,
    q: {
      en: ":question: What is Minimum players?" ,
      ru: ":question: Что такое минимум игроков?" ,
    },
    a: {
      en:
        ":help: The game can start only when at least this number of players joined." ,
      ru:
        ":help: Игра стартует только когда набрано не меньше этого числа игроков." ,
    },
  },
  {
    id: "extend-policy" ,
    q: {
      en: ":question: Who can extend the lobby?" ,
      ru: ":question: Кто может продлевать лобби?" ,
    },
    a: {
      en:
        ":help: `Host only` means only the lobby host can extend. `Anyone` lets any player extend." ,
      ru:
        ":help: `Только хост` — продлевать может только хост. `Все` — может любой игрок лобби." ,
    },
  },
  {
    id: "warnings" ,
    q: {
      en: ":question: What are warnings?" ,
      ru: ":question: Что такое предупреждения таймера?" ,
    },
    a: {
      en:
        ":help: These are reminder times (in seconds) before a phase ends. Example: 60 and 30." ,
      ru:
        ":help: Это напоминания за X секунд до конца фазы. Например: 60 и 30." ,
    },
  },
  {
    id: "auto-shorten" ,
    q: {
      en: ":question: What is Auto-shorten?" ,
      ru: ":question: Что такое авто-сокращение фаз?" ,
    },
    a: {
      en:
        ":help: If most actions are done early, the bot shortens the remaining time to speed up the game." ,
      ru:
        ":help: Если большинство действий сделано, бот сокращает оставшееся время, чтобы ускорить игру." ,
    },
  },
  {
    id: "abstain" ,
    q: {
      en: ":question: What is Abstain?" ,
      ru: ":question: Что такое «Воздержаться»?" ,
    },
    a: {
      en:
        ":help: A voting option that counts as a vote cast, but does not target anyone." ,
      ru:
        ":help: Опция голосования: голос засчитывается, но без выбора цели." ,
    },
  },
  {
    id: "no-kill" ,
    q: {
      en: ":question: What is No-kill for mafia?" ,
      ru: ":question: Что такое «Без убийства» у мафии?" ,
    },
    a: {
      en:
        ":help: Mafia can choose to skip killing at night. It can be used for strategy or bluff." ,
      ru:
        ":help: Мафия может пропустить убийство ночью. Это стратегический выбор/блеф." ,
    },
  },
  {
    id: "doctor-self-save" ,
    q: {
      en: ":question: Doctor self-save limit — how it works?" ,
      ru: ":question: Лимит self-save доктора — как работает?" ,
    },
    a: {
      en:
        ":help: The doctor can save themselves only a limited number of times (default 1)." ,
      ru:
        ":help: Доктор может лечить себя ограниченное число раз (по умолчанию 1)." ,
    },
  },
  {
    id: "language" ,
    q: {
      en: ":question: How do I change language?" ,
      ru: ":question: Как сменить язык?" ,
    },
    a: {
      en: ":help: In DM, use `lang en` or `lang ru`." ,
      ru: ":help: В личке используйте `lang en` или `lang ru`." ,
    },
  },
  {
    id: "my-channels" ,
    q: {
      en: ":question: What is My channels?" ,
      ru: ":question: Что такое «Мои каналы»?" ,
    },
    a: {
      en:
        ":help: A list of channels where you last changed privacy. Use it to edit default settings." ,
      ru:
        ":help: Список каналов, где вы последний меняли приватность. Там можно менять настройки по умолчанию." ,
    },
  },
  {
    id: "channel-language" ,
    q: {
      en: ":question: What is Channel language?" ,
      ru: ":question: Что такое язык канала?" ,
    },
    a: {
      en:
        ":help: It sets the language for channel announcements and the Find Games label." ,
      ru:
        ":help: Определяет язык канальных объявлений и метку в «Найти игры»." ,
    },
  },
  {
    id: "dm-not-working" ,
    q: {
      en: ":question: Why doesn’t the bot DM me?" ,
      ru: ":question: Почему бот не пишет в личку?" ,
    },
    a: {
      en:
        ":help: Check that messages to apps are allowed in your Slack. If DM fails, the bot will post in the channel." ,
      ru:
        ":help: Проверьте, что в Slack разрешены сообщения от приложений. Если личка недоступна, бот пишет в канал." ,
    },
  },
  {
    id: "remove-bot" ,
    q: {
      en: ":question: How do I remove the bot from a channel?" ,
      ru: ":question: Как удалить бота из канала?" ,
    },
    a: {
      en: ":help: Use `/remove @MafiaBot` in the channel." ,
      ru: ":help: Напишите `/remove @MafiaBot` в канале." ,
    },
  },
];

function getByPath(obj, key) {
  return key.split(".").reduce((acc, part) => (acc ? acc[part] : undefined), obj);
}

const EMOJI_MAP = {
  // Roles
  ":mafia:": "\u{1F52A}",
  ":godfather:": "\u{1F3A9}",
  ":doctor:": "\u{1FA7A}",
  ":detective:": "\u{1F575}\uFE0F",
  ":mayor:": "\u{1F451}",
  ":bodyguard:": "\u{1F6E1}\uFE0F",
  ":town:": "\u{1F465}",
  ":jester:": "\u{1F921}",
  ":lucky:": "\u{1F340}",
  ":bum:": "\u{1F37A}",
  ":sergeant:": "\u{1F396}\uFE0F",
  ":lawyer:": "\u2696\uFE0F",
  ":stalker:": "\u{1F3AF}",

  // UI / actions
  ":join:": "\u2795",
  ":leave:": "\u2796",
  ":start:": "\u25B6\uFE0F",
  ":extend:": "\u23F1\uFE0F",
  ":end:": "\u26D4",
  ":ready:": "\u2705",
  ":abstain:": "\u{1F937}",
  ":no_kill:": "\u{1F4A4}",
  ":help:": "\u2139\uFE0F",
  ":prev:": "\u25C0\uFE0F",
  ":next:": "\u25B6\uFE0F",
  ":back:": "\u25C0\uFE0F",
  ":check:": "\u{1F50D}",
  ":kill:": "\u{1F5E1}\uFE0F",
  ":vote:": "\u{1F5F3}\uFE0F",

  // Status / labels
  ":active:": "\u{1F7E2}",
  ":recruiting:": "\u{1F7E1}",
  ":inactive:": "\u26AB",
  ":public:": "\u{1F310}",
  ":private:": "\u{1F512}",
  ":find:": "\u{1F50D}",
  ":timer:": "\u23F3",
  ":phase:": "\u{1F317}",
  ":alive:": "\u2764\uFE0F",
  ":dashboard:": "\u{1F4CC}",
  ":warn:": "\u23F0",
  ":maint:": "\u{1F6E0}\uFE0F",
  ":last_words:": "\u{1F56F}\uFE0F",
  ":graveyard:": "\u26B0\uFE0F",
  ":info:": "\u2728",
  ":wave:": "\u{1F44B}",
  ":rocket:": "\u{1F680}",
  ":bulb:": "\u{1F4A1}",
  ":speech_balloon:": "\u{1F4AC}",
  ":globe_with_meridians:": "\u{1F310}",
  ":mag_right:": "\u{1F50E}",
  ":card_index_dividers:": "\u{1F5C2}\uFE0F",
  ":question:": "\u2753",
  ":hammer_and_wrench:": "\u{1F6E0}\uFE0F",
  ":ok:": "\u2705",
  ":error:": "\u26D4",
  ":lock:": "\u{1F512}",
  ":day:": "\u2600\uFE0F",
  ":night:": "\u{1F319}",
  ":settings:": "\u2699\uFE0F",
  ":home:": "\u{1F3E0}",
  ":chart:": "\u{1F4CA}",
  ":trophy:": "\u{1F3C6}",
  ":page:": "\u{1F4C4}",
  ":skull:": "\u{1F480}",
};

function fixTextArtifacts(text) {
  if (text === null || text === undefined) return "";
  let out = String(text);
  // Replace encoding artifacts like "self?save" -> "self-save"
  out = out.replace(/([\p{L}\p{N}])\?([\p{L}\p{N}])/gu, "$1-$2");
  // Replace emoji placeholders
  for (const [token, emoji] of Object.entries(EMOJI_MAP)) {
    out = out.split(token).join(emoji);
  }
  // Legacy fallback if any stray question-mark placeholders remain
  out = out.replace(/\?{2,}/g, "\u2139\uFE0F");
  return out;
}

function t(lang, key, params = {}) {
  const safeLang = LANGS.includes(lang) ? lang : DEFAULT_LANG;
  const dict = I18N[safeLang] || I18N[DEFAULT_LANG];
  const template = getByPath(dict, key) || getByPath(I18N[DEFAULT_LANG], key) || key;

  const rendered = String(template).replace(/\{(\w+)\}/g, (match, name) => {
    if (params[name] === undefined || params[name] === null) return "";
    return String(params[name]);
  });
  return fixTextArtifacts(rendered);
}

function normalizeLang(lang) {
  return lang === "ru" ? "ru" : "en";
}

async function getUserLangInfo(userId) {
  if (userLangCache.has(userId)) return userLangCache.get(userId);
  const row = await db.getUserLang(userId);
  const info = row?.lang
    ? { lang: normalizeLang(row.lang), explicit: true }
    : { lang: DEFAULT_LANG, explicit: false };
  userLangCache.set(userId, info);
  return info;
}

async function getUserLang(userId) {
  return (await getUserLangInfo(userId)).lang;
}

function isDevUser(userId) {
  if (!DEV_USER_ID || !userId) return false;
  if (userId === DEV_USER_ID) return true;
  const normalized = stripPlatformPrefix(userId);
  return normalized === DEV_USER_ID;
}

function isDevCode(code) {
  return Boolean(DEV_CODE && code && code === DEV_CODE);
}

function getDefaultMaintenanceState() {
  return { enabled: false, by: null, requested_at: null, notified: false };
}

async function getMaintenanceState() {
  if (maintenanceCache) return maintenanceCache;
  const row = await db.getAppState("maintenance");
  if (!row || !row.value) {
    maintenanceCache = getDefaultMaintenanceState();
    return maintenanceCache;
  }
  try {
    const parsed = JSON.parse(row.value);
    maintenanceCache = { ...getDefaultMaintenanceState(), ...parsed };
  } catch (err) {
    maintenanceCache = getDefaultMaintenanceState();
  }
  return maintenanceCache;
}

async function setMaintenanceState(state) {
  const next = { ...getDefaultMaintenanceState(), ...state };
  maintenanceCache = next;
  await db.setAppState("maintenance", JSON.stringify(next), now());
  return next;
}

async function isMaintenanceEnabled() {
  return (await getMaintenanceState()).enabled;
}

async function setUserLang(userId, lang) {
  const normalized = normalizeLang(lang);
  await db.setUserLang(userId, normalized, now());
  const info = { lang: normalized, explicit: true };
  userLangCache.set(userId, info);
  return info;
}

function withDevHint(text, lang, userId) {
  if (!isDevUser(userId)) return text;
  return `${text}\n${t(lang, "dev.help")}`;
}

function normalizeStatsRow(row) {
  return {
    wins: row?.wins || 0,
    losses: row?.losses || 0,
    games: row?.games || 0,
  };
}

function computeWinRate(stats) {
  if (!stats.games) return 0;
  return Math.round((stats.wins / stats.games) * 100);
}

async function getUserStats(userId) {
  return normalizeStatsRow(await db.getUserStats(userId));
}

async function getUserChannelStats(userId, channelId) {
  return normalizeStatsRow(await db.getUserChannelStats(userId, channelId));
}

async function getUserRoleStats(userId) {
  const rows = await db.listUserRoleStats(userId);
  return rows.map((row) => ({
    role: row.role,
    ...normalizeStatsRow(row),
  }));
}

async function updateUserStats(userId, isWin) {
  const current = await getUserStats(userId);
  const next = {
    wins: current.wins + (isWin ? 1 : 0),
    losses: current.losses + (isWin ? 0 : 1),
    games: current.games + 1,
  };
  await db.upsertUserStats(
    userId,
    next.wins,
    next.losses,
    next.games,
    now()
  );
}

async function updateUserChannelStats(userId, channelId, isWin) {
  const current = await getUserChannelStats(userId, channelId);
  const next = {
    wins: current.wins + (isWin ? 1 : 0),
    losses: current.losses + (isWin ? 0 : 1),
    games: current.games + 1,
  };
  await db.upsertUserChannelStats(
    userId,
    channelId,
    next.wins,
    next.losses,
    next.games,
    now()
  );
}

async function updateUserRoleStats(userId, role, isWin) {
  const current = normalizeStatsRow(await db.getUserRoleStats(userId, role));
  const next = {
    wins: current.wins + (isWin ? 1 : 0),
    losses: current.losses + (isWin ? 0 : 1),
    games: current.games + 1,
  };
  await db.upsertUserRoleStats(
    userId,
    role,
    next.wins,
    next.losses,
    next.games,
    now()
  );
}

async function incrementUserRoleStats(userId, role, winsDelta, lossesDelta, gamesDelta) {
  const current = normalizeStatsRow(await db.getUserRoleStats(userId, role));
  const next = {
    wins: current.wins + (winsDelta || 0),
    losses: current.losses + (lossesDelta || 0),
    games: current.games + (gamesDelta || 0),
  };
  await db.upsertUserRoleStats(
    userId,
    role,
    next.wins,
    next.losses,
    next.games,
    now()
  );
}

async function getChannelPref(channelId) {
  return (await db.getChannelPref(channelId)) || null;
}

function parseSettingsJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch (err) {
    return null;
  }
}

async function getChannelSettings(channelId) {
  const pref = await getChannelPref(channelId);
  return parseSettingsJson(pref?.settings_json);
}

function normalizeChannelLang(lang) {
  return lang === "ru" ? "ru" : "en";
}

function getChannelLangFromSettings(settings) {
  if (settings?.channelLang === "ru") return "ru";
  return "en";
}

function getChannelLangForGame(game) {
  return normalizeChannelLang(game?.config?.channelLang || DEFAULT_LANG);
}

async function ensureChannelPref(channelId, meta = {}) {
  const existing = await getChannelPref(channelId);
  if (existing) return existing;
  await db.upsertChannelPref(
    channelId,
    0,
    meta.channelType || null,
    now(),
    meta.promptedAt || now(),
    meta.listedBy || null,
    meta.settingsJson || null
  );
  return getChannelPref(channelId);
}

async function markChannelPrompted(channelId, meta = {}) {
  const existing = await getChannelPref(channelId);
  const promptedAt = existing?.prompted_at || meta.promptedAt || now();
  const listed = existing?.listed || 0;
  const listedBy = existing?.listed_by || meta.listedBy || null;
  const channelType = meta.channelType || existing?.channel_type || null;
  const settingsJson = meta.settingsJson || existing?.settings_json || null;
  await db.upsertChannelPref(
    channelId,
    listed,
    channelType,
    now(),
    promptedAt,
    listedBy,
    settingsJson
  );
  return getChannelPref(channelId);
}

async function setChannelListing(channelId, listed, meta = {}) {
  const existing = await getChannelPref(channelId);
  const channelType = meta.channelType || existing?.channel_type || null;
  const promptedAt = existing?.prompted_at || meta.promptedAt || null;
  const listedBy = meta.listedBy || existing?.listed_by || null;
  const settingsJson = meta.settingsJson || existing?.settings_json || null;
  await db.upsertChannelPref(
    channelId,
    listed ? 1 : 0,
    channelType,
    now(),
    promptedAt,
    listedBy,
    settingsJson
  );
  return getChannelPref(channelId);
}

async function listListedChannels() {
  return db.listListedChannels();
}

async function listOwnedChannels(userId) {
  return db.listOwnedChannels(userId);
}

async function setChannelSettings(channelId, settings, meta = {}) {
  const existing = await getChannelPref(channelId);
  const listed = existing?.listed || 0;
  const channelType = meta.channelType || existing?.channel_type || null;
  const promptedAt = existing?.prompted_at || meta.promptedAt || null;
  const listedBy = meta.listedBy || existing?.listed_by || null;
  const settingsJson =
    typeof settings === "string" ? settings : JSON.stringify(settings);
  await db.upsertChannelPref(
    channelId,
    listed,
    channelType,
    now(),
    promptedAt,
    listedBy,
    settingsJson
  );
  return getChannelPref(channelId);
}

const ACTIONS = {
  DAY_VOTE: "day_vote",
  MAFIA_VOTE: "mafia_vote",
  DOCTOR_SAVE: "doctor_save",
  DETECTIVE_CHECK: "detective_check",
  DETECTIVE_KILL: "detective_kill",
  DETECTIVE_MODE_CHECK: "detective_mode_check",
  DETECTIVE_MODE_KILL: "detective_mode_kill",
  BODYGUARD_PROTECT: "bodyguard_protect",
  BUM_VISIT: "bum_visit",
  LAWYER_PROTECT: "lawyer_protect",
  STALKER_KILL: "stalker_kill",
  LOBBY_JOIN: "lobby_join",
  LOBBY_LEAVE: "lobby_leave",
  LOBBY_START: "lobby_start",
  LOBBY_EXTEND: "lobby_extend",
  LOBBY_END: "lobby_end",
  LOBBY_READY: "lobby_ready",
  DM_HELP_ADD: "dm_help_add",
  DM_HELP_COMMANDS: "dm_help_commands",
  DM_HELP_SETTINGS: "dm_help_settings",
  LANG_SELECT_EN: "lang_select_en",
  LANG_SELECT_RU: "lang_select_ru",
  PAGE_PREV: "page_prev",
  PAGE_NEXT: "page_next",
  FIND_GAMES_OPEN: "find_games_open",
  FIND_FILTER_ACTIVE: "find_filter_active",
  FIND_FILTER_RECRUITING: "find_filter_recruiting",
  FIND_FILTER_INACTIVE: "find_filter_inactive",
  FIND_LANG_ALL: "find_lang_all",
  FIND_LANG_EN: "find_lang_en",
  FIND_LANG_RU: "find_lang_ru",
  FIND_PAGE_PREV: "find_page_prev",
  FIND_PAGE_NEXT: "find_page_next",
  CHANNEL_LIST_PUBLIC: "channel_list_public",
  CHANNEL_LIST_PRIVATE: "channel_list_private",
  CHANNEL_LANG_EN: "channel_lang_en",
  CHANNEL_LANG_RU: "channel_lang_ru",
  MY_CHANNELS_OPEN: "my_channels_open",
  MY_CHANNELS_PAGE_PREV: "my_channels_page_prev",
  MY_CHANNELS_PAGE_NEXT: "my_channels_page_next",
  CHANNEL_EDIT_OPEN: "channel_edit_open",
  FAQ_OPEN: "faq_open",
  FAQ_TOPIC: "faq_topic",
  FAQ_BACK: "faq_back",
  FAQ_PAGE_PREV: "faq_page_prev",
  FAQ_PAGE_NEXT: "faq_page_next",
  ROLE_HELP: "role_help",
  DEV_MAINT_TOGGLE: "dev_maint_toggle",
};

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  logLevel: LogLevel.INFO,
});


const gameCache = new Map();
const channelLocks = new Map();
const channelTimers = new Map();
const userCache = new Map();
const userDisplayCache = new Map();
const userLangCache = new Map();
const languagePrompted = new Set();
const lastWordsPending = new Map();
const channelInfoCache = new Map();
let maintenanceCache = null;
let BOT_USER_ID = null;
let BOT_ID = null;
let userInfoEnabled = true;
let channelInfoEnabled = true;

function now() {
  return Date.now();
}

function toMs(minutes) {
  return Math.max(1, minutes) * 60 * 1000;
}

function cacheTelegramUser(user) {
  if (!user || user.is_bot) return;
  const idKey = makeUserKey(PLATFORM_TELEGRAM, user.id);
  const label = [user.first_name, user.last_name].filter(Boolean).join(" ") || user.username || String(user.id);
  const handle = user.username || null;
  const info = { label, handle };
  tgUserCache.set(idKey, info);
  if (handle) tgHandleCache.set(handle.toLowerCase(), idKey);
  userCache.set(idKey, label);
  userDisplayCache.set(idKey, info);
  db.upsertUserCache(idKey, PLATFORM_TELEGRAM, label, handle, now()).catch(
    (err) => console.warn("Failed to cache telegram user:", err?.message || err)
  );
}

function cacheTelegramChat(chat) {
  if (!chat) return;
  const idKey = makeChannelKey(PLATFORM_TELEGRAM, chat.id);
  const title = chat.title || chat.username || String(chat.id);
  const info = { title, username: chat.username || null, type: chat.type || null };
  tgChatCache.set(idKey, info);
  channelInfoCache.set(idKey, { name: title, is_private: chat.type === "private" });
  db.upsertChannelCache(
    idKey,
    PLATFORM_TELEGRAM,
    title,
    chat.type === "private",
    now()
  ).catch((err) =>
    console.warn("Failed to cache telegram chat:", err?.message || err)
  );
}

function formatDuration(lang, ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes <= 0) return t(lang, "time.sec", { seconds });
  if (seconds === 0) return t(lang, "time.min", { minutes });
  return t(lang, "time.min_sec", { minutes, seconds });
}

function randomChoice(list) {
  if (!list.length) return null;
  return list[Math.floor(Math.random() * list.length)];
}

function shuffle(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function isTestUserId(userId) {
  return typeof userId === "string" && userId.startsWith(TEST_ID_PREFIX);
}

function buildTestPlayerId(channelId, index) {
  return `${TEST_ID_PREFIX}${channelId}:${index}`;
}

function getTestPlayerName(userId) {
  for (const game of gameCache.values()) {
    const player = game?.players?.[userId];
    if (player?.isTest) return player.name || player.id || userId;
  }
  return userId;
}

function resolveTestPlayerIdByName(game, name) {
  if (!game || !name) return null;
  const target = name.trim().toLowerCase();
  const players = Object.values(game.players || {});
  for (const player of players) {
    if (!player?.isTest) continue;
    if ((player.name || "").toLowerCase() === target) return player.id;
  }
  return null;
}

function extractChannelIdFromText(text) {
  const match = text.match(/<#([A-Z0-9]+)(?:\|[^>]+)?>/);
  return match ? match[1] : null;
}

function stripChannelMentions(text) {
  return text.replace(/<#([A-Z0-9]+)(?:\|[^>]+)?>/g, "").trim();
}

function listTestGamesForController(controllerId) {
  return [...gameCache.values()].filter(
    (game) => game?.test?.enabled && game.test.controllerId === controllerId
  );
}

function normalizeTestAction(action) {
  return String(action || "").toLowerCase().replace(/-/g, "");
}

function resolveTargetIdFromText(game, text) {
  const mentionMatch = text.match(/<@([A-Z0-9]+)>/);
  if (mentionMatch) return mentionMatch[1];
  const tgMatch = text.match(/@([A-Za-z0-9_]+)/);
  if (tgMatch) {
    const key = tgHandleCache.get(tgMatch[1].toLowerCase());
    if (key) return key;
  }
  const name = text.trim().split(/\s+/)[0];
  if (!name) return null;
  return resolveTestPlayerIdByName(game, name);
}

function mention(userId) {
  if (isTestUserId(userId)) return getTestPlayerName(userId);
  if (isTelegramKey(userId)) {
    const info = tgUserCache.get(userId);
    if (info?.handle) return `@${info.handle}`;
    return info?.label || `tg:${stripPlatformPrefix(userId)}`;
  }
  return `<@${stripPlatformPrefix(userId)}>`;
}

function channelMention(channelId) {
  if (isTelegramKey(channelId)) {
    const info = tgChatCache.get(channelId);
    if (info?.username) return `@${info.username}`;
    return info?.title || `tg:${stripPlatformPrefix(channelId)}`;
  }
  return `<#${stripPlatformPrefix(channelId)}>`;
}

function roleLabel(role, lang) {
  switch (role) {
    case "mafia":
      return t(lang, "role.mafia");
    case "doctor":
      return t(lang, "role.doctor");
    case "detective":
      return t(lang, "role.detective");
    case "mayor":
      return t(lang, "role.mayor");
    case "bodyguard":
      return t(lang, "role.bodyguard");
    case "jester":
      return t(lang, "role.jester");
    case "godfather":
      return t(lang, "role.godfather");
    case "lucky":
      return t(lang, "role.lucky");
    case "bum":
      return t(lang, "role.bum");
    case "sergeant":
      return t(lang, "role.sergeant");
    case "lawyer":
      return t(lang, "role.lawyer");
    case "stalker":
      return t(lang, "role.stalker");
    default:
      return t(lang, "role.town");
  }
}

function serializeGame(game) {
  return JSON.stringify(game);
}

async function saveGame(game) {
  try {
    await db.saveGame(
      game.channelId,
      serializeGame(game),
      game.phaseDeadline || null,
      now()
    );
  } catch (err) {
    console.error("Failed to save game:", err?.message || err);
  }
}

async function deleteGame(channelId) {
  try {
    await db.deleteGame(channelId);
  } catch (err) {
    console.error("Failed to delete game:", err?.message || err);
  }
}

async function loadAllGames() {
  const rows = await db.loadAllGames();
  return rows.map((row) => JSON.parse(row.state_json));
}

function withChannelLock(channelId, fn) {
  const prev = channelLocks.get(channelId) || Promise.resolve();
  const next = prev
    .then(fn)
    .catch((err) => {
      console.error(`Channel lock error for ${channelId}:`, err);
    })
    .finally(() => {
      if (channelLocks.get(channelId) === next) {
        channelLocks.delete(channelId);
      }
    });

  channelLocks.set(channelId, next);
  return next;
}

function createLobby(channelId, hostId, platform) {
  const createdAt = now();
  const inferredPlatform =
    platform || (isTelegramKey(channelId) ? PLATFORM_TELEGRAM : PLATFORM_SLACK);
  const game = {
    channelId,
    hostId,
    platform: inferredPlatform,
    state: "lobby",
    round: 0,
    createdAt,
    phaseDeadline: createdAt + toMs(DEFAULTS.LOBBY_MINUTES),
    dashboardTs: null,
    graveyard: null,
    mafiaRoomId: null,
    lastWords: { pending: {} },
    whispersUsed: {},
    doctorSelfSavesUsed: 0,
    stalker: { targetRole: null, wins: 0, losses: 0 },
    history: { nights: [] },
    phaseShortened: { day: false, night: false },
    test: { enabled: false, controllerId: null },
    config: {
      minPlayers: DEFAULTS.MIN_PLAYERS,
      dayMs: toMs(DEFAULTS.DAY_MINUTES),
      nightMs: toMs(DEFAULTS.NIGHT_MINUTES),
      lobbyMs: toMs(DEFAULTS.LOBBY_MINUTES),
      extendPolicy: DEFAULTS.EXTEND_POLICY,
      warningsMs: DEFAULTS.WARNINGS_MS,
      autoShorten: DEFAULTS.AUTO_SHORTEN,
      whisperEnabled: DEFAULTS.WHISPER_ENABLED,
      allowAbstain: DEFAULTS.ALLOW_ABSTAIN,
      allowNoKill: DEFAULTS.ALLOW_NO_KILL,
      doctorSelfSaveLimit: DEFAULTS.DOCTOR_SELF_SAVE_LIMIT,
      channelLang: DEFAULT_LANG,
    },
    lobbyMessageTs: null,
    players: {
      [hostId]: {
        id: hostId,
        role: null,
        alive: true,
        joinedAt: createdAt,
        name: null,
        ready: false,
      },
    },
    roles: {
      mafiaIds: [],
      doctorId: null,
      detectiveId: null,
      mayorId: null,
      bodyguardId: null,
      jesterId: null,
      godfatherId: null,
      luckyId: null,
      bumId: null,
      sergeantId: null,
      lawyerId: null,
      stalkerId: null,
    },
    night: {
      mafiaVotes: {},
      doctorSave: null,
      detectiveCheck: null,
      detectiveKill: null,
      bodyguardProtect: null,
      bumVisit: null,
      lawyerProtect: null,
      stalkerKill: null,
      startedAt: null,
    },
    day: {
      votes: {},
      startedAt: null,
    },
  };

  return game;
}

function normalizeGame(game) {
  if (!game.config) game.config = {};
  if (!game.config.minPlayers) game.config.minPlayers = DEFAULTS.MIN_PLAYERS;
  if (!game.config.dayMs) game.config.dayMs = toMs(DEFAULTS.DAY_MINUTES);
  if (!game.config.nightMs) game.config.nightMs = toMs(DEFAULTS.NIGHT_MINUTES);
  if (!game.config.lobbyMs) game.config.lobbyMs = toMs(DEFAULTS.LOBBY_MINUTES);
  if (!game.config.channelLang) game.config.channelLang = DEFAULT_LANG;
  if (!game.platform) {
    game.platform = isTelegramKey(game.channelId)
      ? PLATFORM_TELEGRAM
      : PLATFORM_SLACK;
  }
  if (!game.config.extendPolicy)
    game.config.extendPolicy = DEFAULTS.EXTEND_POLICY;
  if (!Array.isArray(game.config.warningsMs))
    game.config.warningsMs = DEFAULTS.WARNINGS_MS;
  if (game.config.autoShorten === undefined)
    game.config.autoShorten = DEFAULTS.AUTO_SHORTEN;
  if (game.config.whisperEnabled === undefined)
    game.config.whisperEnabled = DEFAULTS.WHISPER_ENABLED;
  if (game.config.allowAbstain === undefined)
    game.config.allowAbstain = DEFAULTS.ALLOW_ABSTAIN;
  if (game.config.allowNoKill === undefined)
    game.config.allowNoKill = DEFAULTS.ALLOW_NO_KILL;
  if (
    game.config.doctorSelfSaveLimit === undefined ||
    game.config.doctorSelfSaveLimit === null
  ) {
    game.config.doctorSelfSaveLimit = DEFAULTS.DOCTOR_SELF_SAVE_LIMIT;
  }
  if (!game.dashboardTs) game.dashboardTs = null;
  if (!game.test) game.test = { enabled: false, controllerId: null };
  if (game.test.enabled === undefined) game.test.enabled = false;
  if (!game.test.controllerId) game.test.controllerId = null;
  if (!game.graveyard) game.graveyard = null;
  if (!game.mafiaRoomId) game.mafiaRoomId = null;
  if (!game.lastWords) game.lastWords = { pending: {} };
  if (!game.lastWords.pending) game.lastWords.pending = {};
  if (!game.whispersUsed) game.whispersUsed = {};
  if (!game.stalker) game.stalker = { targetRole: null, wins: 0, losses: 0 };
  if (!game.stalker.targetRole) game.stalker.targetRole = null;
  if (typeof game.stalker.wins !== "number") game.stalker.wins = 0;
  if (typeof game.stalker.losses !== "number") game.stalker.losses = 0;
  if (!game.history) game.history = { nights: [] };
  if (!Array.isArray(game.history.nights)) game.history.nights = [];
  if (typeof game.doctorSelfSavesUsed !== "number")
    game.doctorSelfSavesUsed = 0;
  if (!game.phaseShortened) game.phaseShortened = { day: false, night: false };
  if (game.lobbyMessageTs && typeof game.lobbyMessageTs === "object") {
    const preferredLang = getChannelLangForGame(game);
    game.lobbyMessageTs =
      game.lobbyMessageTs[preferredLang] ||
      game.lobbyMessageTs.en ||
      game.lobbyMessageTs.ru ||
      null;
  }
  if (typeof game.lobbyMessageTs !== "string") {
    game.lobbyMessageTs = null;
  }
  if (game.state === "lobby" && !game.phaseDeadline) {
    game.phaseDeadline = now() + game.config.lobbyMs;
  }
  if (!game.roles) game.roles = {};
  if (!game.roles.jesterId) game.roles.jesterId = null;
  if (!game.roles.godfatherId) game.roles.godfatherId = null;
  if (!game.roles.luckyId) game.roles.luckyId = null;
  if (!game.roles.bumId) game.roles.bumId = null;
  if (!game.roles.sergeantId) game.roles.sergeantId = null;
  if (!game.roles.lawyerId) game.roles.lawyerId = null;
  if (!game.roles.stalkerId) game.roles.stalkerId = null;
  if (game.night) {
    if (!game.night.bumVisit) game.night.bumVisit = null;
    if (!game.night.lawyerProtect) game.night.lawyerProtect = null;
    if (!game.night.stalkerKill) game.night.stalkerKill = null;
    if (game.night.detectiveKill === undefined) game.night.detectiveKill = null;
  }
  if (game.players) {
    Object.values(game.players).forEach((player) => {
      if (player.ready === undefined) player.ready = false;
    });
  }
}

function getGame(channelId) {
  return gameCache.get(channelId);
}

function findBlockingGame(userId, targetChannelId) {
  for (const game of gameCache.values()) {
    if (!game || game.state === "ended") continue;
    if (game.channelId === targetChannelId) continue;
    const player = game.players?.[userId];
    if (!player) continue;
    if (game.state === "lobby") return game;
    if ((game.state === "day" || game.state === "night") && player.alive) {
      return game;
    }
  }
  return null;
}

function applyChannelSettingsToGame(game, settings) {
  if (!settings || !game?.config) return;

  const toNumber = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const dayMinutes = toNumber(settings.dayMinutes);
  if (dayMinutes !== null && dayMinutes >= 1) game.config.dayMs = toMs(dayMinutes);

  const nightMinutes = toNumber(settings.nightMinutes);
  if (nightMinutes !== null && nightMinutes >= 1)
    game.config.nightMs = toMs(nightMinutes);

  const lobbyMinutes = toNumber(settings.lobbyMinutes);
  if (lobbyMinutes !== null && lobbyMinutes >= 1) {
    game.config.lobbyMs = toMs(lobbyMinutes);
    if (game.state === "lobby") {
      game.phaseDeadline = now() + game.config.lobbyMs;
    }
  }

  const minPlayers = toNumber(settings.minPlayers);
  if (minPlayers !== null && minPlayers >= 4) {
    game.config.minPlayers = Math.max(4, Math.floor(minPlayers));
  }

  if (settings.extendPolicy === "host" || settings.extendPolicy === "any") {
    game.config.extendPolicy = settings.extendPolicy;
  }

  if (Array.isArray(settings.warningsSec)) {
    const warnings = settings.warningsSec
      .map((val) => Number(val))
      .filter((val) => Number.isFinite(val) && val > 0)
      .map((val) => Math.floor(val) * 1000);
    if (warnings.length > 0) game.config.warningsMs = warnings;
  }

  if (settings.autoShorten !== undefined)
    game.config.autoShorten = Boolean(settings.autoShorten);
  if (settings.whisperEnabled !== undefined)
    game.config.whisperEnabled = Boolean(settings.whisperEnabled);
  if (settings.allowAbstain !== undefined)
    game.config.allowAbstain = Boolean(settings.allowAbstain);
  if (settings.allowNoKill !== undefined)
    game.config.allowNoKill = Boolean(settings.allowNoKill);

  if (settings.channelLang === "en" || settings.channelLang === "ru") {
    game.config.channelLang = settings.channelLang;
  }

  const selfSaveLimit = toNumber(settings.doctorSelfSaveLimit);
  if (selfSaveLimit !== null && selfSaveLimit >= 0) {
    game.config.doctorSelfSaveLimit = Math.floor(selfSaveLimit);
  }
}

function getPlayers(game) {
  return Object.values(game.players);
}

function getAlivePlayers(game) {
  return getPlayers(game).filter((p) => p.alive);
}

function getAlivePlayerIds(game) {
  return getAlivePlayers(game).map((p) => p.id);
}

function isPlayerAlive(game, userId) {
  const player = game.players[userId];
  return Boolean(player && player.alive);
}

function isMafia(game, userId) {
  return game.roles.mafiaIds.includes(userId);
}

function isMafiaTeam(game, userId) {
  return isMafia(game, userId) || game.roles.lawyerId === userId;
}

function isDetectiveSeesMafia(game, userId) {
  if (game.roles.godfatherId && game.roles.godfatherId === userId) return false;
  if (game.night?.lawyerProtect === userId && isMafia(game, userId)) return false;
  return isMafia(game, userId);
}

function canExtendLobby(game, userId) {
  if (game.config.extendPolicy === "any") {
    return Boolean(game.players[userId]);
  }
  return game.hostId === userId;
}

function allPlayersReady(game) {
  const ids = Object.keys(game.players || {});
  if (!ids.length) return false;
  return ids.every((id) => game.players[id]?.ready);
}

function assignRoles(game) {
  const ids = shuffle(Object.keys(game.players));
  const totalPlayers = ids.length;
  let mafiaCount = Math.max(1, Math.floor(totalPlayers / 3));

  const includeStalker = mafiaCount >= 2;
  if (includeStalker) mafiaCount -= 1;

  const pool = shuffle([
    "godfather",
    "jester",
    "mayor",
    "bodyguard",
    "lucky",
    "bum",
    "sergeant",
    "lawyer",
  ]);
  const mandatoryTownPool = ["mayor", "bodyguard", "lucky", "bum", "sergeant"];
  const mandatoryTownRole =
    totalPlayers >= 4 ? randomChoice(mandatoryTownPool) : null;

  const rolesToAssign = [];
  for (let i = 0; i < mafiaCount; i += 1) rolesToAssign.push("mafia");
  if (includeStalker) rolesToAssign.push("stalker");
  rolesToAssign.push("doctor", "detective");
  if (mandatoryTownRole) rolesToAssign.push(mandatoryTownRole);

  const remainingSlots = Math.max(0, totalPlayers - rolesToAssign.length);
  const poolWithoutMandatory = mandatoryTownRole
    ? pool.filter((role) => role !== mandatoryTownRole)
    : pool;
  const picked = poolWithoutMandatory.slice(
    0,
    Math.min(remainingSlots, poolWithoutMandatory.length)
  );
  const useGodfather = picked.includes("godfather");
  picked
    .filter((role) => role !== "godfather")
    .forEach((role) => rolesToAssign.push(role));

  while (rolesToAssign.length < totalPlayers) rolesToAssign.push("town");

  game.roles.mafiaIds = [];
  game.roles.doctorId = null;
  game.roles.detectiveId = null;
  game.roles.mayorId = null;
  game.roles.bodyguardId = null;
  game.roles.jesterId = null;
  game.roles.godfatherId = null;
  game.roles.luckyId = null;
  game.roles.bumId = null;
  game.roles.sergeantId = null;
  game.roles.lawyerId = null;
  game.roles.stalkerId = null;

  ids.forEach((id, idx) => {
    const player = game.players[id];
    const role = rolesToAssign[idx] || "town";
    player.role = role;
    player.alive = true;
    if (player.ready === undefined) player.ready = false;

    switch (role) {
      case "mafia":
        game.roles.mafiaIds.push(id);
        break;
      case "stalker":
        game.roles.stalkerId = id;
        break;
      case "doctor":
        game.roles.doctorId = id;
        break;
      case "detective":
        game.roles.detectiveId = id;
        break;
      case "jester":
        game.roles.jesterId = id;
        break;
      case "mayor":
        game.roles.mayorId = id;
        break;
      case "bodyguard":
        game.roles.bodyguardId = id;
        break;
      case "lucky":
        game.roles.luckyId = id;
        break;
      case "bum":
        game.roles.bumId = id;
        break;
      case "sergeant":
        game.roles.sergeantId = id;
        break;
      case "lawyer":
        game.roles.lawyerId = id;
        break;
      default:
        break;
    }
  });

  if (useGodfather && game.roles.mafiaIds.length > 0) {
    const godfatherId = randomChoice(game.roles.mafiaIds);
    game.roles.godfatherId = godfatherId || null;
    if (godfatherId && game.players[godfatherId]) {
      game.players[godfatherId].role = "godfather";
    }
  }
}

function resetNight(game) {
  game.night = {
    mafiaVotes: {},
    doctorSave: null,
    detectiveCheck: null,
    detectiveKill: null,
    bodyguardProtect: null,
    bumVisit: null,
    lawyerProtect: null,
    stalkerKill: null,
    startedAt: now(),
  };
}

function resetDay(game) {
  game.day = {
    votes: {},
    startedAt: now(),
  };
}

async function getNameOrMention(client, game, userId, lang) {
  if (isTestUserId(userId)) {
    return getTestPlayerName(userId);
  }
  if (!game?.players?.[userId]) {
    return getUserLabel(client, userId);
  }
  const userLang = await getUserLang(userId);
  if (userLang === lang) return mention(userId);
  return getUserLabel(client, userId);
}

async function formatUserListLocalized(client, game, userIds, lang) {
  if (!userIds.length) return "-";
  const names = await Promise.all(
    userIds.map((id) => getNameOrMention(client, game, id, lang))
  );
  return names.join(", ");
}

async function formatUserListPlain(client, userIds) {
  if (!userIds.length) return "-";
  const names = await Promise.all(userIds.map((id) => getUserLabel(client, id)));
  return names.join(", ");
}

function getAssetUrl(fileName) {
  if (!ASSET_BASE_URL) return "";
  return `${ASSET_BASE_URL}/assets/${fileName}`;
}

function getHomeIconFile(game, userId) {
  if (!game || !userId) return ASSET_FILES.icon;
  const role = game.players?.[userId]?.role;
  if (!role) return ASSET_FILES.icon;
  if (isMafiaTeam(game, userId)) return ASSET_FILES.mafia;
  return ASSET_FILES.peace;
}

async function listAliveDisplay(client, game, lang) {
  return formatUserListLocalized(client, game, getAlivePlayerIds(game), lang);
}

async function formatPlayersByFilter(client, game, filterFn, lang) {
  const ids = getPlayers(game)
    .filter(filterFn)
    .map((p) => p.id);
  return formatUserListLocalized(client, game, ids, lang);
}

function addNightHistory(game, entry) {
  if (!game.history) game.history = { nights: [] };
  if (!Array.isArray(game.history.nights)) game.history.nights = [];
  game.history.nights.unshift(entry);
  game.history.nights = game.history.nights.slice(0, 3);
}

function listAliveNonMafiaIds(game) {
  return getAlivePlayers(game)
    .filter((p) => !isMafia(game, p.id))
    .map((p) => p.id);
}

function getAliveRolePool(game) {
  const roles = getAlivePlayers(game)
    .map((p) => p.role || "town")
    .filter((role) => role && role !== "stalker");
  return Array.from(new Set(roles));
}

function pickStalkerTargetRole(game) {
  const pool = getAliveRolePool(game);
  return randomChoice(pool) || null;
}

async function notifyStalker(client, game, key, role) {
  const stalkerId = game.roles.stalkerId;
  if (!stalkerId || !isPlayerAlive(game, stalkerId)) return;
  if (isTestUserId(stalkerId)) return;
  const lang = await getUserLang(stalkerId);
  const roleText = role ? roleLabel(role, lang) : t(lang, "home.role_unknown");
  await sendInteractiveDM(client, stalkerId, t(lang, key, { role: roleText, wins: game.stalker?.wins || 0 }));
}

async function assignNewStalkerTarget(client, game, reasonKey) {
  if (!game.roles.stalkerId) return;
  const newRole = pickStalkerTargetRole(game);
  if (!game.stalker) game.stalker = { targetRole: null, wins: 0, losses: 0 };
  game.stalker.targetRole = newRole;
  await saveGame(game);
  if (!newRole) {
    await notifyStalker(client, game, "stalker.no_targets");
    return;
  }
  await notifyStalker(client, game, reasonKey || "stalker.target_assigned", newRole);
}

async function recordStalkerWin(game) {
  if (!game.roles.stalkerId) return;
  if (!game.stalker) game.stalker = { targetRole: null, wins: 0, losses: 0 };
  game.stalker.wins = (game.stalker.wins || 0) + 1;
  if (!isTestUserId(game.roles.stalkerId)) {
    await incrementUserRoleStats(game.roles.stalkerId, "stalker", 1, 0, 1);
  }
}

async function recordStalkerLoss(game) {
  if (!game.roles.stalkerId) return;
  if (!game.stalker) game.stalker = { targetRole: null, wins: 0, losses: 0 };
  game.stalker.losses = (game.stalker.losses || 0) + 1;
  if (!isTestUserId(game.roles.stalkerId)) {
    await incrementUserRoleStats(game.roles.stalkerId, "stalker", 0, 1, 1);
  }
}

async function maybePromoteSergeant(client, game) {
  const sergeantId = game.roles.sergeantId;
  if (!sergeantId) return;
  if (game.roles.detectiveId && isPlayerAlive(game, game.roles.detectiveId)) return;
  if (!isPlayerAlive(game, sergeantId)) return;
  if (game.roles.detectiveId === sergeantId) return;
  game.roles.detectiveId = sergeantId;
  await saveGame(game);
  if (!isTestUserId(sergeantId)) {
    const lang = await getUserLang(sergeantId);
    await sendInteractiveDM(client, sergeantId, t(lang, "sergeant.promoted"));
  }
}

async function getUserLabel(client, userId) {
  if (isTestUserId(userId)) return getTestPlayerName(userId);
  if (userCache.has(userId)) return userCache.get(userId);
  const info = await getUserDisplayInfo(client, userId);
  userCache.set(userId, info.label);
  return info.label;
}

async function getUserDisplayInfo(client, userId) {
  if (isTestUserId(userId)) {
    return { label: getTestPlayerName(userId), handle: null };
  }
  if (isTelegramKey(userId)) {
    const cached = tgUserCache.get(userId);
    if (cached) return cached;
    const dbCached = await db.getUserCache(userId);
    if (dbCached?.display_name) {
      const result = {
        label: dbCached.display_name,
        handle: dbCached.handle || null,
      };
      tgUserCache.set(userId, result);
      if (result.handle) {
        tgHandleCache.set(result.handle.toLowerCase(), userId);
      }
      userCache.set(userId, result.label);
      userDisplayCache.set(userId, result);
      return result;
    }
    const rawId = stripPlatformPrefix(userId);
    return { label: `tg:${rawId}`, handle: null };
  }
  if (!userInfoEnabled) return { label: userId, handle: null };
  if (userDisplayCache.has(userId)) return userDisplayCache.get(userId);
  const cached = await db.getUserCache(userId);
  if (cached?.display_name) {
    const result = { label: cached.display_name, handle: cached.handle || null };
    userDisplayCache.set(userId, result);
    userCache.set(userId, result.label);
    return result;
  }

  try {
    const info = await client.users.info({ user: stripPlatformPrefix(userId) });
    const profile = info.user.profile || {};
    const label =
      profile.display_name || profile.real_name || info.user.name || userId;
    const handle = info.user.name || null;
    const result = { label, handle };
    userDisplayCache.set(userId, result);
    userCache.set(userId, label);
    await db.upsertUserCache(
      userId,
      PLATFORM_SLACK,
      label,
      handle,
      now()
    );
    return result;
  } catch (err) {
    if (err?.data?.error === "missing_scope") {
      userInfoEnabled = false;
    }
    return { label: userId, handle: null };
  }
}

async function getChannelInfo(client, channelId) {
  if (isTelegramKey(channelId)) {
    const cached = tgChatCache.get(channelId);
    if (cached) {
      return { name: cached.title, is_private: cached.type === "private" };
    }
    const dbCached = await db.getChannelCache(channelId);
    if (dbCached?.name) {
      const result = {
        name: dbCached.name,
        is_private:
          dbCached.is_private === null || dbCached.is_private === undefined
            ? null
            : Boolean(dbCached.is_private),
      };
      channelInfoCache.set(channelId, result);
      return result;
    }
    const rawId = stripPlatformPrefix(channelId);
    return { name: `tg:${rawId}`, is_private: null };
  }
  if (!channelInfoEnabled) return { name: channelId, is_private: null };
  if (channelInfoCache.has(channelId)) return channelInfoCache.get(channelId);
  const cached = await db.getChannelCache(channelId);
  if (cached?.name) {
    const result = {
      name: cached.name,
      is_private:
        cached.is_private === null || cached.is_private === undefined
          ? null
          : Boolean(cached.is_private),
    };
    channelInfoCache.set(channelId, result);
    return result;
  }
  try {
    const info = await client.conversations.info({
      channel: stripPlatformPrefix(channelId),
    });
    const name = info.channel?.name || channelId;
    const isPrivate = Boolean(info.channel?.is_private);
    const result = { name, is_private: isPrivate };
    channelInfoCache.set(channelId, result);
    await db.upsertChannelCache(
      channelId,
      PLATFORM_SLACK,
      name,
      isPrivate,
      now()
    );
    return result;
  } catch (err) {
    if (err?.data?.error === "missing_scope") {
      channelInfoEnabled = false;
    }
    return { name: channelId, is_private: null };
  }
}

async function buildUserOptions(client, game, userIds) {
  const labels = await Promise.all(
    userIds.map(async (id) => ({ id, label: await getUserLabel(client, id) }))
  );

  return labels.map((entry) => ({
    text: {
      type: "plain_text",
      text: entry.label,
      emoji: false,
    },
    value: entry.id,
  }));
}

function normalizeLabelKey(label) {
  return String(label || "").trim().toLowerCase();
}

function truncateButtonText(text, maxLen = 75) {
  const safeText = String(text || "");
  if (safeText.length <= maxLen) return safeText;
  const cutoff = Math.max(0, maxLen - 3);
  return `${safeText.slice(0, cutoff)}...`;
}

let faqCache = null;

function slugify(text) {
  const base = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "faq";
}

function buildFaqItems() {
  if (faqCache) return faqCache;
  const used = new Map();
  const items = FAQ_ITEMS.map((item) => {
    const question = item.q?.en || item.q?.ru || "question";
    let id = item.id || slugify(question);
    if (used.has(id)) {
      let n = used.get(id) + 1;
      while (used.has(`${id}-${n}`)) n += 1;
      id = `${id}-${n}`;
      used.set(id, 0);
    }
    used.set(id, 0);
    return { ...item, id };
  });
  faqCache = items;
  return items;
}

function getFaqItems(lang) {
  const safeLang = LANGS.includes(lang) ? lang : DEFAULT_LANG;
  return buildFaqItems().map((item) => ({
    id: item.id,
    q: fixTextArtifacts(item.q?.[safeLang] || item.q?.[DEFAULT_LANG] || ""),
    a: fixTextArtifacts(item.a?.[safeLang] || item.a?.[DEFAULT_LANG] || ""),
  }));
}

function getFaqItemById(id, lang) {
  if (!id) return null;
  const safeLang = LANGS.includes(lang) ? lang : DEFAULT_LANG;
  const item = buildFaqItems().find((entry) => entry.id === id);
  if (!item) return null;
  return {
    id: item.id,
    q: fixTextArtifacts(item.q?.[safeLang] || item.q?.[DEFAULT_LANG] || ""),
    a: fixTextArtifacts(item.a?.[safeLang] || item.a?.[DEFAULT_LANG] || ""),
  };
}

function buildFaqListView(lang, page = 0) {
  const items = getFaqItems(lang);
  const totalPages = Math.max(1, Math.ceil(items.length / FAQ_PAGE_SIZE));
  const safePage = Math.max(0, Math.min(totalPages - 1, page));
  const start = safePage * FAQ_PAGE_SIZE;
  const slice = items.slice(start, start + FAQ_PAGE_SIZE);

  const blocks = [
    {
      type: "header",
      block_id: "faq_header",
      text: { type: "plain_text", text: t(lang, "faq.title") },
    },
    {
      type: "section",
      block_id: "faq_intro",
      text: { type: "mrkdwn", text: t(lang, "faq.intro") },
    },
  ];

  slice.forEach((item) => {
    blocks.push({
      type: "section",
      block_id: `faq_item_${item.id}`,
      text: { type: "mrkdwn", text: `• ${item.q}` },
      accessory: {
        type: "button",
        text: { type: "plain_text", text: "ⓘ" },
        action_id: ACTIONS.FAQ_TOPIC,
        value: item.id,
      },
    });
  });

  if (totalPages > 1) {
    blocks.push({
      type: "actions",
      block_id: "faq_nav",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: t(lang, "button.prev") },
          action_id: ACTIONS.FAQ_PAGE_PREV,
        },
        {
          type: "button",
          text: { type: "plain_text", text: t(lang, "button.next") },
          action_id: ACTIONS.FAQ_PAGE_NEXT,
        },
      ],
    });
    blocks.push({
      type: "context",
      block_id: "faq_page",
      elements: [
        {
          type: "mrkdwn",
          text: t(lang, "button.page", {
            page: safePage + 1,
            total: totalPages,
          }),
        },
      ],
    });
  }

  return {
    type: "modal",
    callback_id: "faq_list",
    private_metadata: JSON.stringify({ page: safePage }),
    title: { type: "plain_text", text: t(lang, "faq.title") },
    close: { type: "plain_text", text: t(lang, "settings.cancel") },
    blocks,
  };
}

function buildFaqDetailView(lang, id, page = 0) {
  const item = getFaqItemById(id, lang);
  const question = item?.q || t(lang, "faq.not_found");
  const answer = item?.a || t(lang, "faq.not_found");
  const safeId = item?.id || id || "unknown";

  return {
    type: "modal",
    callback_id: "faq_detail",
    private_metadata: JSON.stringify({ page }),
    title: { type: "plain_text", text: t(lang, "faq.title") },
    close: { type: "plain_text", text: t(lang, "settings.cancel") },
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: `${question}` },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: `${answer}` },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: t(lang, "faq.id_label", { id: safeId }),
          },
        ],
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: t(lang, "button.back") },
            action_id: ACTIONS.FAQ_BACK,
          },
        ],
      },
    ],
  };
}

function buildFaqCommandBlocks(lang, id) {
  const text = id
    ? t(lang, "faq.command_detail", { id })
    : t(lang, "faq.command_open");
  const buttonText = t(lang, "faq.open_button");
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: buttonText },
          action_id: id ? ACTIONS.FAQ_TOPIC : ACTIONS.FAQ_OPEN,
          value: id || undefined,
        },
      ],
    },
  ];
}

function buildTelegramFaqList(lang, page = 0) {
  const items = getFaqItems(lang);
  const totalPages = Math.max(1, Math.ceil(items.length / FAQ_PAGE_SIZE));
  const safePage = Math.max(0, Math.min(totalPages - 1, page));
  const start = safePage * FAQ_PAGE_SIZE;
  const slice = items.slice(start, start + FAQ_PAGE_SIZE);

  let text = `${t(lang, "faq.title")}\n${t(lang, "faq.intro")}`;
  const rows = [];

  slice.forEach((item) => {
    text += `\n• ${item.q}`;
    rows.push([
      Markup.button.callback(
        `? ${truncateButtonText(item.q, 40)}`,
        buildTelegramCallback(ACTIONS.FAQ_TOPIC, item.id, safePage, "")
      ),
    ]);
  });

  if (totalPages > 1) {
    rows.push([
      Markup.button.callback(
        t(lang, "button.prev"),
        buildTelegramCallback(ACTIONS.FAQ_PAGE_PREV, "list", safePage, "")
      ),
      Markup.button.callback(
        t(lang, "button.next"),
        buildTelegramCallback(ACTIONS.FAQ_PAGE_NEXT, "list", safePage, "")
      ),
    ]);
    rows.push([
      Markup.button.callback(
        t(lang, "button.page", { page: safePage + 1, total: totalPages }),
        buildTelegramCallback("noop", "list", safePage, "")
      ),
    ]);
  }

  return { text, reply_markup: Markup.inlineKeyboard(rows).reply_markup, page: safePage };
}

function buildTelegramFaqDetail(lang, id, page = 0) {
  const item = getFaqItemById(id, lang);
  if (!item) {
    return buildTelegramFaqList(lang, page);
  }
  const text =
    `${t(lang, "faq.title")}\n` +
    `\n? ${item.q}\n` +
    `${item.a}\n` +
    `${t(lang, "faq.id_label", { id: item.id })}`;

  const reply_markup = Markup.inlineKeyboard([
    [
      Markup.button.callback(
        t(lang, "button.back"),
        buildTelegramCallback(ACTIONS.FAQ_BACK, "list", page, "")
      ),
    ],
  ]).reply_markup;

  return { text, reply_markup, page };
}

function isFaqView(view) {
  return (
    view?.callback_id === "faq_list" || view?.callback_id === "faq_detail"
  );
}

function getFaqPageFromView(view) {
  if (!view?.private_metadata) return 0;
  try {
    const meta = JSON.parse(view.private_metadata);
    return Number(meta.page) || 0;
  } catch (err) {
    return 0;
  }
}

async function buildUserChoices(client, userIds) {
  const infos = await Promise.all(
    userIds.map(async (id) => {
      const info = await getUserDisplayInfo(client, id);
      return { id, label: info.label, handle: info.handle };
    })
  );

  const counts = new Map();
  for (const info of infos) {
    const key = normalizeLabelKey(info.label);
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  return infos.map((info) => {
    const key = normalizeLabelKey(info.label);
    let text = info.label;
    if ((counts.get(key) || 0) > 1) {
      if (info.handle) {
        text = `${info.label} (@${info.handle})`;
      } else {
        text = `${info.label} (${info.id})`;
      }
    }
    return { id: info.id, text: truncateButtonText(text) };
  });
}

function buildSelectBlocks({ channelId, actionId, text, options, placeholder }) {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text,
      },
    },
    {
      type: "actions",
      block_id: `${actionId}|${channelId}`,
      elements: [
        {
          type: "static_select",
          action_id: actionId,
          placeholder: {
            type: "plain_text",
            text: placeholder,
          },
          options,
        },
      ],
    },
  ];
}

function buildDetectiveModeBlocks(lang, channelId, text) {
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text },
    },
    {
      type: "actions",
      block_id: `${ACTIONS.DETECTIVE_MODE_CHECK}|${channelId}`,
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: t(lang, "button.detective_check") },
          action_id: ACTIONS.DETECTIVE_MODE_CHECK,
          value: channelId,
        },
        {
          type: "button",
          text: { type: "plain_text", text: t(lang, "button.detective_kill") },
          action_id: ACTIONS.DETECTIVE_MODE_KILL,
          value: channelId,
        },
      ],
    },
  ];
}

function buildTelegramRoleHelpKeyboard(lang, role) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(t(lang, "button.role_help"), `tg|role_help|${role}`)],
  ]).reply_markup;
}

function buildTelegramDetectiveModeKeyboard(lang, chatId) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        t(lang, "button.detective_check"),
        buildTelegramCallback(ACTIONS.DETECTIVE_MODE_CHECK, chatId)
      ),
      Markup.button.callback(
        t(lang, "button.detective_kill"),
        buildTelegramCallback(ACTIONS.DETECTIVE_MODE_KILL, chatId)
      ),
    ],
  ]).reply_markup;
}

function buildTelegramLangKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        t("en", "button.lang_en"),
        buildTelegramCallback(ACTIONS.LANG_SELECT_EN, "")
      ),
      Markup.button.callback(
        t("ru", "button.lang_ru"),
        buildTelegramCallback(ACTIONS.LANG_SELECT_RU, "")
      ),
    ],
  ]).reply_markup;
}

function buildTelegramDmHelpKeyboard(lang) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        t(lang, "button.help_add"),
        buildTelegramCallback(ACTIONS.DM_HELP_ADD, "")
      ),
      Markup.button.callback(
        t(lang, "button.help_commands"),
        buildTelegramCallback(ACTIONS.DM_HELP_COMMANDS, "")
      ),
    ],
    [
      Markup.button.callback(
        t(lang, "button.help_settings"),
        buildTelegramCallback(ACTIONS.DM_HELP_SETTINGS, "")
      ),
      Markup.button.callback(
        t(lang, "button.find_games"),
        buildTelegramCallback(ACTIONS.FIND_GAMES_OPEN, "")
      ),
    ],
    [
      Markup.button.callback(
        t(lang, "button.my_channels"),
        buildTelegramCallback(ACTIONS.MY_CHANNELS_OPEN, "")
      ),
      Markup.button.callback(
        t(lang, "button.faq"),
        buildTelegramCallback(ACTIONS.FAQ_OPEN, "")
      ),
    ],
  ]).reply_markup;
}

function buildPlayerButtonBlocks({
  channelId,
  actionId,
  text,
  players,
  page = 0,
  pageSize = BUTTON_PAGE_SIZE,
  lang,
  extraButtons,
}) {
  const safePlayers = players || [];
  const totalPages = Math.max(1, Math.ceil(safePlayers.length / pageSize));
  const safePage = Math.max(0, Math.min(totalPages - 1, page));
  const start = safePage * pageSize;
  const pagePlayers = safePlayers.slice(start, start + pageSize);

  const blocks = [
    {
      type: "section",
      text: { type: "mrkdwn", text },
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: t(lang, "select.target") }],
    },
  ];

  if (extraButtons && extraButtons.length) {
    blocks.push({
      type: "actions",
      block_id: `pg|${actionId}|${channelId}|${safePage}`,
      elements: extraButtons.map((button) => ({
        type: "button",
        text: { type: "plain_text", text: button.text, emoji: false },
        action_id: button.actionId || actionId,
        value: button.value,
        style: button.style,
      })),
    });
  }

  for (let i = 0; i < pagePlayers.length; i += BUTTONS_PER_ROW) {
    const row = pagePlayers.slice(i, i + BUTTONS_PER_ROW);
    blocks.push({
      type: "actions",
      block_id: `pg|${actionId}|${channelId}|${safePage}`,
      elements: row.map((player) => ({
        type: "button",
        text: { type: "plain_text", text: player.text, emoji: false },
        action_id: actionId,
        value: player.id,
      })),
    });
  }

  if (totalPages > 1) {
    blocks.push({
      type: "actions",
      block_id: `pg|${actionId}|${channelId}|${safePage}`,
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: t(lang, "button.prev") },
          action_id: ACTIONS.PAGE_PREV,
        },
        {
          type: "button",
          text: { type: "plain_text", text: t(lang, "button.next") },
          action_id: ACTIONS.PAGE_NEXT,
        },
      ],
    });
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: t(lang, "button.page", {
            page: safePage + 1,
            total: totalPages,
          }),
        },
      ],
    });
  }

  return blocks;
}

function buildTelegramCallback(action, chatId, page = 0, target = "") {
  const safeTarget = target === null || target === undefined ? "" : target;
  return `tg|${action}|${chatId}|${page}|${safeTarget}`;
}

function parseTelegramCallback(data) {
  const parts = String(data || "").split("|");
  if (parts.length < 2 || parts[0] !== "tg") return null;
  return {
    action: parts[1] || "",
    chatId: parts[2] || "",
    page: Number(parts[3]) || 0,
    target: parts[4] || "",
  };
}

function buildTelegramPlayerKeyboard({
  chatId,
  actionId,
  players,
  page = 0,
  pageSize = BUTTON_PAGE_SIZE,
  lang,
  extraButtons,
}) {
  const safePlayers = players || [];
  const totalPages = Math.max(1, Math.ceil(safePlayers.length / pageSize));
  const safePage = Math.max(0, Math.min(totalPages - 1, page));
  const start = safePage * pageSize;
  const pagePlayers = safePlayers.slice(start, start + pageSize);

  const rows = [];
  if (extraButtons && extraButtons.length) {
    rows.push(
      extraButtons.map((button) =>
        Markup.button.callback(
          button.text,
          buildTelegramCallback(button.actionId || actionId, chatId, safePage, button.value)
        )
      )
    );
  }

  for (let i = 0; i < pagePlayers.length; i += BUTTONS_PER_ROW) {
    const row = pagePlayers.slice(i, i + BUTTONS_PER_ROW);
    rows.push(
      row.map((player) =>
        Markup.button.callback(
          player.text,
          buildTelegramCallback(actionId, chatId, safePage, player.id)
        )
      )
    );
  }

  if (totalPages > 1) {
    rows.push([
      Markup.button.callback(
        t(lang, "button.prev"),
        buildTelegramCallback(ACTIONS.PAGE_PREV, chatId, safePage, actionId)
      ),
      Markup.button.callback(
        t(lang, "button.next"),
        buildTelegramCallback(ACTIONS.PAGE_NEXT, chatId, safePage, actionId)
      ),
    ]);
    rows.push([
      Markup.button.callback(
        t(lang, "button.page", { page: safePage + 1, total: totalPages }),
        buildTelegramCallback("noop", chatId, safePage, actionId)
      ),
    ]);
  }

  return Markup.inlineKeyboard(rows).reply_markup;
}

function isTelegramPrivateChat(ctx) {
  return ctx?.chat?.type === "private";
}

function getTelegramUserKeyFromCtx(ctx) {
  return makeUserKey(PLATFORM_TELEGRAM, ctx?.from?.id);
}

function getTelegramChannelKeyFromCtx(ctx) {
  return makeChannelKey(PLATFORM_TELEGRAM, ctx?.chat?.id);
}

function getUserCurrentGame(userId) {
  const games = [...gameCache.values()].filter(
    (game) => game && game.players?.[userId] && game.state !== "ended"
  );
  const active = games.find(
    (game) => game.state === "day" || game.state === "night"
  );
  return active || games[0] || null;
}

async function buildHomeBlocksDetailed(client, userId, lang) {
  const game = getUserCurrentGame(userId);
  const iconFile = getHomeIconFile(game, userId);
  const iconUrl = getAssetUrl(iconFile);
  const iconAlt =
    iconFile === ASSET_FILES.mafia
      ? "Mafia"
      : iconFile === ASSET_FILES.peace
      ? "Peace"
      : "MafiaBot";

  const taglineBlock = {
    type: "section",
    text: { type: "mrkdwn", text: t(lang, "home.tagline") },
  };
  if (iconUrl) {
    taglineBlock.accessory = {
      type: "image",
      image_url: iconUrl,
      alt_text: iconAlt,
    };
  }

  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: t(lang, "home.title") },
    },
    taglineBlock,
    { type: "divider" },
  ];

  const stats = await getUserStats(userId);
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text:
        `*${t(lang, "home.stats_title")}*\n` +
        t(lang, "home.stats_line", {
          games: stats.games,
          wins: stats.wins,
          losses: stats.losses,
          rate: computeWinRate(stats),
        }),
    },
  });

  const roleStats = await getUserRoleStats(userId);
  const roleLines =
    roleStats.length > 0
      ? roleStats
          .map((row) =>
            `${roleLabel(row.role, lang)} — ${row.wins}W/${row.losses}L (${computeWinRate(row)}%)`
          )
          .join("\n")
      : t(lang, "home.role_stats_empty");

  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*${t(lang, "home.role_stats_title")}*\n${roleLines}`,
    },
  });

  if (!game) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: t(lang, "home.current_none") },
    });
  } else {
    const channelStats = await getUserChannelStats(userId, game.channelId);
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `*${t(lang, "home.channel_stats_title")}*\n` +
          t(lang, "home.channel_stats_line", {
            games: channelStats.games,
            wins: channelStats.wins,
            losses: channelStats.losses,
            rate: computeWinRate(channelStats),
          }),
      },
    });

    const remaining =
      game.phaseDeadline !== null
        ? formatDuration(lang, game.phaseDeadline - now())
        : "-";
    const aliveCount = getAlivePlayerIds(game).length;
    const status = isPlayerAlive(game, userId)
      ? t(lang, "home.status_alive")
      : t(lang, "home.status_dead");
    const role = game.players?.[userId]?.role
      ? roleLabel(game.players[userId].role, lang)
      : t(lang, "home.role_unknown");
    const currentLine = t(lang, "home.current_line", {
      channel: channelMention(game.channelId),
      phase: formatPhaseLabel(lang, game),
      time: remaining,
      alive: aliveCount,
      status,
      role,
    });

    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*${t(lang, "home.current_title")}*\n${currentLine}` },
    });

    const history = game.history?.nights || [];
    const historyLines =
      history.length > 0
        ? history
            .slice(0, 3)
            .map((entry) =>
              t(lang, "home.history_line", {
                round: entry.round,
                text: entry[lang] || entry.en || entry.ru,
              })
            )
            .join("\n")
        : t(lang, "home.history_empty");

    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${t(lang, "home.history_title")}*\n${historyLines}`,
      },
    });
  }

  blocks.push({ type: "divider" });
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: t(lang, "home.quickstart") },
  });
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: t(lang, "home.controls") },
  });
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: t(lang, "home.gameplay") },
  });
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: t(lang, "home.features") },
  });
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: t(lang, "home.tips") },
  });

  return blocks;
}

async function buildHomeViewDetailed(client, userId, lang) {
  const blocks = await buildHomeBlocksDetailed(client, userId, lang);
  return {
    type: "home",
    blocks,
  };
}

async function buildHomeViewBilingualDetailed(client, userId, primaryLang) {
  const primary = await buildHomeBlocksDetailed(client, userId, primaryLang);
  const secondaryLang = primaryLang === "ru" ? "en" : "ru";
  const secondary = await buildHomeBlocksDetailed(client, userId, secondaryLang);
  const blocks = [...primary, { type: "divider" }, ...secondary];
  return {
    type: "home",
    blocks,
  };
}

async function buildTelegramHomeText(userId, lang) {
  const stats = await getUserStats(userId);
  const roleStats = await getUserRoleStats(userId);
  const roleLines =
    roleStats.length > 0
      ? roleStats
          .map((row) => {
            const label = roleLabel(row.role, lang);
            const rate = computeWinRate(row);
            return `${label}: ${row.wins}W/${row.losses}L (${rate}%)`;
          })
          .join("\n")
      : t(lang, "home.role_stats_empty");

  const currentGame = getUserCurrentGame(userId);
  let currentLine = t(lang, "home.current_none");
  if (currentGame) {
    const remaining = currentGame.phaseDeadline
      ? formatDuration(lang, currentGame.phaseDeadline - now())
      : "-";
    const status = isPlayerAlive(currentGame, userId)
      ? t(lang, "home.status_alive")
      : t(lang, "home.status_dead");
    const role = currentGame.players?.[userId]?.role
      ? roleLabel(currentGame.players[userId].role, lang)
      : t(lang, "home.role_unknown");
    currentLine = t(lang, "home.current_line", {
      channel: channelMention(currentGame.channelId),
      phase: t(lang, `state.${currentGame.state}`),
      time: remaining,
      alive: getAlivePlayerIds(currentGame).length,
      status,
      role,
    });
  }

  let historyLines = t(lang, "home.history_empty");
  if (currentGame?.history?.nights?.length) {
    historyLines = currentGame.history.nights
      .map((entry) =>
        t(lang, "home.history_line", {
          round: entry.round,
          text: lang === "ru" ? entry.ru : entry.en,
        })
      )
      .join("\n");
  }

  return (
    `${t(lang, "home.title")}\n` +
    `\n${t(lang, "home.stats_title")}\n` +
    t(lang, "home.stats_line", {
      games: stats.games,
      wins: stats.wins,
      losses: stats.losses,
      rate: computeWinRate(stats),
    }) +
    `\n\n${t(lang, "home.role_stats_title")}\n` +
    roleLines +
    `\n\n${t(lang, "home.current_title")}\n` +
    currentLine +
    `\n\n${t(lang, "home.history_title")}\n` +
    historyLines
  );
}

async function publishHomeForUser(client, userId) {
  if (!userId) return;
  const langInfo = await getUserLangInfo(userId);
  const view = langInfo.explicit
    ? await buildHomeViewDetailed(client, userId, langInfo.lang)
    : await buildHomeViewBilingualDetailed(client, userId, DEFAULT_LANG);
  await client.views.publish({
    user_id: userId,
    view,
  });
}

async function updateHomeForUsers(client, userIds) {
  const unique = [...new Set(userIds || [])]
    .filter(Boolean)
    .filter((id) => !isTestUserId(id))
    .filter((id) => !isTelegramKey(id));
  for (const userId of unique) {
    try {
      await publishHomeForUser(client, userId);
    } catch (err) {
      console.error("Failed to update home for user:", userId, err?.data || err);
    }
  }
}

async function updateHomeForGame(client, game) {
  if (!game) return;
  await updateHomeForUsers(client, Object.keys(game.players || {}));
}

async function buildLobbyBlocks(client, game, lang) {
  const playerIds = Object.keys(game.players);
  const readyCount = Object.values(game.players).filter((p) => p.ready).length;
  const playerList = await formatUserListLocalized(
    client,
    game,
    playerIds,
    lang
  );
  const remaining =
    game.phaseDeadline !== null
      ? formatDuration(lang, game.phaseDeadline - now())
      : "-";

  const summaryText =
    `${t(lang, "lobby.host", {
      host: await getNameOrMention(client, game, game.hostId, lang),
    })}\n` +
    `${t(lang, "lobby.players", {
      count: playerIds.length,
      min: game.config.minPlayers,
    })}\n` +
    `${t(lang, "lobby.ready", {
      ready: readyCount,
      total: playerIds.length,
    })}\n` +
    `${t(lang, "lobby.start_in", { time: remaining })}`;

  return [
    {
      type: "header",
      text: { type: "plain_text", text: t(lang, "lobby.title") },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: summaryText },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: t(lang, "lobby.player_list", { list: playerList }),
        },
      ],
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: t(lang, "button.join") },
          action_id: ACTIONS.LOBBY_JOIN,
          value: game.channelId,
        },
        {
          type: "button",
          text: { type: "plain_text", text: t(lang, "button.leave") },
          action_id: ACTIONS.LOBBY_LEAVE,
          value: game.channelId,
        },
        {
          type: "button",
          text: { type: "plain_text", text: t(lang, "button.start") },
          style: "primary",
          action_id: ACTIONS.LOBBY_START,
          value: game.channelId,
        },
        {
          type: "button",
          text: { type: "plain_text", text: t(lang, "button.ready") },
          action_id: ACTIONS.LOBBY_READY,
          value: game.channelId,
        },
        {
          type: "button",
          text: { type: "plain_text", text: t(lang, "button.extend") },
          action_id: ACTIONS.LOBBY_EXTEND,
          value: game.channelId,
        },
      ],
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: t(lang, "button.end") },
          style: "danger",
          action_id: ACTIONS.LOBBY_END,
          value: game.channelId,
        },
      ],
    },
  ];
}

async function buildTelegramLobbyPanel(game, lang) {
  const playerIds = Object.keys(game.players);
  const readyCount = Object.values(game.players).filter((p) => p.ready).length;
  const playerList = await formatUserListPlain(null, playerIds);
  const remaining =
    game.phaseDeadline !== null
      ? formatDuration(lang, game.phaseDeadline - now())
      : "-";

  const text =
    `${t(lang, "lobby.title")}\n` +
    `${t(lang, "lobby.host", {
      host: await getUserLabel(null, game.hostId),
    })}\n` +
    `${t(lang, "lobby.players", {
      count: playerIds.length,
      min: game.config.minPlayers,
    })}\n` +
    `${t(lang, "lobby.ready", {
      ready: readyCount,
      total: playerIds.length,
    })}\n` +
    `${playerList}\n` +
    `${t(lang, "lobby.start_in", { time: remaining })}`;

  const rawChatId = stripPlatformPrefix(game.channelId);
  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback(t(lang, "button.join"), `tg|lobby_join|${rawChatId}`),
      Markup.button.callback(t(lang, "button.leave"), `tg|lobby_leave|${rawChatId}`),
    ],
    [
      Markup.button.callback(t(lang, "button.start"), `tg|lobby_start|${rawChatId}`),
      Markup.button.callback(t(lang, "button.ready"), `tg|lobby_ready|${rawChatId}`),
    ],
    [
      Markup.button.callback(t(lang, "button.extend"), `tg|lobby_extend|${rawChatId}`),
      Markup.button.callback(t(lang, "button.end"), `tg|lobby_end|${rawChatId}`),
    ],
  ]).reply_markup;

  return { text, reply_markup: keyboard };
}

function buildDmHelpBlocks(lang, text) {
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: t(lang, "button.help_add") },
          action_id: ACTIONS.DM_HELP_ADD,
        },
        {
          type: "button",
          text: { type: "plain_text", text: t(lang, "button.help_commands") },
          action_id: ACTIONS.DM_HELP_COMMANDS,
        },
        {
          type: "button",
          text: { type: "plain_text", text: t(lang, "button.help_settings") },
          action_id: ACTIONS.DM_HELP_SETTINGS,
        },
        {
          type: "button",
          text: { type: "plain_text", text: t(lang, "button.find_games") },
          action_id: ACTIONS.FIND_GAMES_OPEN,
        },
        {
          type: "button",
          text: { type: "plain_text", text: t(lang, "button.my_channels") },
          action_id: ACTIONS.MY_CHANNELS_OPEN,
        },
        {
          type: "button",
          text: { type: "plain_text", text: t(lang, "button.faq") },
          action_id: ACTIONS.FAQ_OPEN,
        },
      ],
    },
  ];
}

function buildDevPanelBlocks(lang, enabled) {
  const status = enabled
    ? t(lang, "dev.panel.status_on")
    : t(lang, "dev.panel.status_off");
  const buttonText = enabled
    ? t(lang, "dev.panel.button_disable")
    : t(lang, "dev.panel.button_enable");
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${t(lang, "dev.panel.title")}*\n${status}`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: buttonText },
          action_id: ACTIONS.DEV_MAINT_TOGGLE,
          style: enabled ? "danger" : "primary",
        },
      ],
    },
  ];
}

function buildLangSelectBlocks(text) {
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: t("en", "button.lang_en") },
          action_id: ACTIONS.LANG_SELECT_EN,
        },
        {
          type: "button",
          text: { type: "plain_text", text: t("ru", "button.lang_ru") },
          action_id: ACTIONS.LANG_SELECT_RU,
        },
      ],
    },
  ];
}

function buildChannelListingPromptBlocks(lang, channelId, bilingual = false) {
  const channel = channelMention(channelId);
  const text = bilingual
    ? `${t("en", "find.prompt_public", { channel })}\n${t("ru", "find.prompt_public", { channel })}`
    : t(lang, "find.prompt_public", { channel });
  const publicLabel = bilingual
    ? `${t("en", "button.public")} / ${t("ru", "button.public")}`
    : t(lang, "button.public");
  const privateLabel = bilingual
    ? `${t("en", "button.private")} / ${t("ru", "button.private")}`
    : t(lang, "button.private");

  return [
    {
      type: "section",
      text: { type: "mrkdwn", text },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: publicLabel },
          style: "primary",
          action_id: ACTIONS.CHANNEL_LIST_PUBLIC,
          value: channelId,
        },
        {
          type: "button",
          text: { type: "plain_text", text: privateLabel },
          action_id: ACTIONS.CHANNEL_LIST_PRIVATE,
          value: channelId,
        },
      ],
    },
  ];
}

function parseFindContext(action) {
  const blockId = action?.block_id || "";
  if (!blockId.startsWith("find|")) return null;
  const parts = blockId.split("|");
  if (parts.length === 3) {
    return {
      filter: parts[1] || "recruiting",
      lang: "all",
      page: Number(parts[2]) || 0,
    };
  }
  return {
    filter: parts[1] || "recruiting",
    lang: parts[2] || "all",
    page: Number(parts[3]) || 0,
  };
}

async function getFindEntries(filter, lang, langFilter, platform) {
  const rows = await listListedChannels();
  const entries = [];
  rows.forEach((row) => {
    const channelId = row.channel_id;
    if (platform && getPlatformFromKey(channelId) !== platform) return;
    if (row.channel_type === "group" && getPlatformFromKey(channelId) === PLATFORM_SLACK)
      return;
    const settings = parseSettingsJson(row.settings_json);
    const game = getGame(channelId);
    const channelLang = game?.config?.channelLang
      ? normalizeChannelLang(game.config.channelLang)
      : getChannelLangFromSettings(settings);
    if (langFilter && langFilter !== "all" && channelLang !== langFilter) return;
    let status = "inactive";
    if (game && game.state && game.state !== "ended") {
      if (game.state === "lobby") status = "recruiting";
      if (game.state === "day" || game.state === "night") status = "active";
    }
    if (filter === "active" && status !== "active") return;
    if (filter === "recruiting" && status !== "recruiting") return;
    if (filter === "inactive" && status !== "inactive") return;

    let statusText = t(lang, "find.status_inactive");
    if (status === "active" && game) {
      statusText = t(lang, "find.status_active", {
        phase: t(lang, `state.${game.state}`),
        round: game.round,
        alive: getAlivePlayerIds(game).length,
      });
    }
    if (status === "recruiting" && game) {
      const remaining = game.phaseDeadline
        ? Math.max(0, game.phaseDeadline - now())
        : 0;
      statusText = t(lang, "find.status_recruiting", {
        count: Object.keys(game.players).length,
        min: game.config.minPlayers,
        time: formatDuration(lang, remaining),
      });
    }

    const langTag =
      channelLang === "ru"
        ? t(lang, "find.lang_label_ru")
        : t(lang, "find.lang_label_en");
    entries.push({
      channelId,
      text: `• ${channelMention(channelId)} (${langTag}) — ${statusText}`,
    });
  });
  return entries;
}

async function buildFindGamesBlocks(lang, filter, page, langFilter) {
  const entries = await getFindEntries(filter, lang, langFilter, PLATFORM_SLACK);
  const totalPages = Math.max(1, Math.ceil(entries.length / FIND_PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const slice = entries.slice(
    safePage * FIND_PAGE_SIZE,
    safePage * FIND_PAGE_SIZE + FIND_PAGE_SIZE
  );
  const listText =
    slice.length > 0 ? slice.map((e) => e.text).join("\n") : t(lang, "find.empty");

  const baseBlockId = `find|${filter}|${langFilter || "all"}|${safePage}`;
  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: t(lang, "find.title") },
    },
    {
      type: "actions",
      block_id: `${baseBlockId}|filters`,
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: t(lang, "button.filter_active") },
          action_id: ACTIONS.FIND_FILTER_ACTIVE,
          style: filter === "active" ? "primary" : undefined,
        },
        {
          type: "button",
          text: { type: "plain_text", text: t(lang, "button.filter_recruiting") },
          action_id: ACTIONS.FIND_FILTER_RECRUITING,
          style: filter === "recruiting" ? "primary" : undefined,
        },
        {
          type: "button",
          text: { type: "plain_text", text: t(lang, "button.filter_inactive") },
          action_id: ACTIONS.FIND_FILTER_INACTIVE,
          style: filter === "inactive" ? "primary" : undefined,
        },
      ],
    },
    {
      type: "actions",
      block_id: `${baseBlockId}|lang`,
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: t(lang, "button.filter_lang_all") },
          action_id: ACTIONS.FIND_LANG_ALL,
          style: (langFilter || "all") === "all" ? "primary" : undefined,
        },
        {
          type: "button",
          text: { type: "plain_text", text: t(lang, "button.filter_lang_en") },
          action_id: ACTIONS.FIND_LANG_EN,
          style: langFilter === "en" ? "primary" : undefined,
        },
        {
          type: "button",
          text: { type: "plain_text", text: t(lang, "button.filter_lang_ru") },
          action_id: ACTIONS.FIND_LANG_RU,
          style: langFilter === "ru" ? "primary" : undefined,
        },
      ],
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: listText },
    },
  ];

  if (totalPages > 1) {
    blocks.push({
      type: "actions",
      block_id: `${baseBlockId}|page`,
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: t(lang, "button.prev") },
          action_id: ACTIONS.FIND_PAGE_PREV,
        },
        {
          type: "button",
          text: { type: "plain_text", text: t(lang, "button.next") },
          action_id: ACTIONS.FIND_PAGE_NEXT,
        },
      ],
    });
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: t(lang, "button.page", {
            page: safePage + 1,
            total: totalPages,
          }),
        },
      ],
    });
  }

  return blocks;
}

async function buildTelegramFindGamesMessage(lang, filter, page, langFilter) {
  const entries = await getFindEntries(filter, lang, langFilter, PLATFORM_TELEGRAM);
  const totalPages = Math.max(1, Math.ceil(entries.length / FIND_PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const slice = entries.slice(
    safePage * FIND_PAGE_SIZE,
    safePage * FIND_PAGE_SIZE + FIND_PAGE_SIZE
  );
  const listText =
    slice.length > 0 ? slice.map((e) => e.text).join("\n") : t(lang, "find.empty");

  const header = t(lang, "find.title");
  const text = `${header}\n${listText}`;

  const currentFilter = filter || "recruiting";
  const currentLang = langFilter || "all";

  const rows = [
    [
      Markup.button.callback(
        t(lang, "button.filter_active"),
        buildTelegramCallback(ACTIONS.FIND_FILTER_ACTIVE, currentFilter, safePage, currentLang)
      ),
      Markup.button.callback(
        t(lang, "button.filter_recruiting"),
        buildTelegramCallback(ACTIONS.FIND_FILTER_RECRUITING, currentFilter, safePage, currentLang)
      ),
      Markup.button.callback(
        t(lang, "button.filter_inactive"),
        buildTelegramCallback(ACTIONS.FIND_FILTER_INACTIVE, currentFilter, safePage, currentLang)
      ),
    ],
    [
      Markup.button.callback(
        t(lang, "button.filter_lang_all"),
        buildTelegramCallback(ACTIONS.FIND_LANG_ALL, currentFilter, safePage, currentLang)
      ),
      Markup.button.callback(
        t(lang, "button.filter_lang_en"),
        buildTelegramCallback(ACTIONS.FIND_LANG_EN, currentFilter, safePage, currentLang)
      ),
      Markup.button.callback(
        t(lang, "button.filter_lang_ru"),
        buildTelegramCallback(ACTIONS.FIND_LANG_RU, currentFilter, safePage, currentLang)
      ),
    ],
  ];

  if (totalPages > 1) {
    rows.push([
      Markup.button.callback(
        t(lang, "button.prev"),
        buildTelegramCallback(ACTIONS.FIND_PAGE_PREV, currentFilter, safePage, currentLang)
      ),
      Markup.button.callback(
        t(lang, "button.next"),
        buildTelegramCallback(ACTIONS.FIND_PAGE_NEXT, currentFilter, safePage, currentLang)
      ),
    ]);
    rows.push([
      Markup.button.callback(
        t(lang, "button.page", { page: safePage + 1, total: totalPages }),
        buildTelegramCallback("noop", currentFilter, safePage, currentLang)
      ),
    ]);
  }

  return { text, reply_markup: Markup.inlineKeyboard(rows).reply_markup };
}

async function buildTelegramMyChannelsMessage(userId, lang, page) {
  const rows = await listOwnedChannels(userId);
  const totalPages = Math.max(1, Math.ceil(rows.length / MY_CHANNELS_PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const slice = rows.slice(
    safePage * MY_CHANNELS_PAGE_SIZE,
    safePage * MY_CHANNELS_PAGE_SIZE + MY_CHANNELS_PAGE_SIZE
  );

  let text = t(lang, "my_channels.title");
  const keyboardRows = [];

  if (slice.length === 0) {
    text = `${text}\n${t(lang, "my_channels.empty")}`;
  } else {
    for (const row of slice) {
      const info = await getChannelInfo(null, row.channel_id);
      const name = info?.name ? `#${info.name}` : row.channel_id;
      const settings = parseSettingsJson(row.settings_json);
      const channelLang = getChannelLangFromSettings(settings);
      const langTag = channelLang === "ru" ? "RU" : "ENG";
      const statusKey = row.listed ? "my_channels.status_public" : "my_channels.status_private";
      text += `\n${t(lang, statusKey)} — ${channelMention(row.channel_id)} (${langTag})`;
      const rawId = stripPlatformPrefix(row.channel_id);
      keyboardRows.push([
        Markup.button.callback(
          truncateButtonText(name),
          buildTelegramCallback(ACTIONS.CHANNEL_EDIT_OPEN, rawId, safePage, "")
        ),
      ]);
    }
  }

  if (totalPages > 1) {
    keyboardRows.push([
      Markup.button.callback(
        t(lang, "button.prev"),
        buildTelegramCallback(ACTIONS.MY_CHANNELS_PAGE_PREV, "list", safePage, "")
      ),
      Markup.button.callback(
        t(lang, "button.next"),
        buildTelegramCallback(ACTIONS.MY_CHANNELS_PAGE_NEXT, "list", safePage, "")
      ),
    ]);
    keyboardRows.push([
      Markup.button.callback(
        t(lang, "button.page", { page: safePage + 1, total: totalPages }),
        buildTelegramCallback("noop", "list", safePage, "")
      ),
    ]);
  }

  const reply_markup = keyboardRows.length
    ? Markup.inlineKeyboard(keyboardRows).reply_markup
    : undefined;

  return { text, reply_markup };
}

async function buildTelegramChannelEditMessage(channelId, lang) {
  const pref =
    (await getChannelPref(channelId)) || (await ensureChannelPref(channelId));
  const settings = parseSettingsJson(pref?.settings_json);
  const channelLang = getChannelLangFromSettings(settings);
  const listed = Boolean(pref?.listed);
  const privacyLabel = listed
    ? t(lang, "settings.privacy_public")
    : t(lang, "settings.privacy_private");
  const langLabel =
    channelLang === "ru"
      ? t(lang, "settings.channel_lang_ru")
      : t(lang, "settings.channel_lang_en");

  const text =
    `${t(lang, "my_channels.edit_intro", {
      channel: channelMention(channelId),
    })}\n` +
    `${t(lang, "settings.privacy_label")}: ${privacyLabel}\n` +
    `${t(lang, "settings.channel_lang")}: ${langLabel}`;

  const rawId = stripPlatformPrefix(channelId);
  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback(
        t(lang, "settings.privacy_public"),
        buildTelegramCallback(ACTIONS.CHANNEL_LIST_PUBLIC, rawId)
      ),
      Markup.button.callback(
        t(lang, "settings.privacy_private"),
        buildTelegramCallback(ACTIONS.CHANNEL_LIST_PRIVATE, rawId)
      ),
    ],
    [
      Markup.button.callback(
        t(lang, "settings.channel_lang_en"),
        buildTelegramCallback(ACTIONS.CHANNEL_LANG_EN, rawId)
      ),
      Markup.button.callback(
        t(lang, "settings.channel_lang_ru"),
        buildTelegramCallback(ACTIONS.CHANNEL_LANG_RU, rawId)
      ),
    ],
    [
      Markup.button.callback(
        t(lang, "button.back"),
        buildTelegramCallback(ACTIONS.MY_CHANNELS_OPEN, "list")
      ),
    ],
  ]).reply_markup;

  return { text, reply_markup: keyboard };
}

function parseMyChannelsContext(action) {
  const blockId = action?.block_id || "";
  if (!blockId.startsWith("mych|")) return null;
  const parts = blockId.split("|");
  return {
    page: Number(parts[1]) || 0,
  };
}

function getDefaultChannelSettings() {
  return {
    dayMinutes: DEFAULTS.DAY_MINUTES,
    nightMinutes: DEFAULTS.NIGHT_MINUTES,
    lobbyMinutes: DEFAULTS.LOBBY_MINUTES,
    minPlayers: DEFAULTS.MIN_PLAYERS,
    extendPolicy: DEFAULTS.EXTEND_POLICY,
    warningsSec: DEFAULTS.WARNINGS_MS.map((ms) => Math.round(ms / 1000)),
    autoShorten: DEFAULTS.AUTO_SHORTEN,
    whisperEnabled: DEFAULTS.WHISPER_ENABLED,
    allowAbstain: DEFAULTS.ALLOW_ABSTAIN,
    allowNoKill: DEFAULTS.ALLOW_NO_KILL,
    doctorSelfSaveLimit: DEFAULTS.DOCTOR_SELF_SAVE_LIMIT,
    channelLang: DEFAULT_LANG,
  };
}

function normalizeChannelSettings(settings) {
  const defaults = getDefaultChannelSettings();
  if (!settings) return defaults;
  const normalized = { ...defaults };
  const maybeNumber = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const setIfNumber = (key) => {
    const num = maybeNumber(settings[key]);
    if (num !== null) normalized[key] = num;
  };

  setIfNumber("dayMinutes");
  setIfNumber("nightMinutes");
  setIfNumber("lobbyMinutes");
  setIfNumber("minPlayers");
  setIfNumber("doctorSelfSaveLimit");

  if (settings.extendPolicy === "host" || settings.extendPolicy === "any") {
    normalized.extendPolicy = settings.extendPolicy;
  }

  if (Array.isArray(settings.warningsSec)) {
    const warnings = settings.warningsSec
      .map((val) => Number(val))
      .filter((val) => Number.isFinite(val) && val > 0);
    if (warnings.length > 0) normalized.warningsSec = warnings;
  }

  if (settings.autoShorten !== undefined)
    normalized.autoShorten = Boolean(settings.autoShorten);
  if (settings.whisperEnabled !== undefined)
    normalized.whisperEnabled = Boolean(settings.whisperEnabled);
  if (settings.allowAbstain !== undefined)
    normalized.allowAbstain = Boolean(settings.allowAbstain);
  if (settings.allowNoKill !== undefined)
    normalized.allowNoKill = Boolean(settings.allowNoKill);
  if (settings.channelLang === "en" || settings.channelLang === "ru") {
    normalized.channelLang = settings.channelLang;
  }

  return normalized;
}

async function buildMyChannelsBlocks(client, userId, lang, page) {
  const rows = await listOwnedChannels(userId);
  const totalPages = Math.max(1, Math.ceil(rows.length / MY_CHANNELS_PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const slice = rows.slice(
    safePage * MY_CHANNELS_PAGE_SIZE,
    safePage * MY_CHANNELS_PAGE_SIZE + MY_CHANNELS_PAGE_SIZE
  );

  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: t(lang, "my_channels.title") },
    },
  ];

  if (slice.length === 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: t(lang, "my_channels.empty") },
    });
    return blocks;
  }

  for (const row of slice) {
    const info = await getChannelInfo(client, row.channel_id);
    const name = info?.name ? `#${info.name}` : row.channel_id;
    const settings = parseSettingsJson(row.settings_json);
    const channelLang = getChannelLangFromSettings(settings);
    const langTag = channelLang === "ru" ? "RU" : "ENG";
    const statusKey = row.listed ? "my_channels.status_public" : "my_channels.status_private";
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${t(lang, statusKey)} — ${channelMention(row.channel_id)} (${langTag})`,
      },
      accessory: {
        type: "button",
        text: { type: "plain_text", text: truncateButtonText(name) },
        action_id: ACTIONS.CHANNEL_EDIT_OPEN,
        value: row.channel_id,
      },
    });
  }

  if (totalPages > 1) {
    blocks.push({
      type: "actions",
      block_id: `mych|${safePage}`,
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: t(lang, "button.prev") },
          action_id: ACTIONS.MY_CHANNELS_PAGE_PREV,
        },
        {
          type: "button",
          text: { type: "plain_text", text: t(lang, "button.next") },
          action_id: ACTIONS.MY_CHANNELS_PAGE_NEXT,
        },
      ],
    });
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: t(lang, "button.page", {
            page: safePage + 1,
            total: totalPages,
          }),
        },
      ],
    });
  }

  return blocks;
}

function buildFaqHelpSection(lang, label, faqId) {
  return {
    type: "section",
    text: { type: "mrkdwn", text: `*${label}*` },
    accessory: {
      type: "button",
      text: { type: "plain_text", text: " " },
      action_id: ACTIONS.FAQ_TOPIC,
      value: faqId,
    },
  };
}

function buildChannelEditView(lang, channelId, settings, listed) {
  const normalized = normalizeChannelSettings(settings);
  const warnings = normalized.warningsSec || [];
  const warn1 = warnings[0] || 60;
  const warn2 = warnings[1] || 30;

  const privacyOptions = [
    {
      text: { type: "plain_text", text: t(lang, "settings.privacy_public") },
      value: "public",
    },
    {
      text: { type: "plain_text", text: t(lang, "settings.privacy_private") },
      value: "private",
    },
  ];
  const extendOptions = [
    {
      text: { type: "plain_text", text: t(lang, "settings.extend_host") },
      value: "host",
    },
    {
      text: { type: "plain_text", text: t(lang, "settings.extend_any") },
      value: "any",
    },
  ];
  const toggleOptions = [
    {
      text: { type: "plain_text", text: t(lang, "settings.toggle_on") },
      value: "on",
    },
    {
      text: { type: "plain_text", text: t(lang, "settings.toggle_off") },
      value: "off",
    },
  ];
  const langOptions = [
    {
      text: { type: "plain_text", text: t(lang, "settings.channel_lang_en") },
      value: "en",
    },
    {
      text: { type: "plain_text", text: t(lang, "settings.channel_lang_ru") },
      value: "ru",
    },
  ];

  return {
    type: "modal",
    callback_id: "channel_edit",
    private_metadata: JSON.stringify({ channelId }),
    title: { type: "plain_text", text: t(lang, "settings.title") },
    submit: { type: "plain_text", text: t(lang, "settings.submit") },
    close: { type: "plain_text", text: t(lang, "settings.cancel") },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: t(lang, "my_channels.edit_intro", {
            channel: channelMention(channelId),
          }),
        },
      },
      buildFaqHelpSection(lang, t(lang, "settings.privacy_label"), "privacy"),
      {
        type: "input",
        block_id: "privacy",
        label: { type: "plain_text", text: t(lang, "settings.privacy_label") },
        element: {
          type: "static_select",
          action_id: "privacy_select",
          options: privacyOptions,
          initial_option: listed ? privacyOptions[0] : privacyOptions[1],
        },
      },
      buildFaqHelpSection(
        lang,
        t(lang, "settings.channel_lang"),
        "channel-language"
      ),
      {
        type: "input",
        block_id: "channel_lang",
        label: { type: "plain_text", text: t(lang, "settings.channel_lang") },
        element: {
          type: "static_select",
          action_id: "channel_lang",
          options: langOptions,
          initial_option:
            normalized.channelLang === "ru" ? langOptions[1] : langOptions[0],
        },
      },
      buildFaqHelpSection(lang, t(lang, "settings.day_minutes"), "durations"),
      {
        type: "input",
        block_id: "day_minutes",
        label: { type: "plain_text", text: t(lang, "settings.day_minutes") },
        element: {
          type: "plain_text_input",
          action_id: "day_minutes",
          initial_value: String(normalized.dayMinutes),
        },
      },
      {
        type: "input",
        block_id: "night_minutes",
        label: { type: "plain_text", text: t(lang, "settings.night_minutes") },
        element: {
          type: "plain_text_input",
          action_id: "night_minutes",
          initial_value: String(normalized.nightMinutes),
        },
      },
      {
        type: "input",
        block_id: "lobby_minutes",
        label: { type: "plain_text", text: t(lang, "settings.lobby_minutes") },
        element: {
          type: "plain_text_input",
          action_id: "lobby_minutes",
          initial_value: String(normalized.lobbyMinutes),
        },
      },
      buildFaqHelpSection(lang, t(lang, "settings.min_players"), "min-players"),
      {
        type: "input",
        block_id: "min_players",
        label: { type: "plain_text", text: t(lang, "settings.min_players") },
        element: {
          type: "plain_text_input",
          action_id: "min_players",
          initial_value: String(normalized.minPlayers),
        },
      },
      buildFaqHelpSection(lang, t(lang, "settings.extend_policy"), "extend-policy"),
      {
        type: "input",
        block_id: "extend_policy",
        label: { type: "plain_text", text: t(lang, "settings.extend_policy") },
        element: {
          type: "static_select",
          action_id: "extend_policy",
          options: extendOptions,
          initial_option:
            normalized.extendPolicy === "any" ? extendOptions[1] : extendOptions[0],
        },
      },
      buildFaqHelpSection(lang, t(lang, "settings.warning_1"), "warnings"),
      {
        type: "input",
        block_id: "warning_1",
        label: { type: "plain_text", text: t(lang, "settings.warning_1") },
        element: {
          type: "plain_text_input",
          action_id: "warning_1",
          initial_value: String(warn1),
        },
      },
      {
        type: "input",
        block_id: "warning_2",
        label: { type: "plain_text", text: t(lang, "settings.warning_2") },
        element: {
          type: "plain_text_input",
          action_id: "warning_2",
          initial_value: String(warn2),
        },
      },
      buildFaqHelpSection(lang, t(lang, "settings.auto_shorten"), "auto-shorten"),
      {
        type: "input",
        block_id: "auto_shorten",
        label: { type: "plain_text", text: t(lang, "settings.auto_shorten") },
        element: {
          type: "static_select",
          action_id: "auto_shorten",
          options: toggleOptions,
          initial_option: normalized.autoShorten ? toggleOptions[0] : toggleOptions[1],
        },
      },
      buildFaqHelpSection(lang, t(lang, "settings.whisper_enabled"), "whisper"),
      {
        type: "input",
        block_id: "whisper_enabled",
        label: { type: "plain_text", text: t(lang, "settings.whisper_enabled") },
        element: {
          type: "static_select",
          action_id: "whisper_enabled",
          options: toggleOptions,
          initial_option: normalized.whisperEnabled ? toggleOptions[0] : toggleOptions[1],
        },
      },
      buildFaqHelpSection(lang, t(lang, "settings.allow_abstain"), "abstain"),
      {
        type: "input",
        block_id: "allow_abstain",
        label: { type: "plain_text", text: t(lang, "settings.allow_abstain") },
        element: {
          type: "static_select",
          action_id: "allow_abstain",
          options: toggleOptions,
          initial_option: normalized.allowAbstain ? toggleOptions[0] : toggleOptions[1],
        },
      },
      buildFaqHelpSection(lang, t(lang, "settings.allow_no_kill"), "no-kill"),
      {
        type: "input",
        block_id: "allow_no_kill",
        label: { type: "plain_text", text: t(lang, "settings.allow_no_kill") },
        element: {
          type: "static_select",
          action_id: "allow_no_kill",
          options: toggleOptions,
          initial_option: normalized.allowNoKill ? toggleOptions[0] : toggleOptions[1],
        },
      },
      buildFaqHelpSection(
        lang,
        t(lang, "settings.doctor_self_save"),
        "doctor-self-save"
      ),
      {
        type: "input",
        block_id: "doctor_self_save",
        label: { type: "plain_text", text: t(lang, "settings.doctor_self_save") },
        element: {
          type: "plain_text_input",
          action_id: "doctor_self_save",
          initial_value: String(normalized.doctorSelfSaveLimit),
        },
      },
    ],
  };
}

function readViewValue(view, blockId, actionId) {
  const block = view.state?.values?.[blockId]?.[actionId];
  if (!block) return null;
  if (block.type === "plain_text_input") return block.value;
  if (block.selected_option) return block.selected_option.value;
  return null;
}

function isBotJoinEvent(event) {
  if (event?.type === "member_joined_channel") {
    if (BOT_USER_ID && event.user === BOT_USER_ID) return true;
    return false;
  }
  if (!event?.subtype) return false;
  const subtype = event.subtype;
  const joinSubtypes = [
    "channel_join",
    "group_join",
    "bot_add",
    "bot_join",
    "bot_added",
    "member_joined_channel",
  ];
  if (!joinSubtypes.includes(subtype)) return false;
  if (BOT_USER_ID && event.user === BOT_USER_ID) return true;
  if (BOT_ID && event.bot_id === BOT_ID) return true;
  return false;
}

async function promptChannelListing(client, channelId, inviterId, channelType) {
  if (!channelId) return;
  const existing = await getChannelPref(channelId);
  if (existing?.prompted_at) return;

  await markChannelPrompted(channelId, { channelType, listedBy: inviterId });

  let dmSent = false;
  if (inviterId) {
    const lang = await getUserLang(inviterId);
    const text = t(lang, "find.prompt_public", {
      channel: channelMention(channelId),
    });
    try {
      await sendInteractiveDM(
        client,
        inviterId,
        text,
        buildChannelListingPromptBlocks(lang, channelId, false)
      );
      dmSent = true;
    } catch (err) {
      dmSent = false;
    }
  }

  if (!dmSent) {
    const text = `${t("en", "find.prompt_public", {
      channel: channelMention(channelId),
    })}\n${t("ru", "find.prompt_public", {
      channel: channelMention(channelId),
    })}`;
    await client.chat.postMessage({
      channel: channelId,
      text,
      blocks: buildChannelListingPromptBlocks("en", channelId, true),
    });
  }
}

async function promptTelegramChannelListing(chatId, inviterId, chatType) {
  if (!telegramBot || !chatId) return;
  const channelKey = makeChannelKey(PLATFORM_TELEGRAM, chatId);
  const existing = await getChannelPref(channelKey);
  if (existing?.prompted_at) return;

  await markChannelPrompted(channelKey, {
    channelType: chatType || null,
    listedBy: inviterId || null,
  });

  const channel = channelMention(channelKey);
  const text = `${t("en", "find.prompt_public", {
    channel,
  })}\n${t("ru", "find.prompt_public", {
    channel,
  })}`;

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback(
        t("en", "button.public"),
        buildTelegramCallback(ACTIONS.CHANNEL_LIST_PUBLIC, chatId)
      ),
      Markup.button.callback(
        t("en", "button.private"),
        buildTelegramCallback(ACTIONS.CHANNEL_LIST_PRIVATE, chatId)
      ),
    ],
  ]).reply_markup;

  await telegramBot.telegram.sendMessage(chatId, text, { reply_markup: keyboard });
}

async function handleBotAddedToChannel(client, event) {
  if (!isBotJoinEvent(event)) return;
  const channelId = event.channel;
  if (!channelId) return;

  const channelType =
    event.channel_type === "group"
      ? "group"
      : event.channel_type === "channel"
        ? "channel"
        : null;
  const inviterId =
    event.inviter || (event.user && event.user !== BOT_USER_ID ? event.user : null);

  await promptChannelListing(client, channelId, inviterId, channelType);
}

async function sendInteractiveDM(client, userId, text, blocks) {
  if (isTelegramKey(userId)) {
    if (!telegramBot) return;
    const replyMarkup =
      blocks?.reply_markup || blocks?.tg?.reply_markup || undefined;
    await telegramBot.telegram.sendMessage(stripPlatformPrefix(userId), text, {
      reply_markup: replyMarkup,
    });
    return;
  }
  const convo = await client.conversations.open({
    users: stripPlatformPrefix(userId),
  });
  const payload = {
    channel: convo.channel.id,
    text,
  };
  if (blocks) payload.blocks = blocks;
  await client.chat.postMessage(payload);
}

async function editTelegramMessage(chatId, messageId, text, reply_markup) {
  if (!telegramBot) return;
  if (!chatId || !messageId) return;
  try {
    await telegramBot.telegram.editMessageText(chatId, messageId, undefined, text, {
      reply_markup,
    });
  } catch (err) {
    if (err?.response?.description?.includes("message is not modified")) return;
    console.error("Failed to edit Telegram message:", err);
  }
}

async function sendDevPanel(client, userId) {
  const lang = await getUserLang(userId);
  const state = await getMaintenanceState();
  if (isTelegramKey(userId)) {
    const status = state.enabled
      ? t(lang, "dev.panel.status_on")
      : t(lang, "dev.panel.status_off");
    const buttonText = state.enabled
      ? t(lang, "dev.panel.button_disable")
      : t(lang, "dev.panel.button_enable");
    const reply_markup = Markup.inlineKeyboard([
      [Markup.button.callback(buttonText, buildTelegramCallback(ACTIONS.DEV_MAINT_TOGGLE, ""))],
    ]).reply_markup;
    await sendInteractiveDM(
      null,
      userId,
      `${t(lang, "dev.panel.title")}\n${status}`,
      { reply_markup }
    );
    return;
  }
  const blocks = buildDevPanelBlocks(lang, state.enabled);
  await sendInteractiveDM(client, userId, t(lang, "dev.panel.title"), blocks);
}

async function respondMaintenanceInChannel(client, event) {
  const text = `${t("en", "maintenance.reply")}\n${t("ru", "maintenance.reply")}`;
  const payload = {
    channel: event.channel,
    text,
  };
  if (event.thread_ts) payload.thread_ts = event.thread_ts;
  await client.chat.postMessage(payload);
}

function getActiveGames() {
  return [...gameCache.values()].filter(
    (game) => game && (game.state === "day" || game.state === "night")
  );
}

async function maybeNotifyMaintenanceDone(client) {
  const state = await getMaintenanceState();
  if (!state.enabled || state.notified) return;
  if (!DEV_USER_ID) return;
  if (getActiveGames().length > 0) return;
  if (!client && !isTelegramKey(DEV_USER_ID)) return;

  const lang = await getUserLang(DEV_USER_ID);
  await sendInteractiveDM(client, DEV_USER_ID, t(lang, "maintenance.done"));
  await setMaintenanceState({ ...state, notified: true });
}

async function closeAllLobbiesForMaintenance(client) {
  const lobbies = [...gameCache.values()].filter(
    (game) => game && game.state === "lobby"
  );
  for (const lobby of lobbies) {
    await withChannelLock(lobby.channelId, async () => {
      const game = getGame(lobby.channelId);
      if (!game || game.state !== "lobby") return;
      if (!client && !isTelegramKey(game.channelId)) return;
      await closeLobby(client, game, { key: "maintenance.lobby_closed" });
    });
  }
}

async function updateActionMessage(client, body, text, blocks) {
  if (!body?.message?.ts || !body?.channel?.id) return;
  await client.chat.update({
    channel: body.channel.id,
    ts: body.message.ts,
    text,
    blocks:
      blocks ||
      [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text,
          },
        },
      ],
  });
}

async function initBotIdentity(client) {
  try {
    const res = await client.auth.test();
    BOT_USER_ID = res.user_id || null;
    BOT_ID = res.bot_id || null;
  } catch (err) {
    console.error("Failed to load bot identity:", err);
  }
}

function formatPhaseLabel(lang, game) {
  if (game.state === "day" || game.state === "night") {
    return `${t(lang, `state.${game.state}`)} ${game.round}`;
  }
  return t(lang, `state.${game.state}`);
}

async function buildDashboardText(client, game) {
  const lang = getChannelLangForGame(game);
  const aliveIds = getAlivePlayerIds(game);
  const aliveList = await formatUserListPlain(client, aliveIds);
  const remaining =
    game.phaseDeadline !== null
      ? formatDuration(lang, game.phaseDeadline - now())
      : "-";
  const readyCount = Object.values(game.players || {}).filter(
    (p) => p.ready
  ).length;
  const totalPlayers = Object.keys(game.players || {}).length;

  const lines = [
    `*${t(lang, "dashboard.title")}*`,
    t(lang, "dashboard.phase", { phase: formatPhaseLabel(lang, game) }),
    t(lang, "dashboard.timer", { time: remaining }),
    t(lang, "dashboard.alive", {
      count: aliveIds.length,
      list: aliveList,
    }),
  ];
  if (game.state === "lobby") {
    lines.push(
      t(lang, "dashboard.ready", { ready: readyCount, total: totalPlayers })
    );
  }

  return lines.join("\n");
}

async function postOrUpdateDashboard(client, game) {
  const text = await buildDashboardText(client, game);
  if (isTelegramKey(game.channelId)) {
    if (!telegramBot) return;
    const chatId = stripPlatformPrefix(game.channelId);
    const msgId = getTelegramMessageId(game.dashboardTs);
    if (msgId) {
      try {
        await telegramBot.telegram.editMessageText(chatId, msgId, undefined, text);
        return;
      } catch (err) {
        game.dashboardTs = null;
      }
    }
    const result = await telegramBot.telegram.sendMessage(chatId, text);
    game.dashboardTs = setTelegramMessageId(result?.message_id);
    try {
      await telegramBot.telegram.pinChatMessage(chatId, result.message_id);
    } catch (err) {
      // ignore if no rights
    }
    saveGame(game);
    return;
  }
  if (game.dashboardTs) {
    try {
      await client.chat.update({
        channel: stripPlatformPrefix(game.channelId),
        ts: game.dashboardTs,
        text,
      });
      return;
    } catch (err) {
      const slackErr = err?.data?.error;
      if (
        slackErr !== "message_not_found" &&
        slackErr !== "cant_update_message"
      ) {
        console.error("Failed to update dashboard:", err);
        return;
      }
      game.dashboardTs = null;
    }
  }

  const result = await client.chat.postMessage({
    channel: stripPlatformPrefix(game.channelId),
    text,
  });
  game.dashboardTs = result?.ts || null;
  if (game.dashboardTs) {
    try {
      await client.pins.add({
        channel: stripPlatformPrefix(game.channelId),
        timestamp: game.dashboardTs,
      });
    } catch (err) {
      console.error("Failed to pin dashboard:", err?.data || err);
    }
  }
  saveGame(game);
}

async function finalizeDashboard(client, game) {
  if (!game.dashboardTs) return;
  await postOrUpdateDashboard(client, game);
  if (isTelegramKey(game.channelId)) {
    const chatId = stripPlatformPrefix(game.channelId);
    const msgId = getTelegramMessageId(game.dashboardTs);
    if (telegramBot && msgId) {
      try {
        await telegramBot.telegram.unpinChatMessage(chatId, msgId);
      } catch (err) {
        // ignore
      }
    }
    game.dashboardTs = null;
    saveGame(game);
    return;
  }
  try {
    await client.pins.remove({
      channel: stripPlatformPrefix(game.channelId),
      timestamp: game.dashboardTs,
    });
  } catch (err) {
    console.error("Failed to unpin dashboard:", err?.data || err);
  }
  game.dashboardTs = null;
  saveGame(game);
}

function trackLastWords(game, userId) {
  const entry = {
    channelId: game.channelId,
    expiresAt: now() + LAST_WORDS_TIMEOUT_MS,
  };
  if (!game.lastWords) game.lastWords = { pending: {} };
  game.lastWords.pending[userId] = entry;
  lastWordsPending.set(userId, entry);
  saveGame(game);
  return entry;
}

function clearLastWords(userId) {
  lastWordsPending.delete(userId);
  for (const game of gameCache.values()) {
    if (game?.lastWords?.pending?.[userId]) {
      delete game.lastWords.pending[userId];
      saveGame(game);
    }
  }
}

function getLastWordsEntry(userId) {
  return lastWordsPending.get(userId) || null;
}

async function requestLastWords(client, game, userId) {
  if (isTestUserId(userId)) return;
  const lang = await getUserLang(userId);
  trackLastWords(game, userId);
  await sendInteractiveDM(
    client,
    userId,
    t(lang, "last_words.prompt", {
      channel: channelMention(game.channelId),
    })
  );
}

async function ensureGraveyardChannel(client, game) {
  if (isTelegramKey(game.channelId)) return null;
  if (game.graveyard?.id) return game.graveyard.id;

  const suffix = game.channelId.slice(-4).toLowerCase();
  const baseName = `mafia-graveyard-${suffix}`;
  let name = baseName;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await client.conversations.create({
        name,
        is_private: true,
      });
      game.graveyard = { id: res.channel.id, name };
      saveGame(game);
      return game.graveyard.id;
    } catch (err) {
      if (err?.data?.error === "name_taken") {
        name = `${baseName}-${Math.floor(Math.random() * 1000)}`;
        continue;
      }
      break;
    }
  }
  return null;
}

async function inviteToGraveyard(client, game, userId) {
  if (isTestUserId(userId)) return true;
  if (isTelegramKey(game.channelId)) return true;
  const channelId = await ensureGraveyardChannel(client, game);
  if (!channelId) return false;
  try {
    await client.conversations.invite({
      channel: channelId,
      users: userId,
    });
    return true;
  } catch (err) {
    if (err?.data?.error === "already_in_channel") return true;
    return false;
  }
}

async function ensureMafiaRoom(client, game) {
  if (isTelegramKey(game.channelId)) return null;
  if (game.mafiaRoomId) return game.mafiaRoomId;
  const realMafiaIds = game.roles.mafiaIds.filter((id) => !isTestUserId(id));
  if (realMafiaIds.length < 2) return null;
  try {
    const res = await client.conversations.open({
      users: realMafiaIds.join(","),
    });
    game.mafiaRoomId = res.channel.id;
    saveGame(game);
    await client.chat.postMessage({
      channel: game.mafiaRoomId,
      text: t("en", "mafia_room.intro"),
    });
    await client.chat.postMessage({
      channel: game.mafiaRoomId,
      text: t("ru", "mafia_room.intro"),
    });
    return game.mafiaRoomId;
  } catch (err) {
    console.error("Failed to create mafia room:", err?.data || err);
    return null;
  }
}

async function announceToChannel(client, channelId, text) {
  if (isTelegramKey(channelId)) {
    if (!telegramBot) return;
    await telegramBot.telegram.sendMessage(stripPlatformPrefix(channelId), text);
    return;
  }
  await client.chat.postMessage({ channel: stripPlatformPrefix(channelId), text });
}

function buildPhaseCardText(game, phase, narrativeText, lang) {
  const title =
    phase === "day"
      ? t(lang, "phase.card_title_day", { round: game.round })
      : t(lang, "phase.card_title_night", { round: game.round });
  const alive = getAlivePlayerIds(game).length;
  const remaining =
    game.phaseDeadline !== null
      ? formatDuration(lang, game.phaseDeadline - now())
      : "-";
  const stats = t(lang, "phase.card_stats", {
    alive,
    time: remaining,
  });
  return `${title}\n${narrativeText}\n${stats}`;
}

function buildPhaseCardBlocks(game, phase, narrativeText, lang) {
  const title =
    phase === "day"
      ? t(lang, "phase.card_title_day", { round: game.round })
      : t(lang, "phase.card_title_night", { round: game.round });
  const alive = getAlivePlayerIds(game).length;
  const remaining =
    game.phaseDeadline !== null
      ? formatDuration(lang, game.phaseDeadline - now())
      : "-";
  const stats = t(lang, "phase.card_stats", {
    alive,
    time: remaining,
  });
  return [
    {
      type: "header",
      text: { type: "plain_text", text: title },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: narrativeText },
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: stats }],
    },
  ];
}

async function postPhaseCard(client, game, phase, narrativeText) {
  const lang = getChannelLangForGame(game);
  const blocks = buildPhaseCardBlocks(game, phase, narrativeText, lang);
  const text = buildPhaseCardText(game, phase, narrativeText, lang);
  const res = await client.chat.postMessage({
    channel: stripPlatformPrefix(game.channelId),
    text,
    blocks,
  });
  return res?.ts || null;
}

async function postPhaseMedia(client, game, phase, narrativeText, threadTs) {
  const fileName = phase === "day" ? ASSET_FILES.day : ASSET_FILES.night;
  const filePath = path.join(ASSETS_DIR, fileName);
  if (!fs.existsSync(filePath)) return false;
  try {
    const initialComment = threadTs ? undefined : narrativeText;
    await client.files.uploadV2({
      channel_id: stripPlatformPrefix(game.channelId),
      file: fs.createReadStream(filePath),
      filename: fileName,
      title: phase === "day" ? "Day" : "Night",
      initial_comment: initialComment,
      thread_ts: threadTs || undefined,
    });
    return true;
  } catch (err) {
    console.error("Failed to upload phase media:", err?.data || err);
    return false;
  }
}

async function announceToChannelLocalized(
  client,
  game,
  key,
  paramsBuilder,
  options = {}
) {
  const channelLang = getChannelLangForGame(game);
  const langs = options.forceBilingual ? ["en", "ru"] : [channelLang];
  for (const lang of langs) {
    const params = paramsBuilder ? await paramsBuilder(lang) : undefined;
    await announceToChannel(client, game.channelId, t(lang, key, params));
  }
}

async function notifyEphemeral(client, channelId, userId, text) {
  try {
    if (isTelegramKey(channelId) || isTelegramKey(userId)) {
      if (!telegramBot) return;
      const target = isTelegramKey(userId)
        ? stripPlatformPrefix(userId)
        : stripPlatformPrefix(channelId);
      await telegramBot.telegram.sendMessage(target, text);
      return;
    }
    await client.chat.postEphemeral({
      channel: stripPlatformPrefix(channelId),
      user: stripPlatformPrefix(userId),
      text,
    });
  } catch (err) {
    console.error("Failed to send ephemeral message:", err);
  }
}

async function notifyEphemeralLocalized(client, channelId, userId, key, params) {
  const lang = await getUserLang(userId);
  await notifyEphemeral(client, channelId, userId, t(lang, key, params));
}

async function postOrUpdateLobbyPanel(client, game) {
  if (game.state !== "lobby") return;
  if (isTelegramKey(game.channelId)) {
    if (!telegramBot) return;
    const lang = getChannelLangForGame(game);
    const { text, reply_markup } = await buildTelegramLobbyPanel(game, lang);
    const chatId = stripPlatformPrefix(game.channelId);
    const msgId = getTelegramMessageId(game.lobbyMessageTs);
    if (msgId) {
      try {
        await telegramBot.telegram.editMessageText(chatId, msgId, undefined, text, {
          reply_markup,
        });
        return;
      } catch (err) {
        game.lobbyMessageTs = null;
      }
    }
    const res = await telegramBot.telegram.sendMessage(chatId, text, {
      reply_markup,
    });
    game.lobbyMessageTs = setTelegramMessageId(res?.message_id);
    saveGame(game);
    return;
  }
  const playerCount = Object.keys(game.players).length;
  const minPlayers = game.config.minPlayers;
  const lang = getChannelLangForGame(game);
  const text = t(lang, "lobby.panel_summary", {
    count: playerCount,
    min: minPlayers,
  });
  const blocks = await buildLobbyBlocks(client, game, lang);
  const ts = typeof game.lobbyMessageTs === "string" ? game.lobbyMessageTs : null;

  if (ts) {
    try {
      await client.chat.update({
        channel: stripPlatformPrefix(game.channelId),
        ts,
        text,
        blocks,
      });
      return;
    } catch (err) {
      if (
        err?.data?.error === "message_not_found" ||
        err?.data?.error === "cant_update_message"
      ) {
        game.lobbyMessageTs = null;
      } else {
        console.error("Failed to update lobby panel:", err);
      }
    }
  }

  const res = await client.chat.postMessage({
    channel: stripPlatformPrefix(game.channelId),
    text,
    blocks,
  });
  game.lobbyMessageTs = res?.ts || null;
}

async function finalizeLobbyPanel(client, game, text) {
  const ts = typeof game.lobbyMessageTs === "string" ? game.lobbyMessageTs : null;
  if (!ts) return;
  const lang = getChannelLangForGame(game);
  const localizedText =
    typeof text === "string"
      ? text
      : text?.[lang] || text?.en || text?.ru || "-";
  if (isTelegramKey(game.channelId)) {
    if (telegramBot) {
      const chatId = stripPlatformPrefix(game.channelId);
      const msgId = getTelegramMessageId(ts);
      if (msgId) {
        try {
          await telegramBot.telegram.editMessageText(
            chatId,
            msgId,
            undefined,
            localizedText
          );
        } catch (err) {
          console.error("Failed to finalize lobby panel:", err);
        }
      }
    }
    game.lobbyMessageTs = null;
    return;
  }
  try {
    await client.chat.update({
      channel: stripPlatformPrefix(game.channelId),
      ts,
      text: localizedText,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: localizedText,
          },
        },
      ],
    });
  } catch (err) {
    console.error("Failed to finalize lobby panel:", err);
  }
  game.lobbyMessageTs = null;
}

function clearPhaseTimers(channelId) {
  const timers = channelTimers.get(channelId);
  if (!timers) return;
  timers.forEach((timerId) => clearTimeout(timerId));
  channelTimers.delete(channelId);
}

function schedulePhaseTimers(game) {
  clearPhaseTimers(game.channelId);
  if (!game.phaseDeadline) return;

  const nowMs = now();
  const timers = [];
  const warnMsList = [30000];

  warnMsList.forEach((warnMs) => {
    const fireAt = game.phaseDeadline - warnMs;
    if (fireAt <= nowMs) return;
    const timeoutId = setTimeout(() => {
      withChannelLock(game.channelId, async () => {
        const current = getGame(game.channelId);
        if (!current || current.phaseDeadline !== game.phaseDeadline) return;
        await sendPhaseWarning(app.client, current, warnMs);
      });
    }, fireAt - nowMs);
    timers.push(timeoutId);
  });

  const deadlineId = setTimeout(() => {
    withChannelLock(game.channelId, async () => {
      const current = getGame(game.channelId);
      if (!current || current.phaseDeadline !== game.phaseDeadline) return;
      await autoResolvePhase(app.client, current);
    });
  }, Math.max(0, game.phaseDeadline - nowMs));

  timers.push(deadlineId);
  channelTimers.set(game.channelId, timers);
}

async function sendPhaseWarning(client, game, warnMs) {
  const seconds = Math.floor(warnMs / 1000);
  let key = "warn.day";
  if (game.state === "night") key = "warn.night";
  if (game.state === "lobby") key = "warn.lobby";

  if (game.state === "night") {
    const pending = getPendingNightActors(game);
    if (pending.length === 0) return;
  }
  if (game.state === "day") {
    const pending = getPendingDayVoters(game);
    if (pending.length === 0) return;
  }

  await announceToChannelLocalized(client, game, key, () => ({
    seconds,
  }));

  if (game.state === "lobby") {
    await postOrUpdateLobbyPanel(client, game);
    saveGame(game);
  }

  if (game.state === "night") {
    const pending = getPendingNightActors(game);
    for (const userId of pending) {
      await sendReminder(client, userId, game.channelId, "night_action");
    }
  }

  if (game.state === "day") {
    const pending = getPendingDayVoters(game);
    for (const userId of pending) {
      await sendReminder(client, userId, game.channelId, "vote");
    }
  }

  await postOrUpdateDashboard(client, game);
}

async function sendReminder(client, userId, channelId, actionKey) {
  if (isTestUserId(userId)) return;
  const lang = await getUserLang(userId);
  const text = t(lang, "reminder.text", {
    action: t(lang, `reminder.${actionKey}`),
    channel: channelMention(channelId),
  });
  if (isTelegramKey(userId)) {
    await sendInteractiveDM(client, userId, text);
    return;
  }
  const convo = await client.conversations.open({
    users: stripPlatformPrefix(userId),
  });
  await client.chat.postMessage({
    channel: convo.channel.id,
    text,
  });
}

function getPendingNightActors(game) {
  const pending = [];
  const alive = new Set(getAlivePlayerIds(game));

  const mafiaAlive = game.roles.mafiaIds.filter((id) => alive.has(id));
  for (const mafiaId of mafiaAlive) {
    if (!game.night.mafiaVotes[mafiaId]) {
      pending.push(mafiaId);
    }
  }

  if (game.roles.doctorId && alive.has(game.roles.doctorId)) {
    if (!game.night.doctorSave) pending.push(game.roles.doctorId);
  }

  if (game.roles.detectiveId && alive.has(game.roles.detectiveId)) {
    if (!game.night.detectiveCheck && !game.night.detectiveKill)
      pending.push(game.roles.detectiveId);
  }

  if (game.roles.bodyguardId && alive.has(game.roles.bodyguardId)) {
    if (!game.night.bodyguardProtect) pending.push(game.roles.bodyguardId);
  }
  if (game.roles.bumId && alive.has(game.roles.bumId)) {
    if (!game.night.bumVisit) pending.push(game.roles.bumId);
  }
  if (game.roles.lawyerId && alive.has(game.roles.lawyerId)) {
    if (!game.night.lawyerProtect) pending.push(game.roles.lawyerId);
  }
  if (game.roles.stalkerId && alive.has(game.roles.stalkerId)) {
    const stalkerChoices = getAlivePlayerIds(game).filter(
      (id) => id !== game.roles.stalkerId
    );
    if (stalkerChoices.length > 0 && !game.night.stalkerKill) {
      pending.push(game.roles.stalkerId);
    }
  }

  return pending;
}

function getPendingDayVoters(game) {
  const alive = getAlivePlayerIds(game);
  return alive.filter((id) => !game.day.votes[id]);
}

function resolveMafiaTarget(game) {
  const tally = {};
  for (const targetId of Object.values(game.night.mafiaVotes)) {
    if (!targetId) continue;
    if (!game.config.allowNoKill && targetId === SPECIAL_TARGETS.NO_KILL) {
      continue;
    }
    tally[targetId] = (tally[targetId] || 0) + 1;
  }

  let maxVotes = 0;
  let leaders = [];
  Object.entries(tally).forEach(([targetId, votes]) => {
    if (votes > maxVotes) {
      maxVotes = votes;
      leaders = [targetId];
    } else if (votes === maxVotes) {
      leaders.push(targetId);
    }
  });

  if (leaders.length === 0) {
    return randomChoice(listAliveNonMafiaIds(game));
  }

  const choice = randomChoice(leaders);
  if (choice === SPECIAL_TARGETS.NO_KILL) return null;
  return choice;
}

function applyAutoNightActions(game) {
  const aliveIds = getAlivePlayerIds(game);

  const mafiaTargets = listAliveNonMafiaIds(game);
  const mafiaAlive = game.roles.mafiaIds.filter((id) => aliveIds.includes(id));
  mafiaAlive.forEach((mafiaId) => {
    if (!game.night.mafiaVotes[mafiaId]) {
      game.night.mafiaVotes[mafiaId] = randomChoice(mafiaTargets);
    }
  });

  if (game.roles.doctorId && isPlayerAlive(game, game.roles.doctorId)) {
    if (!game.night.doctorSave) {
      const doctorId = game.roles.doctorId;
      const limit = Number.isFinite(game.config.doctorSelfSaveLimit)
        ? game.config.doctorSelfSaveLimit
        : 1;
      const canSelfSave = game.doctorSelfSavesUsed < limit;
      let choices = aliveIds;
      if (!canSelfSave) {
        choices = aliveIds.filter((id) => id !== doctorId);
      }
      const selected = randomChoice(choices) || doctorId;
      game.night.doctorSave = selected;
      if (selected === doctorId && canSelfSave) {
        game.doctorSelfSavesUsed += 1;
      }
    }
  }

  if (game.roles.detectiveId && isPlayerAlive(game, game.roles.detectiveId)) {
    if (!game.night.detectiveCheck && !game.night.detectiveKill) {
      game.night.detectiveCheck = randomChoice(aliveIds);
    }
  }

  if (game.roles.bodyguardId && isPlayerAlive(game, game.roles.bodyguardId)) {
    if (!game.night.bodyguardProtect) {
      game.night.bodyguardProtect = randomChoice(aliveIds);
    }
  }
  if (game.roles.bumId && isPlayerAlive(game, game.roles.bumId)) {
    if (!game.night.bumVisit) {
      game.night.bumVisit = randomChoice(aliveIds);
    }
  }
  if (game.roles.lawyerId && isPlayerAlive(game, game.roles.lawyerId)) {
    if (!game.night.lawyerProtect) {
      game.night.lawyerProtect = randomChoice(aliveIds);
    }
  }
  if (game.roles.stalkerId && isPlayerAlive(game, game.roles.stalkerId)) {
    if (!game.night.stalkerKill) {
      const choices = aliveIds.filter((id) => id !== game.roles.stalkerId);
      game.night.stalkerKill = randomChoice(choices) || null;
    }
  }
}

function applyAutoDayVotes(game) {
  const aliveIds = getAlivePlayerIds(game);
  aliveIds.forEach((voterId) => {
    if (!game.day.votes[voterId]) {
      const target =
        randomChoice(aliveIds.filter((id) => id !== voterId)) || voterId;
      game.day.votes[voterId] = target;
    }
  });
}

function checkWin(game) {
  const alive = getAlivePlayers(game);
  const mafiaAlive = alive.filter((p) => isMafiaTeam(game, p.id)).length;
  const jesterAlive = alive.filter((p) => p.role === "jester").length;
  const stalkerAlive = alive.filter((p) => p.role === "stalker").length;
  const townAlive = alive.length - mafiaAlive - jesterAlive - stalkerAlive;

  if (mafiaAlive === 0) return "town";
  if (mafiaAlive >= townAlive) return "mafia";
  return null;
}

async function closeLobby(client, game, reasonText) {
  const lang = getChannelLangForGame(game);
  if (reasonText) {
    await announceToChannelLocalized(client, game, reasonText.key, reasonText.paramsBuilder);
  }
  const finalText = reasonText
    ? t(
        lang,
        reasonText.key,
        reasonText.paramsBuilder ? await reasonText.paramsBuilder(lang) : undefined
      )
    : t(lang, "lobby.closed");
  await finalizeLobbyPanel(
    client,
    game,
    finalText
  );
  await finalizeDashboard(client, game);
  clearPhaseTimers(game.channelId);
  const userIds = Object.keys(game.players || {});
  gameCache.delete(game.channelId);
  deleteGame(game.channelId);
  await updateHomeForUsers(client, userIds);
  await maybeNotifyMaintenanceDone(client);
}

async function startGameFromLobby(client, game, announceText) {
  if (announceText) {
    await announceToChannelLocalized(client, game, announceText.key, announceText.paramsBuilder);
  }
  const lang = getChannelLangForGame(game);
  await finalizeLobbyPanel(client, game, t(lang, "lobby.starting"));
  assignRoles(game);
  saveGame(game);

  for (const player of Object.values(game.players)) {
    await sendRoleDM(client, game, player.id, player.role);
  }
  await sendTestRoleSummary(client, game);

  if (game.roles.stalkerId) {
    await assignNewStalkerTarget(client, game);
  }

  await ensureMafiaRoom(client, game);
  await postOrUpdateDashboard(client, game);
  await startNight(client, game);
}

async function resolveLobbyTimeout(client, game) {
  if (game.state !== "lobby") return;
  if (await isMaintenanceEnabled()) {
    await closeLobby(client, game, { key: "maintenance.lobby_closed" });
    return;
  }
  const playerCount = Object.keys(game.players).length;
  if (playerCount < game.config.minPlayers) {
    await closeLobby(client, game, {
      key: "lobby.closed_not_enough",
      paramsBuilder: () => ({
        min: game.config.minPlayers,
        count: playerCount,
      }),
    });
    return;
  }

  await startGameFromLobby(client, game, {
    key: "lobby.timeout_start",
  });
}

async function endGameWithWinner(client, game, winner) {
  await announceToChannelLocalized(
    client,
    game,
    winner === "jester" ? "winner.summary_jester" : "winner.summary",
    async (lang) => {
      const mafia = await formatPlayersByFilter(
        client,
        game,
        (p) => isMafiaTeam(game, p.id),
        lang
      );
      const town = await formatPlayersByFilter(
        client,
        game,
        (p) =>
          !isMafiaTeam(game, p.id) &&
          p.role !== "jester" &&
          p.role !== "stalker",
        lang
      );
      const jester = await formatPlayersByFilter(
        client,
        game,
        (p) => p.role === "jester",
        lang
      );
      const winnerText =
        winner === "mafia"
          ? t(lang, "winner.mafia")
          : winner === "jester"
          ? t(lang, "winner.jester")
          : t(lang, "winner.town");
      if (winner === "jester") {
        return {
          winner: winnerText,
          jester: jester || "-",
          mafia: mafia || "-",
          town: town || "-",
        };
      }
      return {
        winner: winnerText,
        mafia: mafia || "-",
        town: town || "-",
      };
    },
    { forceBilingual: true }
  );

  const players = Object.values(game.players || {});
  for (const player of players) {
    if (player.isTest) continue;
    const role = player.role || "town";
    let isWin = false;
    if (winner === "mafia") {
      isWin = isMafiaTeam(game, player.id);
    } else if (winner === "town") {
      isWin =
        !isMafiaTeam(game, player.id) &&
        role !== "jester" &&
        role !== "stalker";
    } else if (winner === "jester") {
      isWin = role === "jester";
    }
    await updateUserStats(player.id, isWin);
    await updateUserChannelStats(player.id, game.channelId, isWin);
    if (role !== "stalker") {
      await updateUserRoleStats(player.id, role, isWin);
    }
  }

  await finalizeDashboard(client, game);
  clearPhaseTimers(game.channelId);
  gameCache.delete(game.channelId);
  await deleteGame(game.channelId);
  await updateHomeForUsers(
    client,
    players.map((player) => player.id)
  );
  await maybeNotifyMaintenanceDone(client);
}

async function startNight(client, game, narrative) {
  game.state = "night";
  game.round += 1;
  resetNight(game);
  if (game.phaseShortened) game.phaseShortened.night = false;
  game.phaseDeadline = now() + game.config.nightMs;

  saveGame(game);
  schedulePhaseTimers(game);

  const channelLang = getChannelLangForGame(game);
  const baseLine = t(channelLang, "phase.night_start", { round: game.round });
  let narrativeText = baseLine;
  if (narrative?.text) {
    narrativeText = `${baseLine}\n${narrative.text}`;
  } else if (narrative?.key) {
    const params = narrative.paramsBuilder
      ? await narrative.paramsBuilder(channelLang)
      : undefined;
    narrativeText = `${baseLine}\n${t(channelLang, narrative.key, params)}`;
  }

  if (isTelegramKey(game.channelId)) {
    await announceToChannel(client, game.channelId, narrativeText);
  } else {
    let cardTs = null;
    try {
      cardTs = await postPhaseCard(client, game, "night", narrativeText);
    } catch (err) {
      console.error("Failed to post night card:", err?.data || err);
      await announceToChannel(client, game.channelId, narrativeText);
    }
    await postPhaseMedia(client, game, "night", narrativeText, cardTs);
  }

  if (game.roles.stalkerId && !game.stalker?.targetRole) {
    await assignNewStalkerTarget(client, game);
  }

  if (game.mafiaRoomId) {
    await client.chat.postMessage({
      channel: game.mafiaRoomId,
      text: t("en", "phase.night_start", { round: game.round }),
    });
    await client.chat.postMessage({
      channel: game.mafiaRoomId,
      text: t("ru", "phase.night_start", { round: game.round }),
    });
  }

  await postOrUpdateDashboard(client, game);
  await sendNightPrompts(client, game);
  await sendTestActionReminder(client, game, "night");
  await updateHomeForGame(client, game);
}

async function startDay(client, game, narrative) {
  game.state = "day";
  resetDay(game);
  if (game.phaseShortened) game.phaseShortened.day = false;
  game.phaseDeadline = now() + game.config.dayMs;

  saveGame(game);
  schedulePhaseTimers(game);

  const channelLang = getChannelLangForGame(game);
  const baseLine = t(channelLang, "phase.day_start", { round: game.round });
  let narrativeText = baseLine;
  if (narrative?.text) {
    narrativeText = `${baseLine}\n${narrative.text}`;
  } else if (narrative?.key) {
    const params = narrative.paramsBuilder
      ? await narrative.paramsBuilder(channelLang)
      : undefined;
    narrativeText = `${baseLine}\n${t(channelLang, narrative.key, params)}`;
  }

  if (isTelegramKey(game.channelId)) {
    await announceToChannel(client, game.channelId, narrativeText);
  } else {
    let cardTs = null;
    try {
      cardTs = await postPhaseCard(client, game, "day", narrativeText);
    } catch (err) {
      console.error("Failed to post day card:", err?.data || err);
      await announceToChannel(client, game.channelId, narrativeText);
    }
    await postPhaseMedia(client, game, "day", narrativeText, cardTs);
  }

  await postOrUpdateDashboard(client, game);
  await sendDayPrompts(client, game);
  await sendTestActionReminder(client, game, "day");
  await updateHomeForGame(client, game);
}

async function resolveNight(client, game, autoApplied) {
  const mafiaTarget = resolveMafiaTarget(game);
  const stalkerTarget = game.night.stalkerKill;
  const detectiveTarget = game.night.detectiveKill;
  const bodyguardId = game.roles.bodyguardId;
  const doctorSave = game.night.doctorSave;
  const luckyId = game.roles.luckyId;

  let bodyguardDied = false;
  const killAttempts = new Map();

  const addKillAttempt = (targetId, cause) => {
    if (!targetId) return;
    const key = String(targetId);
    const existing = killAttempts.get(key) || new Set();
    existing.add(cause);
    killAttempts.set(key, existing);
  };

  const applyKill = (targetId, cause) => {
    if (!targetId || !isPlayerAlive(game, targetId)) return;
    if (bodyguardId && isPlayerAlive(game, bodyguardId)) {
      if (game.night.bodyguardProtect === targetId) {
        addKillAttempt(bodyguardId, cause);
        bodyguardDied = true;
        return;
      }
    }
    addKillAttempt(targetId, cause);
  };

  applyKill(mafiaTarget, "mafia");
  applyKill(stalkerTarget, "stalker");
  applyKill(detectiveTarget, "detective");

  const killedIds = [];
  const stalkerKillIds = new Set();
  const detectiveKillIds = new Set();

  for (const [targetId, causes] of killAttempts.entries()) {
    if (doctorSave === targetId) continue;
    if (luckyId && targetId === luckyId && Math.random() < 0.5) continue;
    killedIds.push(targetId);
    if (causes.has("stalker")) {
      stalkerKillIds.add(targetId);
    }
    if (causes.has("detective")) {
      detectiveKillIds.add(targetId);
    }
  }

  for (const killedId of killedIds) {
    if (!game.players[killedId]) continue;
    game.players[killedId].alive = false;
    if (killedId === game.roles.stalkerId) {
      await recordStalkerLoss(game);
    }
    await requestLastWords(client, game, killedId);
    const invited = await inviteToGraveyard(client, game, killedId);
    if (!invited) {
      await notifyEphemeralLocalized(
        client,
        game.channelId,
        game.hostId,
        "graveyard.unavailable"
      );
    }
  }

  await maybePromoteSergeant(client, game);

  if (game.roles.bumId && isPlayerAlive(game, game.roles.bumId)) {
    const bumTarget = game.night.bumVisit;
    if (bumTarget && killedIds.includes(bumTarget)) {
      let killerId = null;
      if (stalkerKillIds.has(bumTarget)) {
        killerId = game.roles.stalkerId;
      } else if (detectiveKillIds.has(bumTarget)) {
        killerId = game.roles.detectiveId;
      } else {
        const mafiaVoters = Object.entries(game.night.mafiaVotes)
          .filter(([, target]) => target === bumTarget)
          .map(([id]) => id)
          .filter((id) => isPlayerAlive(game, id));
        const mafiaAlive = game.roles.mafiaIds.filter((id) =>
          isPlayerAlive(game, id)
        );
        killerId = randomChoice(mafiaVoters) || randomChoice(mafiaAlive);
      }
      if (killerId && !isTestUserId(game.roles.bumId)) {
        const bumLang = await getUserLang(game.roles.bumId);
        await sendInteractiveDM(client, game.roles.bumId, t(bumLang, "bum.witness", {
          killer: mention(killerId),
          victim: mention(bumTarget),
        }));
      }
    } else if (bumTarget && !isTestUserId(game.roles.bumId)) {
      const bumLang = await getUserLang(game.roles.bumId);
      await sendInteractiveDM(client, game.roles.bumId, t(bumLang, "bum.nothing"));
    }
  }

  if (game.roles.stalkerId && isPlayerAlive(game, game.roles.stalkerId)) {
    const targetRole = game.stalker?.targetRole;
    if (targetRole) {
      const stalkerSuccess = killedIds.some(
        (id) => stalkerKillIds.has(id) && game.players[id]?.role === targetRole
      );
      if (stalkerSuccess) {
        await recordStalkerWin(game);
        await assignNewStalkerTarget(client, game, "stalker.success");
      } else {
        const aliveHasRole = getAlivePlayers(game).some(
          (p) => p.role === targetRole
        );
        if (!aliveHasRole) {
          await assignNewStalkerTarget(client, game, "stalker.failed");
        }
      }
    } else {
      await assignNewStalkerTarget(client, game, "stalker.target_assigned");
    }
  }

  const buildSummary = async (lang) => {
    const summaryParts = [];
    if (autoApplied) summaryParts.push(t(lang, "auto.applied"));

    if (killedIds.length > 0) {
      const targetParts = [];
      for (const id of killedIds) {
        const target = await getNameOrMention(client, game, id, lang);
        const role = roleLabel(game.players[id].role, lang);
        targetParts.push(`${target} (${role})`);
      }
      summaryParts.push(
        t(lang, "night.ended_killed", {
          targets: targetParts.join(", "),
        })
      );
    } else {
      summaryParts.push(t(lang, "night.ended_none"));
    }

    if (bodyguardDied && killedIds.length > 0) {
      summaryParts.push(t(lang, "night.bodyguard"));
    }

    return summaryParts.join(" ");
  };

  const summaryEn = await buildSummary("en");
  const summaryRu = await buildSummary("ru");
  addNightHistory(game, {
    round: game.round,
    en: summaryEn,
    ru: summaryRu,
    ts: now(),
  });
  saveGame(game);
  const channelLang = getChannelLangForGame(game);
  const summaryText = channelLang === "ru" ? summaryRu : summaryEn;

  const winner = checkWin(game);
  if (winner) {
    await announceToChannel(client, game.channelId, summaryText);
    await endGameWithWinner(client, game, winner);
    return;
  }

  await startDay(client, game, { text: summaryText });
}

async function resolveDay(client, game, autoApplied) {
  const tally = new Map();
  Object.entries(game.day.votes).forEach(([voterId, targetId]) => {
    if (!isPlayerAlive(game, voterId)) return;
    if (targetId === SPECIAL_TARGETS.ABSTAIN) return;
    if (!isPlayerAlive(game, targetId)) return;
    const weight =
      voterId === game.roles.mayorId && isPlayerAlive(game, voterId) ? 2 : 1;
    tally.set(targetId, (tally.get(targetId) || 0) + weight);
  });

  let maxVotes = 0;
  let topTargets = [];
  for (const [targetId, votes] of tally.entries()) {
    if (votes > maxVotes) {
      maxVotes = votes;
      topTargets = [targetId];
    } else if (votes === maxVotes) {
      topTargets.push(targetId);
    }
  }

  let executedId = null;
  if (topTargets.length === 1) {
    executedId = topTargets[0];
    game.players[executedId].alive = false;
  }

  if (executedId) {
    await requestLastWords(client, game, executedId);
    const invited = await inviteToGraveyard(client, game, executedId);
    if (!invited) {
      await notifyEphemeralLocalized(
        client,
        game.channelId,
        game.hostId,
        "graveyard.unavailable"
      );
    }
    if (executedId === game.roles.stalkerId) {
      await recordStalkerLoss(game);
    }
    await maybePromoteSergeant(client, game);
    if (game.roles.stalkerId && isPlayerAlive(game, game.roles.stalkerId)) {
      const targetRole = game.stalker?.targetRole;
      if (targetRole) {
        const aliveHasRole = getAlivePlayers(game).some(
          (p) => p.role === targetRole
        );
        if (!aliveHasRole) {
          await assignNewStalkerTarget(client, game, "stalker.failed");
        }
      } else {
        await assignNewStalkerTarget(client, game, "stalker.target_assigned");
      }
    }
  }

  const buildSummary = async (lang) => {
    const summaryParts = [];
    if (autoApplied) summaryParts.push(t(lang, "auto.applied"));

    if (executedId) {
      const target = await getNameOrMention(client, game, executedId, lang);
      summaryParts.push(
        t(lang, "day.ended_executed", {
          target,
          role: roleLabel(game.players[executedId].role, lang),
        })
      );
    } else {
      summaryParts.push(t(lang, "day.ended_tie"));
    }

    return summaryParts.join(" ");
  };

  const summaryEn = await buildSummary("en");
  const summaryRu = await buildSummary("ru");
  const channelLang = getChannelLangForGame(game);
  const summaryText = channelLang === "ru" ? summaryRu : summaryEn;

  if (executedId && game.players[executedId].role === "jester") {
    await announceToChannel(client, game.channelId, summaryText);
    await endGameWithWinner(client, game, "jester");
    return;
  }

  const winner = checkWin(game);
  if (winner) {
    await announceToChannel(client, game.channelId, summaryText);
    await endGameWithWinner(client, game, winner);
    return;
  }

  await startNight(client, game, { text: summaryText });
}

async function autoResolvePhase(client, game) {
  if (game.state === "lobby") {
    await resolveLobbyTimeout(client, game);
    return;
  }

  if (game.state === "night") {
    applyAutoNightActions(game);
    saveGame(game);
    await resolveNight(client, game, true);
  }

  if (game.state === "day") {
    applyAutoDayVotes(game);
    saveGame(game);
    await resolveDay(client, game, true);
  }
}

async function sendNightPrompts(client, game) {
  if (isTelegramKey(game.channelId)) {
    await sendNightPromptsTelegram(game);
    return;
  }
  const mafiaTargets = listAliveNonMafiaIds(game);
  const aliveIds = getAlivePlayerIds(game);

  const mafiaChoices = await buildUserChoices(client, mafiaTargets);
  const aliveChoices = await buildUserChoices(client, aliveIds);
  for (const mafiaId of game.roles.mafiaIds) {
    if (!isPlayerAlive(game, mafiaId)) continue;
    if (isTestUserId(mafiaId)) continue;
    if (mafiaChoices.length === 0) continue;
    const lang = await getUserLang(mafiaId);

    const promptText = t(lang, "prompt.mafia", {
      channel: channelMention(game.channelId),
    });
    const extraButtons = [];
    if (game.config.allowNoKill) {
      extraButtons.push({
        text: t(lang, "button.no_kill"),
        value: SPECIAL_TARGETS.NO_KILL,
        actionId: ACTIONS.MAFIA_VOTE,
      });
    }
    const blocks = buildPlayerButtonBlocks({
      channelId: game.channelId,
      actionId: ACTIONS.MAFIA_VOTE,
      text: promptText,
      players: mafiaChoices,
      page: 0,
      pageSize: BUTTON_PAGE_SIZE,
      lang,
      extraButtons,
    });

    await sendInteractiveDM(client, mafiaId, promptText, blocks);
  }

  if (game.roles.doctorId && isPlayerAlive(game, game.roles.doctorId)) {
    if (!isTestUserId(game.roles.doctorId)) {
      const lang = await getUserLang(game.roles.doctorId);
      const promptText = t(lang, "prompt.doctor", {
        channel: channelMention(game.channelId),
      });
      const blocks = buildPlayerButtonBlocks({
        channelId: game.channelId,
        actionId: ACTIONS.DOCTOR_SAVE,
        text: promptText,
        players: aliveChoices,
        page: 0,
        pageSize: BUTTON_PAGE_SIZE,
        lang,
      });

      await sendInteractiveDM(client, game.roles.doctorId, promptText, blocks);
    }
  }

  if (game.roles.detectiveId && isPlayerAlive(game, game.roles.detectiveId)) {
    if (!isTestUserId(game.roles.detectiveId)) {
      const lang = await getUserLang(game.roles.detectiveId);
      const promptText = t(lang, "prompt.detective_mode", {
        channel: channelMention(game.channelId),
      });
      const blocks = buildDetectiveModeBlocks(lang, game.channelId, promptText);
      await sendInteractiveDM(
        client,
        game.roles.detectiveId,
        promptText,
        blocks
      );
    }
  }

  if (game.roles.bodyguardId && isPlayerAlive(game, game.roles.bodyguardId)) {
    if (!isTestUserId(game.roles.bodyguardId)) {
      const lang = await getUserLang(game.roles.bodyguardId);
      const promptText = t(lang, "prompt.bodyguard", {
        channel: channelMention(game.channelId),
      });
      const blocks = buildPlayerButtonBlocks({
        channelId: game.channelId,
        actionId: ACTIONS.BODYGUARD_PROTECT,
        text: promptText,
        players: aliveChoices,
        page: 0,
        pageSize: BUTTON_PAGE_SIZE,
        lang,
      });

      await sendInteractiveDM(
        client,
        game.roles.bodyguardId,
        promptText,
        blocks
      );
    }
  }

  if (game.roles.bumId && isPlayerAlive(game, game.roles.bumId)) {
    if (!isTestUserId(game.roles.bumId)) {
      const lang = await getUserLang(game.roles.bumId);
      const promptText = t(lang, "prompt.bum", {
        channel: channelMention(game.channelId),
      });
      const blocks = buildPlayerButtonBlocks({
        channelId: game.channelId,
        actionId: ACTIONS.BUM_VISIT,
        text: promptText,
        players: aliveChoices,
        page: 0,
        pageSize: BUTTON_PAGE_SIZE,
        lang,
      });
      await sendInteractiveDM(client, game.roles.bumId, promptText, blocks);
    }
  }

  if (game.roles.lawyerId && isPlayerAlive(game, game.roles.lawyerId)) {
    if (!isTestUserId(game.roles.lawyerId)) {
      const lang = await getUserLang(game.roles.lawyerId);
      const promptText = t(lang, "prompt.lawyer", {
        channel: channelMention(game.channelId),
      });
      const blocks = buildPlayerButtonBlocks({
        channelId: game.channelId,
        actionId: ACTIONS.LAWYER_PROTECT,
        text: promptText,
        players: aliveChoices,
        page: 0,
        pageSize: BUTTON_PAGE_SIZE,
        lang,
      });
      await sendInteractiveDM(client, game.roles.lawyerId, promptText, blocks);
    }
  }

  if (game.roles.stalkerId && isPlayerAlive(game, game.roles.stalkerId)) {
    if (!isTestUserId(game.roles.stalkerId)) {
      const lang = await getUserLang(game.roles.stalkerId);
      const targetRole = game.stalker?.targetRole;
      const roleText = targetRole
        ? roleLabel(targetRole, lang)
        : t(lang, "home.role_unknown");
      const promptText = t(lang, "prompt.stalker", {
        channel: channelMention(game.channelId),
        role: roleText,
      });
      const stalkerTargets = aliveIds.filter(
        (id) => id !== game.roles.stalkerId
      );
      const stalkerChoices = await buildUserChoices(client, stalkerTargets);
      if (stalkerChoices.length === 0) return;
      const blocks = buildPlayerButtonBlocks({
        channelId: game.channelId,
        actionId: ACTIONS.STALKER_KILL,
        text: promptText,
        players: stalkerChoices,
        page: 0,
        pageSize: BUTTON_PAGE_SIZE,
        lang,
      });
      await sendInteractiveDM(client, game.roles.stalkerId, promptText, blocks);
    }
  }
}

async function sendNightPromptsTelegram(game) {
  if (!telegramBot) return;
  const rawChatId = stripPlatformPrefix(game.channelId);
  const mafiaTargets = listAliveNonMafiaIds(game);
  const aliveIds = getAlivePlayerIds(game);

  const mafiaChoices = await buildUserChoices(null, mafiaTargets);
  const aliveChoices = await buildUserChoices(null, aliveIds);

  for (const mafiaId of game.roles.mafiaIds) {
    if (!isPlayerAlive(game, mafiaId)) continue;
    if (isTestUserId(mafiaId)) continue;
    if (!mafiaChoices.length) continue;
    const lang = await getUserLang(mafiaId);
    const promptText = t(lang, "prompt.mafia", {
      channel: channelMention(game.channelId),
    });
    const extraButtons = [];
    if (game.config.allowNoKill) {
      extraButtons.push({
        text: t(lang, "button.no_kill"),
        value: SPECIAL_TARGETS.NO_KILL,
        actionId: ACTIONS.MAFIA_VOTE,
      });
    }
    const reply_markup = buildTelegramPlayerKeyboard({
      chatId: rawChatId,
      actionId: ACTIONS.MAFIA_VOTE,
      players: mafiaChoices,
      page: 0,
      pageSize: BUTTON_PAGE_SIZE,
      lang,
      extraButtons,
    });
    await sendInteractiveDM(null, mafiaId, promptText, { reply_markup });
  }

  if (game.roles.doctorId && isPlayerAlive(game, game.roles.doctorId)) {
    if (!isTestUserId(game.roles.doctorId)) {
      const lang = await getUserLang(game.roles.doctorId);
      const promptText = t(lang, "prompt.doctor", {
        channel: channelMention(game.channelId),
      });
      const reply_markup = buildTelegramPlayerKeyboard({
        chatId: rawChatId,
        actionId: ACTIONS.DOCTOR_SAVE,
        players: aliveChoices,
        page: 0,
        pageSize: BUTTON_PAGE_SIZE,
        lang,
      });
      await sendInteractiveDM(null, game.roles.doctorId, promptText, {
        reply_markup,
      });
    }
  }

  if (game.roles.detectiveId && isPlayerAlive(game, game.roles.detectiveId)) {
    if (!isTestUserId(game.roles.detectiveId)) {
      const lang = await getUserLang(game.roles.detectiveId);
      const promptText = t(lang, "prompt.detective_mode", {
        channel: channelMention(game.channelId),
      });
      const reply_markup = buildTelegramDetectiveModeKeyboard(lang, rawChatId);
      await sendInteractiveDM(null, game.roles.detectiveId, promptText, {
        reply_markup,
      });
    }
  }

  if (game.roles.bodyguardId && isPlayerAlive(game, game.roles.bodyguardId)) {
    if (!isTestUserId(game.roles.bodyguardId)) {
      const lang = await getUserLang(game.roles.bodyguardId);
      const promptText = t(lang, "prompt.bodyguard", {
        channel: channelMention(game.channelId),
      });
      const reply_markup = buildTelegramPlayerKeyboard({
        chatId: rawChatId,
        actionId: ACTIONS.BODYGUARD_PROTECT,
        players: aliveChoices,
        page: 0,
        pageSize: BUTTON_PAGE_SIZE,
        lang,
      });
      await sendInteractiveDM(null, game.roles.bodyguardId, promptText, {
        reply_markup,
      });
    }
  }

  if (game.roles.bumId && isPlayerAlive(game, game.roles.bumId)) {
    if (!isTestUserId(game.roles.bumId)) {
      const lang = await getUserLang(game.roles.bumId);
      const promptText = t(lang, "prompt.bum", {
        channel: channelMention(game.channelId),
      });
      const reply_markup = buildTelegramPlayerKeyboard({
        chatId: rawChatId,
        actionId: ACTIONS.BUM_VISIT,
        players: aliveChoices,
        page: 0,
        pageSize: BUTTON_PAGE_SIZE,
        lang,
      });
      await sendInteractiveDM(null, game.roles.bumId, promptText, {
        reply_markup,
      });
    }
  }

  if (game.roles.lawyerId && isPlayerAlive(game, game.roles.lawyerId)) {
    if (!isTestUserId(game.roles.lawyerId)) {
      const lang = await getUserLang(game.roles.lawyerId);
      const promptText = t(lang, "prompt.lawyer", {
        channel: channelMention(game.channelId),
      });
      const reply_markup = buildTelegramPlayerKeyboard({
        chatId: rawChatId,
        actionId: ACTIONS.LAWYER_PROTECT,
        players: aliveChoices,
        page: 0,
        pageSize: BUTTON_PAGE_SIZE,
        lang,
      });
      await sendInteractiveDM(null, game.roles.lawyerId, promptText, {
        reply_markup,
      });
    }
  }

  if (game.roles.stalkerId && isPlayerAlive(game, game.roles.stalkerId)) {
    if (!isTestUserId(game.roles.stalkerId)) {
      const lang = await getUserLang(game.roles.stalkerId);
      const targetRole = game.stalker?.targetRole;
      const roleText = targetRole
        ? roleLabel(targetRole, lang)
        : t(lang, "home.role_unknown");
      const promptText = t(lang, "prompt.stalker", {
        channel: channelMention(game.channelId),
        role: roleText,
      });
      const stalkerTargets = aliveIds.filter(
        (id) => id !== game.roles.stalkerId
      );
      const stalkerChoices = await buildUserChoices(null, stalkerTargets);
      if (!stalkerChoices.length) return;
      const reply_markup = buildTelegramPlayerKeyboard({
        chatId: rawChatId,
        actionId: ACTIONS.STALKER_KILL,
        players: stalkerChoices,
        page: 0,
        pageSize: BUTTON_PAGE_SIZE,
        lang,
      });
      await sendInteractiveDM(null, game.roles.stalkerId, promptText, {
        reply_markup,
      });
    }
  }
}

async function sendDayPrompts(client, game) {
  if (isTelegramKey(game.channelId)) {
    await sendDayPromptsTelegram(game);
    return;
  }
  const aliveIds = getAlivePlayerIds(game);
  const choices = await buildUserChoices(client, aliveIds);

  for (const userId of aliveIds) {
    if (isTestUserId(userId)) continue;
    const lang = await getUserLang(userId);
    const promptText = t(lang, "prompt.day", {
      channel: channelMention(game.channelId),
    });
    const extraButtons = [];
    if (game.config.allowAbstain) {
      extraButtons.push({
        text: t(lang, "button.abstain"),
        value: SPECIAL_TARGETS.ABSTAIN,
        actionId: ACTIONS.DAY_VOTE,
      });
    }
    const blocks = buildPlayerButtonBlocks({
      channelId: game.channelId,
      actionId: ACTIONS.DAY_VOTE,
      text: promptText,
      players: choices,
      page: 0,
      pageSize: BUTTON_PAGE_SIZE,
      lang,
      extraButtons,
    });

    await sendInteractiveDM(client, userId, promptText, blocks);
  }
}

async function sendDayPromptsTelegram(game) {
  if (!telegramBot) return;
  const rawChatId = stripPlatformPrefix(game.channelId);
  const aliveIds = getAlivePlayerIds(game);
  const choices = await buildUserChoices(null, aliveIds);

  for (const userId of aliveIds) {
    if (isTestUserId(userId)) continue;
    const lang = await getUserLang(userId);
    const promptText = t(lang, "prompt.day", {
      channel: channelMention(game.channelId),
    });
    const extraButtons = [];
    if (game.config.allowAbstain) {
      extraButtons.push({
        text: t(lang, "button.abstain"),
        value: SPECIAL_TARGETS.ABSTAIN,
        actionId: ACTIONS.DAY_VOTE,
      });
    }
    const reply_markup = buildTelegramPlayerKeyboard({
      chatId: rawChatId,
      actionId: ACTIONS.DAY_VOTE,
      players: choices,
      page: 0,
      pageSize: BUTTON_PAGE_SIZE,
      lang,
      extraButtons,
    });
    await sendInteractiveDM(null, userId, promptText, { reply_markup });
  }
}

function parseActionContext(action) {
  const actionId = action?.action_id || "";
  let channelId = action?.value || null;
  let page = 0;
  let actionType = actionId;

  const blockId = action?.block_id || "";
  if (blockId) {
    const parts = blockId.split("|");
    if (parts[0] === "pg") {
      actionType = parts[1] || actionType;
      channelId = parts[2] || channelId;
      page = Number(parts[3]) || 0;
    } else if (parts.length >= 2) {
      channelId = parts[1];
    }
  }

  return { actionId, actionType, channelId, page };
}

function getNightActorIds(game) {
  const alive = new Set(getAlivePlayerIds(game));
  const actorIds = [];
  const mafiaAlive = game.roles.mafiaIds.filter((id) => alive.has(id));
  actorIds.push(...mafiaAlive);
  if (game.roles.doctorId && alive.has(game.roles.doctorId))
    actorIds.push(game.roles.doctorId);
  if (game.roles.detectiveId && alive.has(game.roles.detectiveId))
    actorIds.push(game.roles.detectiveId);
  if (game.roles.bodyguardId && alive.has(game.roles.bodyguardId))
    actorIds.push(game.roles.bodyguardId);
  if (game.roles.bumId && alive.has(game.roles.bumId))
    actorIds.push(game.roles.bumId);
  if (game.roles.lawyerId && alive.has(game.roles.lawyerId))
    actorIds.push(game.roles.lawyerId);
  if (game.roles.stalkerId && alive.has(game.roles.stalkerId))
    actorIds.push(game.roles.stalkerId);
  return actorIds;
}

function maybeShortenPhase(game, phase) {
  if (!game.phaseDeadline) return false;
  if (!game.config.autoShorten) return false;
  if (!game.phaseShortened) game.phaseShortened = { day: false, night: false };
  if (game.phaseShortened[phase]) return false;
  const remaining = game.phaseDeadline - now();
  if (remaining <= PHASE_SHORTEN_REMAINING_MS) return false;

  let total = 0;
  let pending = 0;
  if (phase === "day") {
    total = getAlivePlayerIds(game).length;
    pending = getPendingDayVoters(game).length;
  } else if (phase === "night") {
    total = getNightActorIds(game).length;
    pending = getPendingNightActors(game).length;
  }

  if (!total) return false;
  const completed = total - pending;
  if (completed / total < PHASE_SHORTEN_THRESHOLD) return false;

  game.phaseDeadline = now() + PHASE_SHORTEN_REMAINING_MS;
  game.phaseShortened[phase] = true;
  schedulePhaseTimers(game);
  return true;
}

function nightReady(game) {
  return getPendingNightActors(game).length === 0;
}

function dayReady(game) {
  return getPendingDayVoters(game).length === 0;
}

function getTargetsForAction(game, actionType, actorId) {
  if (actionType === ACTIONS.MAFIA_VOTE) return listAliveNonMafiaIds(game);
  if (
    actionType === ACTIONS.DOCTOR_SAVE ||
    actionType === ACTIONS.DETECTIVE_CHECK ||
    actionType === ACTIONS.BODYGUARD_PROTECT ||
    actionType === ACTIONS.BUM_VISIT ||
    actionType === ACTIONS.LAWYER_PROTECT ||
    actionType === ACTIONS.DAY_VOTE
  ) {
    return getAlivePlayerIds(game);
  }
  if (actionType === ACTIONS.DETECTIVE_KILL) {
    const alive = getAlivePlayerIds(game);
    return actorId ? alive.filter((id) => id !== actorId) : alive;
  }
  if (actionType === ACTIONS.STALKER_KILL) {
    const alive = getAlivePlayerIds(game);
    return actorId ? alive.filter((id) => id !== actorId) : alive;
  }
  return [];
}

function getPromptTextForAction(lang, game, actionType) {
  const channel = channelMention(game.channelId);
  if (actionType === ACTIONS.MAFIA_VOTE)
    return t(lang, "prompt.mafia", { channel });
  if (actionType === ACTIONS.DOCTOR_SAVE)
    return t(lang, "prompt.doctor", { channel });
  if (actionType === ACTIONS.DETECTIVE_CHECK)
    return t(lang, "prompt.detective", { channel });
  if (actionType === ACTIONS.DETECTIVE_KILL)
    return t(lang, "prompt.detective_kill", { channel });
  if (actionType === ACTIONS.BODYGUARD_PROTECT)
    return t(lang, "prompt.bodyguard", { channel });
  if (actionType === ACTIONS.BUM_VISIT)
    return t(lang, "prompt.bum", { channel });
  if (actionType === ACTIONS.LAWYER_PROTECT)
    return t(lang, "prompt.lawyer", { channel });
  if (actionType === ACTIONS.STALKER_KILL) {
    const targetRole = game.stalker?.targetRole;
    const roleText = targetRole
      ? roleLabel(targetRole, lang)
      : t(lang, "home.role_unknown");
    return t(lang, "prompt.stalker", { channel, role: roleText });
  }
  if (actionType === ACTIONS.DAY_VOTE) return t(lang, "prompt.day", { channel });
  return t(lang, "action.failed");
}

app.event("app_mention", async ({ event, say, client }) => {
  if (!event.text) return;

  const text = event.text.replace(/<@[^>]+>/g, "").trim();
  const args = text.split(/\s+/).filter(Boolean);
  const command = (args[0] || "help").toLowerCase();
  const channelId = event.channel;
  const userId = event.user;

  if (await isMaintenanceEnabled()) {
    await respondMaintenanceInChannel(client, event);
    return;
  }

  await promptChannelListing(
    client,
    channelId,
    userId,
    event.channel_type === "group" ? "group" : "channel"
  );

  await withChannelLock(channelId, async () => {
    let game = getGame(channelId);

    switch (command) {
      case "help":
        await notifyEphemeralLocalized(client, channelId, userId, "help.commands");
        break;
      case "lang": {
        const choice = (args[1] || "").toLowerCase();
        if (!LANGS.includes(choice)) {
          await notifyEphemeralLocalized(
            client,
            channelId,
            userId,
            "dm.lang_usage"
          );
          break;
        }
        await setUserLang(userId, choice);
        const key = choice === "ru" ? "dm.lang_set_ru" : "dm.lang_set_en";
        await notifyEphemeral(client, channelId, userId, t(choice, key));
        break;
      }
      case "create":
      case "new": {
        if (game && game.state !== "ended") {
          await notifyEphemeralLocalized(
            client,
            channelId,
            userId,
            "err.lobby_exists"
          );
          break;
        }
        const blocking = findBlockingGame(userId, channelId);
        if (blocking) {
          await notifyEphemeralLocalized(
            client,
            channelId,
            userId,
            "err.already_in_other",
            { channel: channelMention(blocking.channelId) }
          );
          break;
        }
        game = createLobby(channelId, userId);
        const channelSettings = await getChannelSettings(channelId);
        applyChannelSettingsToGame(game, channelSettings);
        gameCache.set(channelId, game);
        saveGame(game);
        schedulePhaseTimers(game);
        await announceToChannelLocalized(client, game, "lobby.created", async (lang) => ({
          host: await getNameOrMention(client, game, userId, lang),
        }));
        await postOrUpdateLobbyPanel(client, game);
        await postOrUpdateDashboard(client, game);
        saveGame(game);
        await updateHomeForUsers(client, [
          userId,
          ...Object.keys(game.players || {}),
        ]);
        break;
      }
      case "join": {
        if (!game || game.state !== "lobby") {
          await notifyEphemeralLocalized(
            client,
            channelId,
            userId,
            "err.lobby_none"
          );
          break;
        }
        const blocking = findBlockingGame(userId, channelId);
        if (blocking) {
          await notifyEphemeralLocalized(
            client,
            channelId,
            userId,
            "err.already_in_other",
            { channel: channelMention(blocking.channelId) }
          );
          break;
        }
        if (game.players[userId]) {
          await notifyEphemeralLocalized(
            client,
            channelId,
            userId,
            "err.already_in"
          );
          break;
        }
        game.players[userId] = {
          id: userId,
          role: null,
          alive: true,
          joinedAt: now(),
          name: null,
          ready: false,
        };
        saveGame(game);
        await announceToChannelLocalized(client, game, "lobby.joined", async (lang) => ({
          user: await getNameOrMention(client, game, userId, lang),
          count: Object.keys(game.players).length,
        }));
        await postOrUpdateLobbyPanel(client, game);
        await postOrUpdateDashboard(client, game);
        saveGame(game);
        await updateHomeForGame(client, game);
        break;
      }
      case "leave": {
        if (!game || game.state !== "lobby") {
          await notifyEphemeralLocalized(
            client,
            channelId,
            userId,
            "err.lobby_only"
          );
          break;
        }
        if (!game.players[userId]) {
          await notifyEphemeralLocalized(
            client,
            channelId,
            userId,
            "err.not_in_lobby"
          );
          break;
        }
        delete game.players[userId];
        if (game.hostId === userId) {
          const remaining = Object.values(game.players).sort(
            (a, b) => a.joinedAt - b.joinedAt
          );
          game.hostId = remaining[0]?.id || null;
        }
        if (!game.hostId) {
          await closeLobby(client, game, { key: "lobby.empty_closed" });
          break;
        }
        saveGame(game);
        await announceToChannelLocalized(client, game, "lobby.left", async (lang) => ({
          user: await getNameOrMention(client, game, userId, lang),
          count: Object.keys(game.players).length,
        }));
        await postOrUpdateLobbyPanel(client, game);
        await postOrUpdateDashboard(client, game);
        saveGame(game);
        await updateHomeForGame(client, game);
        break;
      }
      case "start": {
        if (!game || game.state !== "lobby") {
          await notifyEphemeralLocalized(
            client,
            channelId,
            userId,
            "err.lobby_start_none"
          );
          break;
        }
        if (game.hostId !== userId) {
          await notifyEphemeralLocalized(
            client,
            channelId,
            userId,
            "err.only_host_start"
          );
          break;
        }
        if (Object.keys(game.players).length < game.config.minPlayers) {
          await notifyEphemeralLocalized(
            client,
            channelId,
            userId,
            "err.need_min_players",
            { min: game.config.minPlayers }
          );
          break;
        }
        await startGameFromLobby(client, game, { key: "lobby.host_start" });
        break;
      }
      case "status":
      case "players": {
        if (!game) {
          await notifyEphemeralLocalized(
            client,
            channelId,
            userId,
            "err.game_not_created"
          );
          break;
        }
        const lang = await getUserLang(userId);
        const alive = await listAliveDisplay(client, game, lang);
        await notifyEphemeralLocalized(
          client,
          channelId,
          userId,
          "status.text",
          {
            state: t(lang, `state.${game.state}`),
            host: await getNameOrMention(client, game, game.hostId, lang),
            alive,
          }
        );
        break;
      }
      case "config": {
        if (!game || game.state !== "lobby") {
          await notifyEphemeralLocalized(
            client,
            channelId,
            userId,
            "err.config_lobby_only"
          );
          break;
        }
        if (game.hostId !== userId) {
          await notifyEphemeralLocalized(
            client,
            channelId,
            userId,
            "err.config_host_only"
          );
          break;
        }

        if (args.length === 1) {
          await notifyEphemeralLocalized(
            client,
            channelId,
            userId,
            "config.summary",
            {
              day: Math.round(game.config.dayMs / 60000),
              night: Math.round(game.config.nightMs / 60000),
              lobby: Math.round(game.config.lobbyMs / 60000),
              min: game.config.minPlayers,
              extend: game.config.extendPolicy,
            }
          );
          break;
        }

        const key = args[1];
        if (key === "extend") {
          const policy = (args[2] || "").toLowerCase();
          if (!["host", "any"].includes(policy)) {
            await notifyEphemeralLocalized(
              client,
              channelId,
              userId,
              "err.config_usage_extend"
            );
            break;
          }
          game.config.extendPolicy = policy;
        } else {
          const value = Number(args[2]);
          if (!value || Number.isNaN(value)) {
            await notifyEphemeralLocalized(
              client,
              channelId,
              userId,
              "err.config_usage_numbers"
            );
            break;
          }

          if (key === "day") {
            game.config.dayMs = toMs(value);
          } else if (key === "night") {
            game.config.nightMs = toMs(value);
          } else if (key === "lobby") {
            game.config.lobbyMs = toMs(value);
            if (game.state === "lobby") {
              game.phaseDeadline = now() + game.config.lobbyMs;
              schedulePhaseTimers(game);
            }
          } else if (key === "min") {
            game.config.minPlayers = Math.max(4, Math.floor(value));
          } else {
            await notifyEphemeralLocalized(
              client,
              channelId,
              userId,
              "err.config_options"
            );
            break;
          }
        }

        saveGame(game);
        await notifyEphemeralLocalized(
          client,
          channelId,
          userId,
          "ok.settings_updated"
        );
        if (game.state === "lobby") {
          await postOrUpdateLobbyPanel(client, game);
          await postOrUpdateDashboard(client, game);
          saveGame(game);
          await updateHomeForGame(client, game);
        }
        break;
      }
      case "extend": {
        if (!game || game.state !== "lobby") {
          await notifyEphemeralLocalized(
            client,
            channelId,
            userId,
            "err.extend_lobby_only"
          );
          break;
        }
        if (!canExtendLobby(game, userId)) {
          await notifyEphemeralLocalized(
            client,
            channelId,
            userId,
            "err.extend_not_allowed"
          );
          break;
        }
        const minutes = Number(args[1]) || DEFAULTS.LOBBY_EXTEND_MINUTES;
        game.phaseDeadline = Math.max(now(), game.phaseDeadline || now()) + toMs(minutes);
        schedulePhaseTimers(game);
        saveGame(game);
        await announceToChannelLocalized(client, game, "lobby.extended", () => ({
          minutes,
        }));
        await postOrUpdateLobbyPanel(client, game);
        await postOrUpdateDashboard(client, game);
        saveGame(game);
        await updateHomeForGame(client, game);
        break;
      }
      case "end": {
        if (!game) {
          await notifyEphemeralLocalized(
            client,
            channelId,
            userId,
            "err.no_active_game"
          );
          break;
        }
        if (game.hostId !== userId) {
          await notifyEphemeralLocalized(
            client,
            channelId,
            userId,
            "err.only_host_end"
          );
          break;
        }
        clearPhaseTimers(channelId);
        if (game.state === "lobby") {
          await closeLobby(client, game, { key: "lobby.end" });
        } else {
          await finalizeDashboard(client, game);
          gameCache.delete(channelId);
          deleteGame(channelId);
          await announceToChannelLocalized(client, game, "lobby.end");
          await updateHomeForUsers(
            client,
            Object.keys(game.players || {})
          );
          await maybeNotifyMaintenanceDone(client);
        }
        break;
      }
      default:
        await notifyEphemeralLocalized(
          client,
          channelId,
          userId,
          "err.unknown_command"
        );
    }
  });
});

app.event("app_home_opened", async ({ event, client }) => {
  const userId = event.user;
  if (!userId) return;
  await publishHomeForUser(client, userId);
});

app.event("member_joined_channel", async ({ event, client }) => {
  await handleBotAddedToChannel(client, event);
});

async function sendRoleDM(client, game, userId, role) {
  if (isTestUserId(userId)) return;
  const lang = await getUserLang(userId);
  const text = t(lang, "action.role_dm", {
    channel: channelMention(game.channelId),
    role: roleLabel(role, lang),
  });
  if (isTelegramKey(userId)) {
    const replyMarkup = buildTelegramRoleHelpKeyboard(lang, role);
    await sendInteractiveDM(client, userId, text, { reply_markup: replyMarkup });
    return;
  }
  const blocks = [
    {
      type: "section",
      text: { type: "mrkdwn", text },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: t(lang, "button.role_help") },
          action_id: ACTIONS.ROLE_HELP,
          value: role,
        },
      ],
    },
  ];
  await sendInteractiveDM(client, userId, text, blocks);
}

function listTestPlayers(game) {
  return Object.values(game.players || {}).filter((player) => player?.isTest);
}

async function sendTestRoleSummary(client, game) {
  const testPlayers = listTestPlayers(game);
  if (testPlayers.length === 0) return;
  const controllerId = game.test?.controllerId || DEV_USER_ID;
  if (!controllerId) return;
  const lang = await getUserLang(controllerId);
  const lines = testPlayers
    .map(
      (player) =>
        `• ${player.name || player.id}: ${roleLabel(player.role, lang)}`
    )
    .join("\n");
  const text = t(lang, "test.roles_summary", {
    channel: channelMention(game.channelId),
    list: lines,
  });
  await sendInteractiveDM(client, controllerId, text);
}

async function sendTestActionReminder(client, game, phase) {
  const testPlayers = listTestPlayers(game).filter((p) => p.alive);
  if (testPlayers.length === 0) return;
  const controllerId = game.test?.controllerId || DEV_USER_ID;
  if (!controllerId) return;
  const lang = await getUserLang(controllerId);

  if (phase === "night") {
    const mafia = game.roles.mafiaIds
      .filter((id) => isTestUserId(id) && isPlayerAlive(game, id))
      .map((id) => getTestPlayerName(id));
    const doctor =
      game.roles.doctorId && isTestUserId(game.roles.doctorId) && isPlayerAlive(game, game.roles.doctorId)
        ? [getTestPlayerName(game.roles.doctorId)]
        : [];
    const detective =
      game.roles.detectiveId && isTestUserId(game.roles.detectiveId) && isPlayerAlive(game, game.roles.detectiveId)
        ? [getTestPlayerName(game.roles.detectiveId)]
        : [];
    const bodyguard =
      game.roles.bodyguardId && isTestUserId(game.roles.bodyguardId) && isPlayerAlive(game, game.roles.bodyguardId)
        ? [getTestPlayerName(game.roles.bodyguardId)]
        : [];
    const bum =
      game.roles.bumId && isTestUserId(game.roles.bumId) && isPlayerAlive(game, game.roles.bumId)
        ? [getTestPlayerName(game.roles.bumId)]
        : [];
    const lawyer =
      game.roles.lawyerId && isTestUserId(game.roles.lawyerId) && isPlayerAlive(game, game.roles.lawyerId)
        ? [getTestPlayerName(game.roles.lawyerId)]
        : [];
    const stalker =
      game.roles.stalkerId && isTestUserId(game.roles.stalkerId) && isPlayerAlive(game, game.roles.stalkerId)
        ? [getTestPlayerName(game.roles.stalkerId)]
        : [];

    const parts = [];
    if (mafia.length) parts.push(`${t(lang, "role.mafia")}: ${mafia.join(", ")}`);
    if (doctor.length) parts.push(`${t(lang, "role.doctor")}: ${doctor.join(", ")}`);
    if (detective.length)
      parts.push(`${t(lang, "role.detective")}: ${detective.join(", ")}`);
    if (bodyguard.length)
      parts.push(`${t(lang, "role.bodyguard")}: ${bodyguard.join(", ")}`);
    if (bum.length) parts.push(`${t(lang, "role.bum")}: ${bum.join(", ")}`);
    if (lawyer.length)
      parts.push(`${t(lang, "role.lawyer")}: ${lawyer.join(", ")}`);
    if (stalker.length)
      parts.push(`${t(lang, "role.stalker")}: ${stalker.join(", ")}`);

    if (parts.length === 0) return;
    const text = t(lang, "test.actions_reminder_night", {
      channel: channelMention(game.channelId),
      list: parts.join("\n"),
    });
    await sendInteractiveDM(client, controllerId, text);
    return;
  }

  if (phase === "day") {
    const alive = testPlayers.map((p) => p.name || p.id).join(", ");
    const text = t(lang, "test.actions_reminder_day", {
      channel: channelMention(game.channelId),
      list: alive || "-",
    });
    await sendInteractiveDM(client, controllerId, text);
  }
}

app.action(
  /^(detective_mode_check|detective_mode_kill)$/,
  async ({ ack, body, action, client }) => {
    await ack();
    const actorId = body.user.id;
    const actorLang = await getUserLang(actorId);
    const channelId = action?.value || parseActionContext(action).channelId;

    if (!channelId) {
      await updateActionMessage(client, body, t(actorLang, "action.failed"));
      return;
    }

    await withChannelLock(channelId, async () => {
      const game = getGame(channelId);
      if (!game) {
        await updateActionMessage(client, body, t(actorLang, "action.game_ended"));
        return;
      }

      if (!isPlayerAlive(game, actorId)) {
        await updateActionMessage(client, body, t(actorLang, "action.not_in_game"));
        return;
      }

      if (game.state !== "night") {
        await updateActionMessage(client, body, t(actorLang, "action.not_night"));
        return;
      }

      if (game.roles.detectiveId !== actorId) {
        await updateActionMessage(
          client,
          body,
          t(actorLang, "action.detective_only")
        );
        return;
      }

      if (game.night.detectiveCheck || game.night.detectiveKill) {
        await updateActionMessage(
          client,
          body,
          t(actorLang, "action.already_acted")
        );
        return;
      }

      const nextAction =
        action.action_id === ACTIONS.DETECTIVE_MODE_KILL
          ? ACTIONS.DETECTIVE_KILL
          : ACTIONS.DETECTIVE_CHECK;

      const targetIds = getTargetsForAction(game, nextAction, actorId);
      if (!targetIds.length) {
        await updateActionMessage(client, body, t(actorLang, "action.failed"));
        return;
      }

      const choices = await buildUserChoices(client, targetIds);
      const text = getPromptTextForAction(actorLang, game, nextAction);
      const blocks = buildPlayerButtonBlocks({
        channelId: game.channelId,
        actionId: nextAction,
        text,
        players: choices,
        page: 0,
        pageSize: BUTTON_PAGE_SIZE,
        lang: actorLang,
      });

      await updateActionMessage(client, body, text, blocks);
    });
  }
);

app.action(
  /^(day_vote|mafia_vote|doctor_save|detective_check|detective_kill|bodyguard_protect|bum_visit|lawyer_protect|stalker_kill)$/,
  async ({ ack, body, action, client }) => {
    await ack();

    const { actionId, channelId } = parseActionContext(action);
    const targetId = action?.selected_option?.value || action?.value;
    const actorId = body.user.id;
    const actorLang = await getUserLang(actorId);

    if (!channelId || !targetId) {
      await updateActionMessage(client, body, t(actorLang, "action.failed"));
      return;
    }

    await withChannelLock(channelId, async () => {
      const game = getGame(channelId);
      if (!game) {
        await updateActionMessage(client, body, t(actorLang, "action.game_ended"));
        return;
      }

      if (!isPlayerAlive(game, actorId)) {
        await updateActionMessage(client, body, t(actorLang, "action.not_in_game"));
        return;
      }

      if (actionId === ACTIONS.DAY_VOTE) {
        if (game.state !== "day") {
          await updateActionMessage(client, body, t(actorLang, "action.not_day"));
          return;
        }
        if (game.day.votes[actorId]) {
          await updateActionMessage(
            client,
            body,
            t(actorLang, "action.already_voted")
          );
          return;
        }
        if (
          targetId === SPECIAL_TARGETS.ABSTAIN &&
          !game.config.allowAbstain
        ) {
          await updateActionMessage(
            client,
            body,
            t(actorLang, "action.abstain_disabled")
          );
          return;
        }
        if (targetId !== SPECIAL_TARGETS.ABSTAIN) {
          if (!isPlayerAlive(game, targetId)) {
            await updateActionMessage(
              client,
              body,
              t(actorLang, "action.choose_alive")
            );
            return;
          }
        }
        game.day.votes[actorId] = targetId;
        saveGame(game);
        if (targetId === SPECIAL_TARGETS.ABSTAIN) {
          await updateActionMessage(
            client,
            body,
            t(actorLang, "action.vote_abstain")
          );
        } else {
          await updateActionMessage(
            client,
            body,
            t(actorLang, "action.vote_recorded", {
              target: mention(targetId),
            })
          );
        }

        if (maybeShortenPhase(game, "day")) {
          await announceToChannelLocalized(client, game, "warn.shortened_day");
          await postOrUpdateDashboard(client, game);
          saveGame(game);
        }

        if (dayReady(game)) {
          clearPhaseTimers(channelId);
          await resolveDay(client, game, false);
        }
        return;
      }

      if (game.state !== "night") {
        await updateActionMessage(client, body, t(actorLang, "action.not_night"));
        return;
      }

      if (actionId === ACTIONS.MAFIA_VOTE) {
        if (!isMafia(game, actorId)) {
          await updateActionMessage(
            client,
            body,
            t(actorLang, "action.mafia_only")
          );
          return;
        }
        if (game.night.mafiaVotes[actorId]) {
          await updateActionMessage(
            client,
            body,
            t(actorLang, "action.already_acted")
          );
          return;
        }
        if (
          targetId === SPECIAL_TARGETS.NO_KILL &&
          !game.config.allowNoKill
        ) {
          await updateActionMessage(
            client,
            body,
            t(actorLang, "action.no_kill_disabled")
          );
          return;
        }
        if (targetId !== SPECIAL_TARGETS.NO_KILL) {
          if (!isPlayerAlive(game, targetId)) {
            await updateActionMessage(
              client,
              body,
              t(actorLang, "action.choose_alive")
            );
            return;
          }
          if (isMafia(game, targetId)) {
            await updateActionMessage(
              client,
              body,
              t(actorLang, "action.no_mafia_target")
            );
            return;
          }
        }
        game.night.mafiaVotes[actorId] = targetId;
        saveGame(game);
        if (targetId === SPECIAL_TARGETS.NO_KILL) {
          await updateActionMessage(client, body, t(actorLang, "action.no_kill"));
        } else {
          await updateActionMessage(
            client,
            body,
            t(actorLang, "action.choice_recorded", {
              target: mention(targetId),
            })
          );
        }
      }

      if (actionId === ACTIONS.DOCTOR_SAVE) {
        if (game.roles.doctorId !== actorId) {
          await updateActionMessage(
            client,
            body,
            t(actorLang, "action.doctor_only")
          );
          return;
        }
        if (game.night.doctorSave) {
          await updateActionMessage(
            client,
            body,
            t(actorLang, "action.already_acted")
          );
          return;
        }
        if (!isPlayerAlive(game, targetId)) {
          await updateActionMessage(
            client,
            body,
            t(actorLang, "action.choose_alive")
          );
          return;
        }
        if (
          targetId === actorId &&
          game.doctorSelfSavesUsed >= game.config.doctorSelfSaveLimit
        ) {
          await updateActionMessage(
            client,
            body,
            t(actorLang, "action.doctor_self_save_limit")
          );
          return;
        }
        game.night.doctorSave = targetId;
        if (targetId === actorId) game.doctorSelfSavesUsed += 1;
        saveGame(game);
        await updateActionMessage(
          client,
          body,
          t(actorLang, "action.doctor_save", {
            target: mention(targetId),
          })
        );
      }

      if (actionId === ACTIONS.DETECTIVE_CHECK) {
        if (game.roles.detectiveId !== actorId) {
          await updateActionMessage(
            client,
            body,
            t(actorLang, "action.detective_only")
          );
          return;
        }
        if (game.night.detectiveCheck || game.night.detectiveKill) {
          await updateActionMessage(
            client,
            body,
            t(actorLang, "action.already_acted")
          );
          return;
        }
        if (!isPlayerAlive(game, targetId)) {
          await updateActionMessage(
            client,
            body,
            t(actorLang, "action.choose_alive")
          );
          return;
        }
        game.night.detectiveCheck = targetId;
        saveGame(game);
        await updateActionMessage(
          client,
          body,
          t(actorLang, "action.detective_check", {
            target: mention(targetId),
          })
        );

        const result = isDetectiveSeesMafia(game, targetId)
          ? t(actorLang, "action.result_mafia")
          : t(actorLang, "action.result_not_mafia");
        await client.chat.postMessage({
          channel: body.channel.id,
          text: t(actorLang, "action.detective_result", {
            target: mention(targetId),
            result,
          }),
        });

        const sergeantId = game.roles.sergeantId;
        if (
          sergeantId &&
          sergeantId !== actorId &&
          isPlayerAlive(game, sergeantId) &&
          !isTestUserId(sergeantId)
        ) {
          const serLang = await getUserLang(sergeantId);
          const serResult = isDetectiveSeesMafia(game, targetId)
            ? t(serLang, "action.result_mafia")
            : t(serLang, "action.result_not_mafia");
          await sendInteractiveDM(client, sergeantId, t(serLang, "sergeant.info", {
            target: mention(targetId),
            result: serResult,
          }));
        }
      }

      if (actionId === ACTIONS.DETECTIVE_KILL) {
        if (game.roles.detectiveId !== actorId) {
          await updateActionMessage(
            client,
            body,
            t(actorLang, "action.detective_only")
          );
          return;
        }
        if (game.night.detectiveCheck || game.night.detectiveKill) {
          await updateActionMessage(
            client,
            body,
            t(actorLang, "action.already_acted")
          );
          return;
        }
        if (!isPlayerAlive(game, targetId) || targetId === actorId) {
          await updateActionMessage(
            client,
            body,
            t(actorLang, "action.choose_alive")
          );
          return;
        }
        game.night.detectiveKill = targetId;
        saveGame(game);
        await updateActionMessage(
          client,
          body,
          t(actorLang, "action.detective_kill", {
            target: mention(targetId),
          })
        );
      }

      if (actionId === ACTIONS.BODYGUARD_PROTECT) {
        if (game.roles.bodyguardId !== actorId) {
          await updateActionMessage(
            client,
            body,
            t(actorLang, "action.bodyguard_only")
          );
          return;
        }
        if (game.night.bodyguardProtect) {
          await updateActionMessage(
            client,
            body,
            t(actorLang, "action.already_acted")
          );
          return;
        }
        if (!isPlayerAlive(game, targetId)) {
          await updateActionMessage(
            client,
            body,
            t(actorLang, "action.choose_alive")
          );
          return;
        }
        game.night.bodyguardProtect = targetId;
        saveGame(game);
        await updateActionMessage(
          client,
          body,
          t(actorLang, "action.bodyguard_protect", {
            target: mention(targetId),
          })
        );
      }

      if (actionId === ACTIONS.BUM_VISIT) {
        if (game.roles.bumId !== actorId) {
          await updateActionMessage(
            client,
            body,
            t(actorLang, "action.bum_only")
          );
          return;
        }
        if (game.night.bumVisit) {
          await updateActionMessage(
            client,
            body,
            t(actorLang, "action.already_acted")
          );
          return;
        }
        if (!isPlayerAlive(game, targetId)) {
          await updateActionMessage(
            client,
            body,
            t(actorLang, "action.choose_alive")
          );
          return;
        }
        game.night.bumVisit = targetId;
        saveGame(game);
        await updateActionMessage(
          client,
          body,
          t(actorLang, "action.bum_visit", {
            target: mention(targetId),
          })
        );
      }

      if (actionId === ACTIONS.LAWYER_PROTECT) {
        if (game.roles.lawyerId !== actorId) {
          await updateActionMessage(
            client,
            body,
            t(actorLang, "action.lawyer_only")
          );
          return;
        }
        if (game.night.lawyerProtect) {
          await updateActionMessage(
            client,
            body,
            t(actorLang, "action.already_acted")
          );
          return;
        }
        if (!isPlayerAlive(game, targetId)) {
          await updateActionMessage(
            client,
            body,
            t(actorLang, "action.choose_alive")
          );
          return;
        }
        game.night.lawyerProtect = targetId;
        saveGame(game);
        await updateActionMessage(
          client,
          body,
          t(actorLang, "action.lawyer_protect", {
            target: mention(targetId),
          })
        );
      }

      if (actionId === ACTIONS.STALKER_KILL) {
        if (game.roles.stalkerId !== actorId) {
          await updateActionMessage(
            client,
            body,
            t(actorLang, "action.stalker_only")
          );
          return;
        }
        if (game.night.stalkerKill) {
          await updateActionMessage(
            client,
            body,
            t(actorLang, "action.already_acted")
          );
          return;
        }
        if (!isPlayerAlive(game, targetId) || targetId === actorId) {
          await updateActionMessage(
            client,
            body,
            t(actorLang, "action.choose_alive")
          );
          return;
        }
        game.night.stalkerKill = targetId;
        saveGame(game);
        await updateActionMessage(
          client,
          body,
          t(actorLang, "action.stalker_kill", {
            target: mention(targetId),
          })
        );
      }

      if (maybeShortenPhase(game, "night")) {
        await announceToChannelLocalized(client, game, "warn.shortened_night");
        await postOrUpdateDashboard(client, game);
        saveGame(game);
      }

      if (nightReady(game)) {
        clearPhaseTimers(channelId);
        await resolveNight(client, game, false);
      }
    });
  }
);

app.action(
  /^(page_prev|page_next)$/,
  async ({ ack, body, action, client }) => {
    await ack();
    const actorId = body.user.id;
    const actorLang = await getUserLang(actorId);
    const { actionType, channelId, page } = parseActionContext(action);

    if (!channelId) {
      await updateActionMessage(client, body, t(actorLang, "action.failed"));
      return;
    }

    await withChannelLock(channelId, async () => {
      const game = getGame(channelId);
      if (!game) {
        await updateActionMessage(client, body, t(actorLang, "action.game_ended"));
        return;
      }

      if (!isPlayerAlive(game, actorId)) {
        await updateActionMessage(client, body, t(actorLang, "action.not_in_game"));
        return;
      }

      if (actionType === ACTIONS.DAY_VOTE) {
        if (game.state !== "day") {
          await updateActionMessage(client, body, t(actorLang, "action.not_day"));
          return;
        }
        if (game.day.votes[actorId]) {
          await updateActionMessage(
            client,
            body,
            t(actorLang, "action.already_voted")
          );
          return;
        }
      } else {
        if (game.state !== "night") {
          await updateActionMessage(client, body, t(actorLang, "action.not_night"));
          return;
        }
        if (actionType === ACTIONS.MAFIA_VOTE && !isMafia(game, actorId)) {
          await updateActionMessage(client, body, t(actorLang, "action.mafia_only"));
          return;
        }
        if (actionType === ACTIONS.DOCTOR_SAVE && game.roles.doctorId !== actorId) {
          await updateActionMessage(client, body, t(actorLang, "action.doctor_only"));
          return;
        }
        if (
          actionType === ACTIONS.DETECTIVE_CHECK &&
          game.roles.detectiveId !== actorId
        ) {
          await updateActionMessage(
            client,
            body,
            t(actorLang, "action.detective_only")
          );
          return;
        }
        if (
          actionType === ACTIONS.DETECTIVE_KILL &&
          game.roles.detectiveId !== actorId
        ) {
          await updateActionMessage(
            client,
            body,
            t(actorLang, "action.detective_only")
          );
          return;
        }
        if (
          actionType === ACTIONS.BODYGUARD_PROTECT &&
          game.roles.bodyguardId !== actorId
        ) {
          await updateActionMessage(
            client,
            body,
            t(actorLang, "action.bodyguard_only")
          );
          return;
        }
        if (
          actionType === ACTIONS.BUM_VISIT &&
          game.roles.bumId !== actorId
        ) {
          await updateActionMessage(
            client,
            body,
            t(actorLang, "action.bum_only")
          );
          return;
        }
        if (
          actionType === ACTIONS.LAWYER_PROTECT &&
          game.roles.lawyerId !== actorId
        ) {
          await updateActionMessage(
            client,
            body,
            t(actorLang, "action.lawyer_only")
          );
          return;
        }
        if (
          actionType === ACTIONS.STALKER_KILL &&
          game.roles.stalkerId !== actorId
        ) {
          await updateActionMessage(
            client,
            body,
            t(actorLang, "action.stalker_only")
          );
          return;
        }

        if (actionType === ACTIONS.MAFIA_VOTE && game.night.mafiaVotes[actorId]) {
          await updateActionMessage(
            client,
            body,
            t(actorLang, "action.already_acted")
          );
          return;
        }
        if (
          actionType === ACTIONS.DOCTOR_SAVE &&
          game.night.doctorSave
        ) {
          await updateActionMessage(
            client,
            body,
            t(actorLang, "action.already_acted")
          );
          return;
        }
        if (
          (actionType === ACTIONS.DETECTIVE_CHECK ||
            actionType === ACTIONS.DETECTIVE_KILL) &&
          (game.night.detectiveCheck || game.night.detectiveKill)
        ) {
          await updateActionMessage(
            client,
            body,
            t(actorLang, "action.already_acted")
          );
          return;
        }
        if (
          actionType === ACTIONS.BODYGUARD_PROTECT &&
          game.night.bodyguardProtect
        ) {
          await updateActionMessage(
            client,
            body,
            t(actorLang, "action.already_acted")
          );
          return;
        }
        if (
          actionType === ACTIONS.BUM_VISIT &&
          game.night.bumVisit
        ) {
          await updateActionMessage(
            client,
            body,
            t(actorLang, "action.already_acted")
          );
          return;
        }
        if (
          actionType === ACTIONS.LAWYER_PROTECT &&
          game.night.lawyerProtect
        ) {
          await updateActionMessage(
            client,
            body,
            t(actorLang, "action.already_acted")
          );
          return;
        }
        if (
          actionType === ACTIONS.STALKER_KILL &&
          game.night.stalkerKill
        ) {
          await updateActionMessage(
            client,
            body,
            t(actorLang, "action.already_acted")
          );
          return;
        }
      }

      const targetIds = getTargetsForAction(game, actionType, actorId);
      if (!targetIds.length) {
        await updateActionMessage(client, body, t(actorLang, "action.failed"));
        return;
      }

      const choices = await buildUserChoices(client, targetIds);
      const totalPages = Math.max(
        1,
        Math.ceil(choices.length / BUTTON_PAGE_SIZE)
      );
      const direction = action.action_id === ACTIONS.PAGE_NEXT ? 1 : -1;
      const newPage = Math.max(0, Math.min(totalPages - 1, page + direction));
      const text = getPromptTextForAction(actorLang, game, actionType);
      const extraButtons = [];
      if (actionType === ACTIONS.DAY_VOTE) {
        if (game.config.allowAbstain) {
          extraButtons.push({
            text: t(actorLang, "button.abstain"),
            value: SPECIAL_TARGETS.ABSTAIN,
            actionId: ACTIONS.DAY_VOTE,
          });
        }
      }
      if (actionType === ACTIONS.MAFIA_VOTE) {
        if (game.config.allowNoKill) {
          extraButtons.push({
            text: t(actorLang, "button.no_kill"),
            value: SPECIAL_TARGETS.NO_KILL,
            actionId: ACTIONS.MAFIA_VOTE,
          });
        }
      }
      const blocks = buildPlayerButtonBlocks({
        channelId: game.channelId,
        actionId: actionType,
        text,
        players: choices,
        page: newPage,
        pageSize: BUTTON_PAGE_SIZE,
        lang: actorLang,
        extraButtons,
      });

      await updateActionMessage(client, body, text, blocks);
    });
  }
);

app.action(
  /^(lobby_join|lobby_leave|lobby_start|lobby_extend|lobby_end|lobby_ready)$/,
  async ({ ack, body, action, client }) => {
    await ack();

    const { actionId } = parseActionContext(action);
    const channelId = action?.value || body?.channel?.id;
    const userId = body.user.id;

    if (!channelId) {
      await notifyEphemeralLocalized(
        client,
        body?.channel?.id,
        userId,
        "err.channel_unknown"
      );
      return;
    }

    if (await isMaintenanceEnabled()) {
      await notifyEphemeralLocalized(
        client,
        channelId,
        userId,
        "maintenance.blocked"
      );
      return;
    }

    await withChannelLock(channelId, async () => {
      const game = getGame(channelId);
      if (!game || game.state !== "lobby") {
        await notifyEphemeralLocalized(
          client,
          channelId,
          userId,
          "err.lobby_not_active"
        );
        return;
      }

      if (actionId === ACTIONS.LOBBY_JOIN) {
        const blocking = findBlockingGame(userId, channelId);
        if (blocking) {
          await notifyEphemeralLocalized(
            client,
            channelId,
            userId,
            "err.already_in_other",
            { channel: channelMention(blocking.channelId) }
          );
          return;
        }
        if (game.players[userId]) {
          await notifyEphemeralLocalized(
            client,
            channelId,
            userId,
            "err.already_in"
          );
          return;
        }
        game.players[userId] = {
          id: userId,
          role: null,
          alive: true,
          joinedAt: now(),
          name: null,
          ready: false,
        };
        saveGame(game);
        await announceToChannelLocalized(client, game, "lobby.joined", async (lang) => ({
          user: await getNameOrMention(client, game, userId, lang),
          count: Object.keys(game.players).length,
        }));
        await postOrUpdateLobbyPanel(client, game);
        await postOrUpdateDashboard(client, game);
        saveGame(game);
        await updateHomeForUsers(client, [
          userId,
          ...Object.keys(game.players || {}),
        ]);
        return;
      }

      if (actionId === ACTIONS.LOBBY_LEAVE) {
        if (!game.players[userId]) {
          await notifyEphemeralLocalized(
            client,
            channelId,
            userId,
            "err.not_in_lobby"
          );
          return;
        }
        delete game.players[userId];
        if (game.hostId === userId) {
          const remaining = Object.values(game.players).sort(
            (a, b) => a.joinedAt - b.joinedAt
          );
          game.hostId = remaining[0]?.id || null;
        }
        if (!game.hostId) {
          await closeLobby(client, game, { key: "lobby.empty_closed" });
          return;
        }
        saveGame(game);
        await announceToChannelLocalized(client, game, "lobby.left", async (lang) => ({
          user: await getNameOrMention(client, game, userId, lang),
          count: Object.keys(game.players).length,
        }));
        await postOrUpdateLobbyPanel(client, game);
        await postOrUpdateDashboard(client, game);
        saveGame(game);
        await updateHomeForGame(client, game);
        return;
      }

      if (actionId === ACTIONS.LOBBY_START) {
        if (game.hostId !== userId) {
          await notifyEphemeralLocalized(
            client,
            channelId,
            userId,
            "err.only_host_start"
          );
          return;
        }
        if (Object.keys(game.players).length < game.config.minPlayers) {
          await notifyEphemeralLocalized(
            client,
            channelId,
            userId,
            "err.need_min_players",
            { min: game.config.minPlayers }
          );
          return;
        }
        await startGameFromLobby(client, game, { key: "lobby.host_start" });
        return;
      }

      if (actionId === ACTIONS.LOBBY_READY) {
        if (!game.players[userId]) {
          await notifyEphemeralLocalized(
            client,
            channelId,
            userId,
            "err.not_in_lobby"
          );
          return;
        }
        game.players[userId].ready = !game.players[userId].ready;
        saveGame(game);
        await postOrUpdateLobbyPanel(client, game);
        await postOrUpdateDashboard(client, game);
        saveGame(game);
        await updateHomeForGame(client, game);
        if (
          Object.keys(game.players).length >= game.config.minPlayers &&
          allPlayersReady(game)
        ) {
          await startGameFromLobby(client, game, { key: "lobby.ready_start" });
        }
        return;
      }

      if (actionId === ACTIONS.LOBBY_EXTEND) {
        if (!canExtendLobby(game, userId)) {
          await notifyEphemeralLocalized(
            client,
            channelId,
            userId,
            "err.extend_not_allowed"
          );
          return;
        }
        const minutes = DEFAULTS.LOBBY_EXTEND_MINUTES;
        game.phaseDeadline =
          Math.max(now(), game.phaseDeadline || now()) + toMs(minutes);
        schedulePhaseTimers(game);
        saveGame(game);
        await announceToChannelLocalized(client, game, "lobby.extended", () => ({
          minutes,
        }));
        await postOrUpdateLobbyPanel(client, game);
        await postOrUpdateDashboard(client, game);
        saveGame(game);
        await updateHomeForGame(client, game);
        return;
      }

      if (actionId === ACTIONS.LOBBY_END) {
        if (game.hostId !== userId) {
          await notifyEphemeralLocalized(
            client,
            channelId,
            userId,
            "err.only_host_end"
          );
          return;
        }
        await closeLobby(client, game, { key: "lobby.end" });
        return;
      }
    });
  }
);

app.action(
  /^(lang_select_en|lang_select_ru)$/,
  async ({ ack, body, action, client }) => {
    await ack();
    const userId = body.user.id;
    const choice =
      action.action_id === ACTIONS.LANG_SELECT_RU ? "ru" : "en";
    const langInfo = await getUserLangInfo(userId);

    if (langInfo.explicit) {
      await updateActionMessage(
        client,
        body,
        t(langInfo.lang, "dm.lang_change_command")
      );
      return;
    }

    await setUserLang(userId, choice);
    const text =
      choice === "ru"
        ? t("ru", "dm.lang_set_ru")
        : t("en", "dm.lang_set_en");
    await updateActionMessage(client, body, text);
  }
);

app.action(ACTIONS.ROLE_HELP, async ({ ack, body, action, client }) => {
  await ack();
  const userId = body.user.id;
  const lang = await getUserLang(userId);
  const role = action?.value || "town";
  const baseText = body?.message?.text || t(lang, "action.role_dm", {
    channel: "",
    role: roleLabel(role, lang),
  });
  const helpKey = `role_help.${role}`;
  const helpText =
    getByPath(I18N[lang] || {}, helpKey) ||
    getByPath(I18N[DEFAULT_LANG] || {}, helpKey) ||
    t(lang, "role_help.town");
  const blocks = [
    {
      type: "section",
      text: { type: "mrkdwn", text: baseText },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: helpText },
    },
  ];
  await updateActionMessage(client, body, baseText, blocks);
});

app.action(
  /^(dm_help_add|dm_help_commands|dm_help_settings)$/,
  async ({ ack, body, action, client }) => {
    await ack();
    const userId = body.user.id;
    const lang = await getUserLang(userId);
    let text = t(lang, "dm.help_intro");
    if (action.action_id === ACTIONS.DM_HELP_ADD) text = t(lang, "dm.help_add");
    if (action.action_id === ACTIONS.DM_HELP_COMMANDS)
      text = t(lang, "dm.help_commands");
    if (action.action_id === ACTIONS.DM_HELP_SETTINGS)
      text = t(lang, "dm.help_settings");
    text = withDevHint(text, lang, userId);

    await updateActionMessage(client, body, text, buildDmHelpBlocks(lang, text));
  }
);

app.action(ACTIONS.DEV_MAINT_TOGGLE, async ({ ack, body, client }) => {
  await ack();
  const userId = body.user.id;
  const lang = await getUserLang(userId);

  if (!isDevUser(userId)) {
    await updateActionMessage(client, body, t(lang, "dev.not_authorized"));
    return;
  }

  const state = await getMaintenanceState();
  const enabled = !state.enabled;
  await setMaintenanceState({
    enabled,
    by: userId,
    requested_at: now(),
    notified: enabled ? false : state.notified,
  });

  if (enabled) {
    await closeAllLobbiesForMaintenance(client);
  }

  await maybeNotifyMaintenanceDone(client);

  const blocks = buildDevPanelBlocks(lang, enabled);
  await updateActionMessage(client, body, t(lang, "dev.panel.title"), blocks);
});

app.action(ACTIONS.FIND_GAMES_OPEN, async ({ ack, body, client }) => {
  await ack();
  const userId = body.user.id;
  const lang = await getUserLang(userId);
  const convo = await client.conversations.open({ users: userId });
  const blocks = await buildFindGamesBlocks(lang, "recruiting", 0, "all");
  await client.chat.postMessage({
    channel: convo.channel.id,
    text: t(lang, "find.title"),
    blocks,
  });
});

app.action(
  /^(find_filter_active|find_filter_recruiting|find_filter_inactive|find_lang_all|find_lang_en|find_lang_ru|find_page_prev|find_page_next)$/,
  async ({ ack, body, action, client }) => {
    await ack();
    const userId = body.user.id;
    const lang = await getUserLang(userId);
    const ctx = parseFindContext(action) || {
      filter: "recruiting",
      lang: "all",
      page: 0,
    };
    let filter = ctx.filter;
    let page = ctx.page;
    let langFilter = ctx.lang || "all";

    if (action.action_id === ACTIONS.FIND_FILTER_ACTIVE) {
      filter = "active";
      page = 0;
    } else if (action.action_id === ACTIONS.FIND_FILTER_RECRUITING) {
      filter = "recruiting";
      page = 0;
    } else if (action.action_id === ACTIONS.FIND_FILTER_INACTIVE) {
      filter = "inactive";
      page = 0;
    } else if (action.action_id === ACTIONS.FIND_LANG_ALL) {
      langFilter = "all";
      page = 0;
    } else if (action.action_id === ACTIONS.FIND_LANG_EN) {
      langFilter = "en";
      page = 0;
    } else if (action.action_id === ACTIONS.FIND_LANG_RU) {
      langFilter = "ru";
      page = 0;
    } else if (action.action_id === ACTIONS.FIND_PAGE_NEXT) {
      page += 1;
    } else if (action.action_id === ACTIONS.FIND_PAGE_PREV) {
      page -= 1;
    }

    const blocks = await buildFindGamesBlocks(lang, filter, page, langFilter);
    await updateActionMessage(client, body, t(lang, "find.title"), blocks);
  }
);

app.action(ACTIONS.FAQ_OPEN, async ({ ack, body, client }) => {
  await ack();
  const userId = body.user.id;
  const lang = await getUserLang(userId);
  const view = buildFaqListView(lang, 0);
  if (body.view && body.view.type === "modal") {
    await client.views.push({ trigger_id: body.trigger_id, view });
    return;
  }
  await client.views.open({ trigger_id: body.trigger_id, view });
});

app.action(
  /^(faq_page_prev|faq_page_next)$/,
  async ({ ack, body, action, client }) => {
    await ack();
    const userId = body.user.id;
    const lang = await getUserLang(userId);
    const currentPage = getFaqPageFromView(body.view);
    const nextPage =
      action.action_id === ACTIONS.FAQ_PAGE_NEXT
        ? currentPage + 1
        : currentPage - 1;
    const view = buildFaqListView(lang, nextPage);
    if (body.view) {
      try {
        await client.views.update({
          view_id: body.view.id,
          view,
        });
        return;
      } catch (err) {
        console.error("FAQ page update failed:", err);
      }
    }
    if (body.trigger_id) {
      await client.views.open({ trigger_id: body.trigger_id, view });
    }
  }
);

app.action(ACTIONS.FAQ_TOPIC, async ({ ack, body, action, client }) => {
  await ack();
  const userId = body.user.id;
  const lang = await getUserLang(userId);
  const faqId = action?.value;
  const page = body.view ? getFaqPageFromView(body.view) : 0;
  const item = getFaqItemById(faqId, lang);
  const view = item
    ? buildFaqDetailView(lang, item.id, page)
    : buildFaqListView(lang, 0);

  if (body.view) {
    if (isFaqView(body.view)) {
      try {
        await client.views.update({
          view_id: body.view.id,
          view,
        });
        return;
      } catch (err) {
        console.error("FAQ topic update failed:", err);
      }
    }
    await client.views.push({ trigger_id: body.trigger_id, view });
    return;
  }
  await client.views.open({ trigger_id: body.trigger_id, view });
});

app.action(ACTIONS.FAQ_BACK, async ({ ack, body, client }) => {
  await ack();
  const userId = body.user.id;
  const lang = await getUserLang(userId);
  const page = getFaqPageFromView(body.view);
  const view = buildFaqListView(lang, page);
  if (body.view) {
    try {
      await client.views.update({
        view_id: body.view.id,
        view,
      });
      return;
    } catch (err) {
      console.error("FAQ back update failed:", err);
    }
  }
  if (body.trigger_id) {
    await client.views.open({ trigger_id: body.trigger_id, view });
  }
});

app.action(ACTIONS.MY_CHANNELS_OPEN, async ({ ack, body, client }) => {
  await ack();
  const userId = body.user.id;
  const lang = await getUserLang(userId);
  const convo = await client.conversations.open({ users: userId });
  const blocks = await buildMyChannelsBlocks(client, userId, lang, 0);
  await client.chat.postMessage({
    channel: convo.channel.id,
    text: t(lang, "my_channels.title"),
    blocks,
  });
});

app.action(
  /^(my_channels_page_prev|my_channels_page_next)$/,
  async ({ ack, body, action, client }) => {
    await ack();
    const userId = body.user.id;
    const lang = await getUserLang(userId);
    const ctx = parseMyChannelsContext(action) || { page: 0 };
    let page = ctx.page;
    if (action.action_id === ACTIONS.MY_CHANNELS_PAGE_NEXT) page += 1;
    if (action.action_id === ACTIONS.MY_CHANNELS_PAGE_PREV) page -= 1;
    const blocks = await buildMyChannelsBlocks(client, userId, lang, page);
    await updateActionMessage(client, body, t(lang, "my_channels.title"), blocks);
  }
);

app.action(ACTIONS.CHANNEL_EDIT_OPEN, async ({ ack, body, action, client }) => {
  await ack();
  const userId = body.user.id;
  const lang = await getUserLang(userId);
  const channelId = action?.value;
  if (!channelId) {
    await updateActionMessage(client, body, t(lang, "err.channel_unknown"));
    return;
  }

  const pref = await getChannelPref(channelId);
  if (!pref || pref.listed_by !== userId) {
    await updateActionMessage(client, body, t(lang, "my_channels.not_owner"));
    return;
  }

  const settings = parseSettingsJson(pref.settings_json);
  const listed =
    pref.listed === 1 && pref.channel_type !== "group";
  const view = buildChannelEditView(lang, channelId, settings, listed);
  await client.views.open({
    trigger_id: body.trigger_id,
    view,
  });
});

app.view("channel_edit", async ({ ack, body, view, client }) => {
  const userId = body.user.id;
  const lang = await getUserLang(userId);
  let channelId = null;
  try {
    const meta = JSON.parse(view.private_metadata || "{}");
    channelId = meta.channelId || null;
  } catch (err) {
    channelId = null;
  }

  if (!channelId) {
    await ack();
    return;
  }

  const pref = await getChannelPref(channelId);
  if (!pref || pref.listed_by !== userId) {
    await ack();
    const convo = await client.conversations.open({ users: userId });
    await client.chat.postMessage({
      channel: convo.channel.id,
      text: t(lang, "my_channels.not_owner"),
    });
    return;
  }

  const errors = {};
  const privacy = readViewValue(view, "privacy", "privacy_select");
  const channelLang = readViewValue(view, "channel_lang", "channel_lang");
  const dayStr = readViewValue(view, "day_minutes", "day_minutes");
  const nightStr = readViewValue(view, "night_minutes", "night_minutes");
  const lobbyStr = readViewValue(view, "lobby_minutes", "lobby_minutes");
  const minStr = readViewValue(view, "min_players", "min_players");
  const extendPolicy = readViewValue(view, "extend_policy", "extend_policy");
  const warn1Str = readViewValue(view, "warning_1", "warning_1");
  const warn2Str = readViewValue(view, "warning_2", "warning_2");
  const autoShortenVal = readViewValue(view, "auto_shorten", "auto_shorten");
  const whisperVal = readViewValue(view, "whisper_enabled", "whisper_enabled");
  const abstainVal = readViewValue(view, "allow_abstain", "allow_abstain");
  const noKillVal = readViewValue(view, "allow_no_kill", "allow_no_kill");
  const selfSaveStr = readViewValue(view, "doctor_self_save", "doctor_self_save");

  const dayMinutes = Number(dayStr);
  const nightMinutes = Number(nightStr);
  const lobbyMinutes = Number(lobbyStr);
  const minPlayers = Number(minStr);
  const warn1 = Number(warn1Str);
  const warn2 = Number(warn2Str);
  const selfSaveLimit = Number(selfSaveStr);

  if (!Number.isFinite(dayMinutes) || dayMinutes < 1)
    errors.day_minutes = t(lang, "settings.invalid_number");
  if (!Number.isFinite(nightMinutes) || nightMinutes < 1)
    errors.night_minutes = t(lang, "settings.invalid_number");
  if (!Number.isFinite(lobbyMinutes) || lobbyMinutes < 1)
    errors.lobby_minutes = t(lang, "settings.invalid_number");
  if (!Number.isFinite(minPlayers) || minPlayers < 4)
    errors.min_players = t(lang, "settings.invalid_min_players");
  if (!Number.isFinite(warn1) || warn1 <= 0)
    errors.warning_1 = t(lang, "settings.invalid_warning");
  if (!Number.isFinite(warn2) || warn2 <= 0)
    errors.warning_2 = t(lang, "settings.invalid_warning");
  if (!Number.isFinite(selfSaveLimit) || selfSaveLimit < 0)
    errors.doctor_self_save = t(lang, "settings.invalid_self_save");

  const channelType = pref.channel_type || null;
  const isPrivate = channelType === "group";
  if (privacy === "public" && isPrivate) {
    errors.privacy = t(lang, "find.private_not_allowed");
  }
  if (channelLang !== "en" && channelLang !== "ru") {
    errors.channel_lang = t(lang, "settings.invalid_number");
  }

  if (Object.keys(errors).length > 0) {
    await ack({ response_action: "errors", errors });
    return;
  }

  await ack();

  const settings = {
    dayMinutes,
    nightMinutes,
    lobbyMinutes,
    minPlayers,
    extendPolicy: extendPolicy === "any" ? "any" : "host",
    warningsSec: [Math.floor(warn1), Math.floor(warn2)],
    autoShorten: autoShortenVal === "on",
    whisperEnabled: whisperVal === "on",
    allowAbstain: abstainVal === "on",
    allowNoKill: noKillVal === "on",
    doctorSelfSaveLimit: Math.floor(selfSaveLimit),
    channelLang: channelLang === "ru" ? "ru" : "en",
  };

  const listed = privacy === "public" && !isPrivate;
  await setChannelListing(channelId, listed, {
    channelType,
    listedBy: userId,
    settingsJson: JSON.stringify(settings),
  });

  const game = getGame(channelId);
  if (game && game.state === "lobby") {
    applyChannelSettingsToGame(game, settings);
    saveGame(game);
    schedulePhaseTimers(game);
    await postOrUpdateLobbyPanel(client, game);
    await postOrUpdateDashboard(client, game);
    saveGame(game);
  }

  const convo = await client.conversations.open({ users: userId });
  await client.chat.postMessage({
    channel: convo.channel.id,
    text: t(lang, "my_channels.saved"),
  });
});

app.action(
  /^(channel_list_public|channel_list_private)$/,
  async ({ ack, body, action, client }) => {
    await ack();
    const userId = body.user.id;
    const lang = await getUserLang(userId);
    const channelId = action?.value;
    if (!channelId) {
      await updateActionMessage(client, body, t(lang, "err.channel_unknown"));
      return;
    }

    const pref =
      (await getChannelPref(channelId)) || (await ensureChannelPref(channelId));
    const channelType = pref?.channel_type || null;
    const isPrivate = channelType === "group";
    const isPublicAction = action.action_id === ACTIONS.CHANNEL_LIST_PUBLIC;
    const isDM = body.channel?.id?.startsWith("D");
    const channel = channelMention(channelId);

    if (isPublicAction && isPrivate) {
      await setChannelListing(channelId, 0, { channelType, listedBy: userId });
      const text = isDM
        ? t(lang, "find.private_not_allowed")
        : `${t("en", "find.private_not_allowed")}\n${t(
            "ru",
            "find.private_not_allowed"
          )}`;
      await updateActionMessage(client, body, text);
      return;
    }

    const listed = isPublicAction;
    await setChannelListing(channelId, listed, { channelType, listedBy: userId });
    const text = isDM
      ? t(lang, listed ? "find.set_public" : "find.set_private", { channel })
      : `${t("en", listed ? "find.set_public" : "find.set_private", {
          channel,
        })}\n${t("ru", listed ? "find.set_public" : "find.set_private", {
          channel,
        })}`;
    await updateActionMessage(client, body, text);
  }
);

app.event("message", async ({ event, client }) => {
  if (event.channel_type === "im") return;
  if (event.subtype) {
    await handleBotAddedToChannel(client, event);
    return;
  }
  if (!event.user || event.bot_id) return;

  const channelId = event.channel;
  const game = getGame(channelId);
  if (!game || game.state === "ended") return;

  const userId = event.user;
  if (!game.players[userId]) return;
  if (isPlayerAlive(game, userId)) return;

  try {
    await client.chat.delete({
      channel: channelId,
      ts: event.ts,
    });
  } catch (err) {
    await notifyEphemeralLocalized(
      client,
      channelId,
      userId,
      "dead.message_deleted"
    );
  }
});

app.event("message", async ({ event, client }) => {
  if (event.subtype) return;
  if (event.channel_type !== "im") return;
  if (!event.text || !event.user) return;

  const text = event.text.trim();
  const args = text.split(/\s+/).filter(Boolean);
  if (args.length === 0) return;

  const command = args[0].toLowerCase();
  const userId = event.user;
  const langInfo = await getUserLangInfo(userId);
  const userLang = langInfo.lang;

  if (command === "dev") {
    if (!isDevUser(userId)) {
      await client.chat.postMessage({
        channel: event.channel,
        text: t(userLang, "dev.not_authorized"),
      });
      return;
    }
    const code = (args[1] || "").trim();
    if (!isDevCode(code)) {
      await client.chat.postMessage({
        channel: event.channel,
        text: t(userLang, "dev.code_invalid"),
      });
      return;
    }
    await sendDevPanel(client, userId);
    return;
  }

  if (command === "lang") {
    const choice = (args[1] || "").toLowerCase();
    if (!LANGS.includes(choice)) {
      await client.chat.postMessage({
        channel: event.channel,
        text: t(userLang, "dm.lang_usage"),
      });
      return;
    }
    const updated = await setUserLang(userId, choice);
    await client.chat.postMessage({
      channel: event.channel,
      text:
        updated.lang === "ru"
          ? t("ru", "dm.lang_set_ru")
          : t("en", "dm.lang_set_en"),
    });
    return;
  }

  const pendingLastWords = getLastWordsEntry(userId);
  if (pendingLastWords) {
    if (now() > pendingLastWords.expiresAt) {
      clearLastWords(userId);
      await client.chat.postMessage({
        channel: event.channel,
        text: t(userLang, "last_words.expired"),
      });
      return;
    }

    const name = await getUserLabel(client, userId);
    const pendingGame = getGame(pendingLastWords.channelId);
    if (pendingGame) {
      await announceToChannelLocalized(
        client,
        pendingGame,
        "last_words.post",
        () => ({ name, text })
      );
    } else {
      await announceToChannel(
        client,
        pendingLastWords.channelId,
        t("en", "last_words.post", { name, text })
      );
    }
    clearLastWords(userId);
    await client.chat.postMessage({
      channel: event.channel,
      text: t(userLang, "last_words.received"),
    });
    return;
  }

  if (await isMaintenanceEnabled() && !isDevUser(userId)) {
    const allowCommands = [
      "whisper",
      "vote",
      "kill",
      "save",
      "check",
      "protect",
    ];
    const hasActiveGame = [...gameCache.values()].some(
      (g) => g.players?.[userId] && (g.state === "day" || g.state === "night")
    );
    if (!allowCommands.includes(command) || !hasActiveGame) {
      await client.chat.postMessage({
        channel: event.channel,
        text: t(userLang, "maintenance.reply"),
      });
      return;
    }
  }

  if (command === "test") {
    if (!isDevUser(userId)) {
      await client.chat.postMessage({
        channel: event.channel,
        text: t(userLang, "test.not_dev"),
      });
      return;
    }
    const sub = (args[1] || "").toLowerCase();
    const channelId = extractChannelIdFromText(text);
    if (sub === "setup") {
      if (!channelId) {
        await client.chat.postMessage({
          channel: event.channel,
          text: t(userLang, "test.setup_usage"),
        });
        return;
      }
      const rest = stripChannelMentions(
        text.replace(/^test\s+setup/i, "").trim()
      );
      const names = rest
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean);
      if (names.length === 0 || names.some((name) => /\s/.test(name))) {
        await client.chat.postMessage({
          channel: event.channel,
          text: t(userLang, "test.setup_usage"),
        });
        return;
      }
      const seen = new Set();
      const dupes = [];
      names.forEach((name) => {
        const key = name.toLowerCase();
        if (seen.has(key)) dupes.push(name);
        seen.add(key);
      });
      if (dupes.length) {
        await client.chat.postMessage({
          channel: event.channel,
          text: t(userLang, "test.duplicate_names", {
            names: dupes.join(", "),
          }),
        });
        return;
      }

      let responseText = null;
      await withChannelLock(channelId, async () => {
        let game = getGame(channelId);
        let created = false;
        if (game && (game.state === "day" || game.state === "night")) {
          responseText = t(userLang, "test.active_game");
          return;
        }
        if (!game) {
          game = createLobby(channelId, userId);
          const channelSettings = await getChannelSettings(channelId);
          applyChannelSettingsToGame(game, channelSettings);
          gameCache.set(channelId, game);
          created = true;
        } else {
          normalizeGame(game);
        }
        const realPlayers = Object.values(game.players || {}).filter(
          (player) => !player?.isTest && player.id !== userId
        );
        if (realPlayers.length > 0) {
          responseText = t(userLang, "test.real_players");
          return;
        }
        Object.keys(game.players || {}).forEach((id) => {
          if (id === userId || game.players[id]?.isTest) {
            delete game.players[id];
          }
        });

        game.hostId = userId;
        game.test = { enabled: true, controllerId: userId };

        let index = 1;
        names.forEach((name) => {
          const testId = buildTestPlayerId(channelId, index);
          game.players[testId] = {
            id: testId,
            role: null,
            alive: true,
            joinedAt: now(),
            name,
            ready: false,
            isTest: true,
            controllerId: userId,
          };
          index += 1;
        });

        saveGame(game);
        if (created) schedulePhaseTimers(game);
        await postOrUpdateLobbyPanel(client, game);
        await postOrUpdateDashboard(client, game);
        saveGame(game);
        await updateHomeForUsers(client, [userId]);

        responseText = t(userLang, "test.setup_ok", {
          channel: channelMention(channelId),
          players: names.join(", "),
        });
      });

      if (responseText) {
        await client.chat.postMessage({
          channel: event.channel,
          text: responseText,
        });
      }
      return;
    }

    if (sub === "list") {
      let game = channelId ? getGame(channelId) : null;
      if (!game) {
        const candidates = listTestGamesForController(userId);
        if (candidates.length === 1) game = candidates[0];
      }
      if (!game) {
        await client.chat.postMessage({
          channel: event.channel,
          text: channelId
            ? t(userLang, "test.no_game")
            : t(userLang, "test.list_usage"),
        });
        return;
      }
      const testPlayers = listTestPlayers(game);
      const list =
        testPlayers.length > 0
          ? testPlayers.map((p) => p.name || p.id).join(", ")
          : "-";
      await client.chat.postMessage({
        channel: event.channel,
        text: t(userLang, "test.list", {
          channel: channelMention(game.channelId),
          players: list,
        }),
      });
      return;
    }

    await client.chat.postMessage({
      channel: event.channel,
      text: t(userLang, "test.setup_usage"),
    });
    return;
  }

  if (command === "as") {
    if (!isDevUser(userId)) {
      await client.chat.postMessage({
        channel: event.channel,
        text: t(userLang, "test.not_dev"),
      });
      return;
    }
    const match = text.match(/^as\s+(\S+)\s+(\S+)(?:\s+(.+))?$/i);
    if (!match) {
      await client.chat.postMessage({
        channel: event.channel,
        text: t(userLang, "test.as_usage"),
      });
      return;
    }
    const actorName = match[1];
    const actionKey = normalizeTestAction(match[2]);
    const rest = match[3] || "";
    const restClean = stripChannelMentions(rest);
    const channelId = extractChannelIdFromText(text);

    let game = channelId ? getGame(channelId) : null;
    if (!game) {
      const candidates = listTestGamesForController(userId);
      if (candidates.length === 1) game = candidates[0];
    }
    if (!game || !game.test?.enabled || game.test.controllerId !== userId) {
      await client.chat.postMessage({
        channel: event.channel,
        text: t(userLang, "test.no_game"),
      });
      return;
    }

    await withChannelLock(game.channelId, async () => {
      const current = getGame(game.channelId);
      if (!current) {
        await client.chat.postMessage({
          channel: event.channel,
          text: t(userLang, "test.no_game"),
        });
        return;
      }
      const actorId = resolveTestPlayerIdByName(current, actorName);
      if (!actorId) {
        await client.chat.postMessage({
          channel: event.channel,
          text: t(userLang, "test.actor_not_found", { name: actorName }),
        });
        return;
      }
      if (!isPlayerAlive(current, actorId)) {
        await client.chat.postMessage({
          channel: event.channel,
          text: t(userLang, "action.not_in_game"),
        });
        return;
      }

      if (actionKey === "whisper") {
        if (current.state !== "day") {
          await client.chat.postMessage({
            channel: event.channel,
            text: t(userLang, "whisper.not_day"),
          });
          return;
        }
        if (!current.config.whisperEnabled) {
          await client.chat.postMessage({
            channel: event.channel,
            text: t(userLang, "whisper.disabled"),
          });
          return;
        }
        if (current.whispersUsed[actorId] === current.round) {
          await client.chat.postMessage({
            channel: event.channel,
            text: t(userLang, "whisper.already_used"),
          });
          return;
        }
        const whisperText = restClean;
        if (!whisperText) {
          await client.chat.postMessage({
            channel: event.channel,
            text: t(userLang, "whisper.usage"),
          });
          return;
        }
        current.whispersUsed[actorId] = current.round;
        saveGame(current);
        await announceToChannelLocalized(client, current, "whisper.post", () => ({
          text: whisperText,
        }));
        await client.chat.postMessage({
          channel: event.channel,
          text: t(userLang, "whisper.sent"),
        });
        await postOrUpdateDashboard(client, current);
        return;
      }

      if (actionKey === "vote" || actionKey === "abstain") {
        if (current.state !== "day") {
          await client.chat.postMessage({
            channel: event.channel,
            text: t(userLang, "dm_cmd.day_only"),
          });
          return;
        }
        if (current.day.votes[actorId]) {
          await client.chat.postMessage({
            channel: event.channel,
            text: t(userLang, "action.already_voted"),
          });
          return;
        }
        if (actionKey === "abstain" || restClean.trim().toLowerCase() === "abstain") {
          if (!current.config.allowAbstain) {
            await client.chat.postMessage({
              channel: event.channel,
              text: t(userLang, "action.abstain_disabled"),
            });
            return;
          }
          current.day.votes[actorId] = SPECIAL_TARGETS.ABSTAIN;
          saveGame(current);
          await client.chat.postMessage({
            channel: event.channel,
            text: t(userLang, "action.vote_abstain"),
          });
        } else {
          const targetId = resolveTargetIdFromText(current, restClean);
          if (!targetId || !isPlayerAlive(current, targetId)) {
            await client.chat.postMessage({
              channel: event.channel,
              text: t(userLang, "dm_cmd.need_alive"),
            });
            return;
          }
          current.day.votes[actorId] = targetId;
          saveGame(current);
          await client.chat.postMessage({
            channel: event.channel,
            text: t(userLang, "dm_cmd.vote_recorded", {
              target: mention(targetId),
            }),
          });
        }
        if (maybeShortenPhase(current, "day")) {
          await announceToChannelLocalized(client, current, "warn.shortened_day");
          await postOrUpdateDashboard(client, current);
          saveGame(current);
        }
        if (dayReady(current)) {
          clearPhaseTimers(current.channelId);
          await resolveDay(client, current, false);
        }
        return;
      }

      if (current.state !== "night") {
        await client.chat.postMessage({
          channel: event.channel,
          text: t(userLang, "dm_cmd.night_only"),
        });
        return;
      }

      if (actionKey === "kill" || actionKey === "nokill") {
        if (actionKey === "nokill") {
          if (!isMafia(current, actorId)) {
            await client.chat.postMessage({
              channel: event.channel,
              text: t(userLang, "dm_cmd.mafia_only"),
            });
            return;
          }
          if (current.night.mafiaVotes[actorId]) {
            await client.chat.postMessage({
              channel: event.channel,
              text: t(userLang, "action.already_acted"),
            });
            return;
          }
          if (!current.config.allowNoKill) {
            await client.chat.postMessage({
              channel: event.channel,
              text: t(userLang, "action.no_kill_disabled"),
            });
            return;
          }
          current.night.mafiaVotes[actorId] = SPECIAL_TARGETS.NO_KILL;
          saveGame(current);
          await client.chat.postMessage({
            channel: event.channel,
            text: t(userLang, "action.no_kill"),
          });
        } else {
          const targetId = resolveTargetIdFromText(current, restClean);
          if (!targetId || !isPlayerAlive(current, targetId)) {
            await client.chat.postMessage({
              channel: event.channel,
              text: t(userLang, "dm_cmd.need_alive"),
            });
            return;
          }
          if (current.roles.detectiveId === actorId) {
            if (current.night.detectiveCheck || current.night.detectiveKill) {
              await client.chat.postMessage({
                channel: event.channel,
                text: t(userLang, "action.already_acted"),
              });
              return;
            }
            if (targetId === actorId) {
              await client.chat.postMessage({
                channel: event.channel,
                text: t(userLang, "dm_cmd.need_alive"),
              });
              return;
            }
            current.night.detectiveKill = targetId;
            saveGame(current);
            await client.chat.postMessage({
              channel: event.channel,
              text: t(userLang, "dm_cmd.detective_kill", {
                target: mention(targetId),
              }),
            });
          } else {
            if (!isMafia(current, actorId)) {
              await client.chat.postMessage({
                channel: event.channel,
                text: t(userLang, "dm_cmd.mafia_only"),
              });
              return;
            }
            if (current.night.mafiaVotes[actorId]) {
              await client.chat.postMessage({
                channel: event.channel,
                text: t(userLang, "action.already_acted"),
              });
              return;
            }
            if (isMafia(current, targetId)) {
              await client.chat.postMessage({
                channel: event.channel,
                text: t(userLang, "dm_cmd.no_mafia_target"),
              });
              return;
            }
            current.night.mafiaVotes[actorId] = targetId;
            saveGame(current);
            await client.chat.postMessage({
              channel: event.channel,
              text: t(userLang, "dm_cmd.choice_recorded", {
                target: mention(targetId),
              }),
            });
          }
        }
      } else if (actionKey === "save") {
        if (current.roles.doctorId !== actorId) {
          await client.chat.postMessage({
            channel: event.channel,
            text: t(userLang, "dm_cmd.doctor_only"),
          });
          return;
        }
        if (current.night.doctorSave) {
          await client.chat.postMessage({
            channel: event.channel,
            text: t(userLang, "action.already_acted"),
          });
          return;
        }
        const targetId = resolveTargetIdFromText(current, restClean);
        if (!targetId || !isPlayerAlive(current, targetId)) {
          await client.chat.postMessage({
            channel: event.channel,
            text: t(userLang, "dm_cmd.need_alive"),
          });
          return;
        }
        if (
          targetId === actorId &&
          current.doctorSelfSavesUsed >= current.config.doctorSelfSaveLimit
        ) {
          await client.chat.postMessage({
            channel: event.channel,
            text: t(userLang, "dm_cmd.doctor_self_save_limit"),
          });
          return;
        }
        current.night.doctorSave = targetId;
        if (targetId === actorId) current.doctorSelfSavesUsed += 1;
        saveGame(current);
        await client.chat.postMessage({
          channel: event.channel,
          text: t(userLang, "dm_cmd.doctor_save", {
            target: mention(targetId),
          }),
        });
      } else if (actionKey === "check") {
        if (current.roles.detectiveId !== actorId) {
          await client.chat.postMessage({
            channel: event.channel,
            text: t(userLang, "dm_cmd.detective_only"),
          });
          return;
        }
        if (current.night.detectiveCheck || current.night.detectiveKill) {
          await client.chat.postMessage({
            channel: event.channel,
            text: t(userLang, "action.already_acted"),
          });
          return;
        }
        const targetId = resolveTargetIdFromText(current, restClean);
        if (!targetId || !isPlayerAlive(current, targetId)) {
          await client.chat.postMessage({
            channel: event.channel,
            text: t(userLang, "dm_cmd.need_alive"),
          });
          return;
        }
        current.night.detectiveCheck = targetId;
        saveGame(current);
        const result = isDetectiveSeesMafia(current, targetId)
          ? t(userLang, "dm_cmd.result_mafia")
          : t(userLang, "dm_cmd.result_not_mafia");
        await client.chat.postMessage({
          channel: event.channel,
          text: t(userLang, "dm_cmd.detective_result", {
            target: mention(targetId),
            result,
          }),
        });
      } else if (actionKey === "protect") {
        const targetId = resolveTargetIdFromText(current, restClean);
        if (!targetId || !isPlayerAlive(current, targetId)) {
          await client.chat.postMessage({
            channel: event.channel,
            text: t(userLang, "dm_cmd.need_alive"),
          });
          return;
        }
        if (current.roles.bodyguardId === actorId) {
          if (current.night.bodyguardProtect) {
            await client.chat.postMessage({
              channel: event.channel,
              text: t(userLang, "action.already_acted"),
            });
            return;
          }
          current.night.bodyguardProtect = targetId;
          saveGame(current);
          await client.chat.postMessage({
            channel: event.channel,
            text: t(userLang, "dm_cmd.bodyguard_protect", {
              target: mention(targetId),
            }),
          });
        } else if (current.roles.lawyerId === actorId) {
          if (current.night.lawyerProtect) {
            await client.chat.postMessage({
              channel: event.channel,
              text: t(userLang, "action.already_acted"),
            });
            return;
          }
          current.night.lawyerProtect = targetId;
          saveGame(current);
          await client.chat.postMessage({
            channel: event.channel,
            text: t(userLang, "dm_cmd.lawyer_protect", {
              target: mention(targetId),
            }),
          });
        } else {
          await client.chat.postMessage({
            channel: event.channel,
            text: t(userLang, "dm_cmd.bodyguard_only"),
          });
          return;
        }
      } else if (actionKey === "visit") {
        if (current.roles.bumId !== actorId) {
          await client.chat.postMessage({
            channel: event.channel,
            text: t(userLang, "dm_cmd.bum_only"),
          });
          return;
        }
        if (current.night.bumVisit) {
          await client.chat.postMessage({
            channel: event.channel,
            text: t(userLang, "action.already_acted"),
          });
          return;
        }
        const targetId = resolveTargetIdFromText(current, restClean);
        if (!targetId || !isPlayerAlive(current, targetId)) {
          await client.chat.postMessage({
            channel: event.channel,
            text: t(userLang, "dm_cmd.need_alive"),
          });
          return;
        }
        current.night.bumVisit = targetId;
        saveGame(current);
        await client.chat.postMessage({
          channel: event.channel,
          text: t(userLang, "dm_cmd.bum_visit", {
            target: mention(targetId),
          }),
        });
      } else if (actionKey === "defend") {
        if (current.roles.lawyerId !== actorId) {
          await client.chat.postMessage({
            channel: event.channel,
            text: t(userLang, "dm_cmd.lawyer_only"),
          });
          return;
        }
        if (current.night.lawyerProtect) {
          await client.chat.postMessage({
            channel: event.channel,
            text: t(userLang, "action.already_acted"),
          });
          return;
        }
        const targetId = resolveTargetIdFromText(current, restClean);
        if (!targetId || !isPlayerAlive(current, targetId)) {
          await client.chat.postMessage({
            channel: event.channel,
            text: t(userLang, "dm_cmd.need_alive"),
          });
          return;
        }
        current.night.lawyerProtect = targetId;
        saveGame(current);
        await client.chat.postMessage({
          channel: event.channel,
          text: t(userLang, "dm_cmd.lawyer_protect", {
            target: mention(targetId),
          }),
        });
      } else if (actionKey === "stalk") {
        if (current.roles.stalkerId !== actorId) {
          await client.chat.postMessage({
            channel: event.channel,
            text: t(userLang, "dm_cmd.stalker_only"),
          });
          return;
        }
        if (current.night.stalkerKill) {
          await client.chat.postMessage({
            channel: event.channel,
            text: t(userLang, "action.already_acted"),
          });
          return;
        }
        const targetId = resolveTargetIdFromText(current, restClean);
        if (!targetId || !isPlayerAlive(current, targetId) || targetId === actorId) {
          await client.chat.postMessage({
            channel: event.channel,
            text: t(userLang, "dm_cmd.need_alive"),
          });
          return;
        }
        current.night.stalkerKill = targetId;
        saveGame(current);
        await client.chat.postMessage({
          channel: event.channel,
          text: t(userLang, "dm_cmd.stalker_kill", {
            target: mention(targetId),
          }),
        });
      } else {
        await client.chat.postMessage({
          channel: event.channel,
          text: t(userLang, "test.as_usage"),
        });
        return;
      }

      if (maybeShortenPhase(current, "night")) {
        await announceToChannelLocalized(client, current, "warn.shortened_night");
        await postOrUpdateDashboard(client, current);
        saveGame(current);
      }
      if (nightReady(current)) {
        clearPhaseTimers(current.channelId);
        await resolveNight(client, current, false);
      }
    });
    return;
  }

  if (!langInfo.explicit && !languagePrompted.has(userId)) {
    languagePrompted.add(userId);
    const promptText = t("en", "dm.lang_prompt");
    await client.chat.postMessage({
      channel: event.channel,
      text: promptText,
      blocks: buildLangSelectBlocks(promptText),
    });
  }

  if (command === "faq") {
    const rawId = args[1] ? String(args[1]).trim() : "";
    const faqId = rawId ? rawId.toLowerCase() : null;
    const blocks = buildFaqCommandBlocks(userLang, faqId);
    await client.chat.postMessage({
      channel: event.channel,
      text: faqId
        ? t(userLang, "faq.command_detail", { id: faqId })
        : t(userLang, "faq.command_open"),
      blocks,
    });
    return;
  }

  if (command === "mychannels" || command === "my_channels") {
    const blocks = await buildMyChannelsBlocks(client, userId, userLang, 0);
    await client.chat.postMessage({
      channel: event.channel,
      text: t(userLang, "my_channels.title"),
      blocks,
    });
    return;
  }

  const channelHintMatch = text.match(/<#([A-Z0-9]+)(?:\|[^>]+)?>/);
  const channelHint = channelHintMatch ? channelHintMatch[1] : null;
  const targetMatch = text.match(/<@([A-Z0-9]+)>/);
  const targetId = targetMatch ? targetMatch[1] : null;

  let game = null;
  if (channelHint) {
    game = getGame(channelHint);
  } else {
    const active = [...gameCache.values()].filter((g) => g.players[userId]);
    if (active.length === 1) game = active[0];
  }

  if (!game) {
    const helpText = withDevHint(t(userLang, "dm.help_intro"), userLang, userId);
    await client.chat.postMessage({
      channel: event.channel,
      text: helpText,
      blocks: buildDmHelpBlocks(userLang, helpText),
    });
    return;
  }

  await withChannelLock(game.channelId, async () => {
    if (command === "whisper") {
      if (game.state !== "day") {
        await client.chat.postMessage({
          channel: event.channel,
          text: t(userLang, "whisper.not_day"),
        });
        return;
      }
      if (!game.config.whisperEnabled) {
        await client.chat.postMessage({
          channel: event.channel,
          text: t(userLang, "whisper.disabled"),
        });
        return;
      }
      if (!isPlayerAlive(game, userId)) {
        await client.chat.postMessage({
          channel: event.channel,
          text: t(userLang, "action.not_in_game"),
        });
        return;
      }
      if (game.whispersUsed[userId] === game.round) {
        await client.chat.postMessage({
          channel: event.channel,
          text: t(userLang, "whisper.already_used"),
        });
        return;
      }

      const trimmed = text.replace(/<#([A-Z0-9]+)(?:\|[^>]+)?>/g, "");
      const whisperText = trimmed.slice(command.length).trim();
      if (!whisperText) {
        await client.chat.postMessage({
          channel: event.channel,
          text: t(userLang, "whisper.usage"),
        });
        return;
      }

      game.whispersUsed[userId] = game.round;
      saveGame(game);
      await announceToChannelLocalized(client, game, "whisper.post", () => ({
        text: whisperText,
      }));
      await client.chat.postMessage({
        channel: event.channel,
        text: t(userLang, "whisper.sent"),
      });
      await postOrUpdateDashboard(client, game);
      return;
    }

    if (command === "vote" && game.state === "day") {
      if (game.day.votes[userId]) {
        await client.chat.postMessage({
          channel: event.channel,
          text: t(userLang, "action.already_voted"),
        });
        return;
      }
      if (!targetId || !isPlayerAlive(game, targetId)) {
        await client.chat.postMessage({
          channel: event.channel,
          text: t(userLang, "dm_cmd.need_alive"),
        });
        return;
      }
      game.day.votes[userId] = targetId;
      saveGame(game);
      await client.chat.postMessage({
        channel: event.channel,
        text: t(userLang, "dm_cmd.vote_recorded", {
          target: mention(targetId),
        }),
      });
      if (maybeShortenPhase(game, "day")) {
        await announceToChannelLocalized(client, game, "warn.shortened_day");
        await postOrUpdateDashboard(client, game);
        saveGame(game);
      }
      if (dayReady(game)) {
        clearPhaseTimers(game.channelId);
        await resolveDay(client, game, false);
      }
      return;
    }

    if (game.state !== "night") {
      await client.chat.postMessage({
        channel: event.channel,
        text: t(userLang, "dm_cmd.night_only"),
      });
      return;
    }

    if (!targetId || !isPlayerAlive(game, targetId)) {
      await client.chat.postMessage({
        channel: event.channel,
        text: t(userLang, "dm_cmd.need_alive"),
      });
      return;
    }

    if (command === "kill") {
      if (game.roles.detectiveId === userId) {
        if (game.night.detectiveCheck || game.night.detectiveKill) {
          await client.chat.postMessage({
            channel: event.channel,
            text: t(userLang, "action.already_acted"),
          });
          return;
        }
        if (targetId === userId) {
          await client.chat.postMessage({
            channel: event.channel,
            text: t(userLang, "dm_cmd.need_alive"),
          });
          return;
        }
        game.night.detectiveKill = targetId;
        saveGame(game);
        await client.chat.postMessage({
          channel: event.channel,
          text: t(userLang, "dm_cmd.detective_kill", {
            target: mention(targetId),
          }),
        });
      } else {
        if (!isMafia(game, userId)) {
          await client.chat.postMessage({
            channel: event.channel,
            text: t(userLang, "dm_cmd.mafia_only"),
          });
          return;
        }
        if (game.night.mafiaVotes[userId]) {
          await client.chat.postMessage({
            channel: event.channel,
            text: t(userLang, "action.already_acted"),
          });
          return;
        }
        if (isMafia(game, targetId)) {
          await client.chat.postMessage({
            channel: event.channel,
            text: t(userLang, "dm_cmd.no_mafia_target"),
          });
          return;
        }
        game.night.mafiaVotes[userId] = targetId;
        saveGame(game);
        await client.chat.postMessage({
          channel: event.channel,
          text: t(userLang, "dm_cmd.choice_recorded", {
            target: mention(targetId),
          }),
        });
      }
    } else if (command === "save") {
      if (game.roles.doctorId !== userId) {
        await client.chat.postMessage({
          channel: event.channel,
          text: t(userLang, "dm_cmd.doctor_only"),
        });
        return;
      }
      if (game.night.doctorSave) {
        await client.chat.postMessage({
          channel: event.channel,
          text: t(userLang, "action.already_acted"),
        });
        return;
      }
      if (
        targetId === userId &&
        game.doctorSelfSavesUsed >= game.config.doctorSelfSaveLimit
      ) {
        await client.chat.postMessage({
          channel: event.channel,
          text: t(userLang, "dm_cmd.doctor_self_save_limit"),
        });
        return;
      }
      game.night.doctorSave = targetId;
      if (targetId === userId) game.doctorSelfSavesUsed += 1;
      saveGame(game);
      await client.chat.postMessage({
        channel: event.channel,
        text: t(userLang, "dm_cmd.doctor_save", {
          target: mention(targetId),
        }),
      });
    } else if (command === "check") {
      if (game.roles.detectiveId !== userId) {
        await client.chat.postMessage({
          channel: event.channel,
          text: t(userLang, "dm_cmd.detective_only"),
        });
        return;
      }
      if (game.night.detectiveCheck || game.night.detectiveKill) {
        await client.chat.postMessage({
          channel: event.channel,
          text: t(userLang, "action.already_acted"),
        });
        return;
      }
      game.night.detectiveCheck = targetId;
      saveGame(game);
      const result = isDetectiveSeesMafia(game, targetId)
        ? t(userLang, "dm_cmd.result_mafia")
        : t(userLang, "dm_cmd.result_not_mafia");
      await client.chat.postMessage({
        channel: event.channel,
        text: t(userLang, "dm_cmd.detective_result", {
          target: mention(targetId),
          result,
        }),
      });

      const sergeantId = game.roles.sergeantId;
      if (
        sergeantId &&
        sergeantId !== userId &&
        isPlayerAlive(game, sergeantId) &&
        !isTestUserId(sergeantId)
      ) {
        const serLang = await getUserLang(sergeantId);
        const serResult = isDetectiveSeesMafia(game, targetId)
          ? t(serLang, "dm_cmd.result_mafia")
          : t(serLang, "dm_cmd.result_not_mafia");
        await sendInteractiveDM(client, sergeantId, t(serLang, "sergeant.info", {
          target: mention(targetId),
          result: serResult,
        }));
      }
    } else if (command === "protect") {
      if (game.roles.bodyguardId === userId) {
        if (game.night.bodyguardProtect) {
          await client.chat.postMessage({
            channel: event.channel,
            text: t(userLang, "action.already_acted"),
          });
          return;
        }
        game.night.bodyguardProtect = targetId;
        saveGame(game);
        await client.chat.postMessage({
          channel: event.channel,
          text: t(userLang, "dm_cmd.bodyguard_protect", {
            target: mention(targetId),
          }),
        });
      } else if (game.roles.lawyerId === userId) {
        if (game.night.lawyerProtect) {
          await client.chat.postMessage({
            channel: event.channel,
            text: t(userLang, "action.already_acted"),
          });
          return;
        }
        game.night.lawyerProtect = targetId;
        saveGame(game);
        await client.chat.postMessage({
          channel: event.channel,
          text: t(userLang, "dm_cmd.lawyer_protect", {
            target: mention(targetId),
          }),
        });
      } else {
        await client.chat.postMessage({
          channel: event.channel,
          text: t(userLang, "dm_cmd.bodyguard_only"),
        });
        return;
      }
    } else if (command === "visit") {
      if (game.roles.bumId !== userId) {
        await client.chat.postMessage({
          channel: event.channel,
          text: t(userLang, "dm_cmd.bum_only"),
        });
        return;
      }
      if (game.night.bumVisit) {
        await client.chat.postMessage({
          channel: event.channel,
          text: t(userLang, "action.already_acted"),
        });
        return;
      }
      game.night.bumVisit = targetId;
      saveGame(game);
      await client.chat.postMessage({
        channel: event.channel,
        text: t(userLang, "dm_cmd.bum_visit", {
          target: mention(targetId),
        }),
      });
    } else if (command === "defend") {
      if (game.roles.lawyerId !== userId) {
        await client.chat.postMessage({
          channel: event.channel,
          text: t(userLang, "dm_cmd.lawyer_only"),
        });
        return;
      }
      if (game.night.lawyerProtect) {
        await client.chat.postMessage({
          channel: event.channel,
          text: t(userLang, "action.already_acted"),
        });
        return;
      }
      game.night.lawyerProtect = targetId;
      saveGame(game);
      await client.chat.postMessage({
        channel: event.channel,
        text: t(userLang, "dm_cmd.lawyer_protect", {
          target: mention(targetId),
        }),
      });
    } else if (command === "stalk") {
      if (game.roles.stalkerId !== userId) {
        await client.chat.postMessage({
          channel: event.channel,
          text: t(userLang, "dm_cmd.stalker_only"),
        });
        return;
      }
      if (game.night.stalkerKill) {
        await client.chat.postMessage({
          channel: event.channel,
          text: t(userLang, "action.already_acted"),
        });
        return;
      }
      if (targetId === userId) {
        await client.chat.postMessage({
          channel: event.channel,
          text: t(userLang, "dm_cmd.need_alive"),
        });
        return;
      }
      game.night.stalkerKill = targetId;
      saveGame(game);
      await client.chat.postMessage({
        channel: event.channel,
        text: t(userLang, "dm_cmd.stalker_kill", {
          target: mention(targetId),
        }),
      });
    } else {
      await client.chat.postMessage({
        channel: event.channel,
        text: t(userLang, "dm_cmd.unknown_command"),
      });
      return;
    }

    if (maybeShortenPhase(game, "night")) {
      await announceToChannelLocalized(client, game, "warn.shortened_night");
      await postOrUpdateDashboard(client, game);
      saveGame(game);
    }

    if (nightReady(game)) {
      clearPhaseTimers(game.channelId);
      await resolveNight(client, game, false);
    }
  });
});

async function replyToTelegramMessage(ctx, text, reply_markup) {
  const chatId = ctx?.chat?.id || ctx?.callbackQuery?.message?.chat?.id;
  if (!telegramBot || !chatId) return;
  const payload = {};
  if (reply_markup) payload.reply_markup = reply_markup;
  if (ctx.message?.message_id) payload.reply_to_message_id = ctx.message.message_id;
  await telegramBot.telegram.sendMessage(chatId, text, payload);
}

async function answerTelegramCallback(ctx, text, showAlert = false) {
  try {
    if (!text) {
      await ctx.answerCbQuery();
      return;
    }
    await ctx.answerCbQuery(text, { show_alert: showAlert });
  } catch (err) {
    console.error("Failed to answer Telegram callback:", err);
  }
}

async function updateTelegramActionMessage(ctx, text, reply_markup) {
  const message = ctx?.callbackQuery?.message;
  if (!message) return;
  await editTelegramMessage(message.chat.id, message.message_id, text, reply_markup);
}

async function handleTelegramDetectiveMode(ctx, data) {
  const rawChatId = data.chatId;
  const channelId = makeChannelKey(PLATFORM_TELEGRAM, rawChatId);
  const actorId = getTelegramUserKeyFromCtx(ctx);
  const actorLang = await getUserLang(actorId);

  if (!rawChatId) {
    await answerTelegramCallback(ctx, t(actorLang, "action.failed"), true);
    return;
  }

  await withChannelLock(channelId, async () => {
    const game = getGame(channelId);
    if (!game) {
      await answerTelegramCallback(ctx, t(actorLang, "action.game_ended"), true);
      return;
    }
    if (!isPlayerAlive(game, actorId)) {
      await answerTelegramCallback(ctx, t(actorLang, "action.not_in_game"), true);
      return;
    }
    if (game.state !== "night") {
      await answerTelegramCallback(ctx, t(actorLang, "action.not_night"), true);
      return;
    }
    if (game.roles.detectiveId !== actorId) {
      await answerTelegramCallback(ctx, t(actorLang, "action.detective_only"), true);
      return;
    }
    if (game.night.detectiveCheck || game.night.detectiveKill) {
      await answerTelegramCallback(ctx, t(actorLang, "action.already_acted"), true);
      return;
    }

    const nextAction =
      data.action === ACTIONS.DETECTIVE_MODE_KILL
        ? ACTIONS.DETECTIVE_KILL
        : ACTIONS.DETECTIVE_CHECK;
    const targetIds = getTargetsForAction(game, nextAction, actorId);
    if (!targetIds.length) {
      await answerTelegramCallback(ctx, t(actorLang, "action.failed"), true);
      return;
    }
    const choices = await buildUserChoices(null, targetIds);
    const text = getPromptTextForAction(actorLang, game, nextAction);
    const reply_markup = buildTelegramPlayerKeyboard({
      chatId: rawChatId,
      actionId: nextAction,
      players: choices,
      page: 0,
      pageSize: BUTTON_PAGE_SIZE,
      lang: actorLang,
    });
    await updateTelegramActionMessage(ctx, text, reply_markup);
    await answerTelegramCallback(ctx);
  });
}

async function handleTelegramPageAction(ctx, data) {
  const rawChatId = data.chatId;
  const actionType = data.target;
  const channelId = makeChannelKey(PLATFORM_TELEGRAM, rawChatId);
  const actorId = getTelegramUserKeyFromCtx(ctx);
  const actorLang = await getUserLang(actorId);

  if (!rawChatId || !actionType) {
    await answerTelegramCallback(ctx, t(actorLang, "action.failed"), true);
    return;
  }

  await withChannelLock(channelId, async () => {
    const game = getGame(channelId);
    if (!game) {
      await answerTelegramCallback(ctx, t(actorLang, "action.game_ended"), true);
      return;
    }
    if (!isPlayerAlive(game, actorId)) {
      await answerTelegramCallback(ctx, t(actorLang, "action.not_in_game"), true);
      return;
    }

    if (actionType === ACTIONS.DAY_VOTE) {
      if (game.state !== "day") {
        await answerTelegramCallback(ctx, t(actorLang, "action.not_day"), true);
        return;
      }
      if (game.day.votes[actorId]) {
        await answerTelegramCallback(ctx, t(actorLang, "action.already_voted"), true);
        return;
      }
    } else {
      if (game.state !== "night") {
        await answerTelegramCallback(ctx, t(actorLang, "action.not_night"), true);
        return;
      }
      if (actionType === ACTIONS.MAFIA_VOTE && !isMafia(game, actorId)) {
        await answerTelegramCallback(ctx, t(actorLang, "action.mafia_only"), true);
        return;
      }
      if (actionType === ACTIONS.DOCTOR_SAVE && game.roles.doctorId !== actorId) {
        await answerTelegramCallback(ctx, t(actorLang, "action.doctor_only"), true);
        return;
      }
      if (
        (actionType === ACTIONS.DETECTIVE_CHECK ||
          actionType === ACTIONS.DETECTIVE_KILL) &&
        game.roles.detectiveId !== actorId
      ) {
        await answerTelegramCallback(ctx, t(actorLang, "action.detective_only"), true);
        return;
      }
      if (actionType === ACTIONS.BODYGUARD_PROTECT && game.roles.bodyguardId !== actorId) {
        await answerTelegramCallback(ctx, t(actorLang, "action.bodyguard_only"), true);
        return;
      }
      if (actionType === ACTIONS.BUM_VISIT && game.roles.bumId !== actorId) {
        await answerTelegramCallback(ctx, t(actorLang, "action.bum_only"), true);
        return;
      }
      if (actionType === ACTIONS.LAWYER_PROTECT && game.roles.lawyerId !== actorId) {
        await answerTelegramCallback(ctx, t(actorLang, "action.lawyer_only"), true);
        return;
      }
      if (actionType === ACTIONS.STALKER_KILL && game.roles.stalkerId !== actorId) {
        await answerTelegramCallback(ctx, t(actorLang, "action.stalker_only"), true);
        return;
      }

      if (actionType === ACTIONS.MAFIA_VOTE && game.night.mafiaVotes[actorId]) {
        await answerTelegramCallback(ctx, t(actorLang, "action.already_acted"), true);
        return;
      }
      if (actionType === ACTIONS.DOCTOR_SAVE && game.night.doctorSave) {
        await answerTelegramCallback(ctx, t(actorLang, "action.already_acted"), true);
        return;
      }
      if (
        (actionType === ACTIONS.DETECTIVE_CHECK ||
          actionType === ACTIONS.DETECTIVE_KILL) &&
        (game.night.detectiveCheck || game.night.detectiveKill)
      ) {
        await answerTelegramCallback(ctx, t(actorLang, "action.already_acted"), true);
        return;
      }
      if (actionType === ACTIONS.BODYGUARD_PROTECT && game.night.bodyguardProtect) {
        await answerTelegramCallback(ctx, t(actorLang, "action.already_acted"), true);
        return;
      }
      if (actionType === ACTIONS.BUM_VISIT && game.night.bumVisit) {
        await answerTelegramCallback(ctx, t(actorLang, "action.already_acted"), true);
        return;
      }
      if (actionType === ACTIONS.LAWYER_PROTECT && game.night.lawyerProtect) {
        await answerTelegramCallback(ctx, t(actorLang, "action.already_acted"), true);
        return;
      }
      if (actionType === ACTIONS.STALKER_KILL && game.night.stalkerKill) {
        await answerTelegramCallback(ctx, t(actorLang, "action.already_acted"), true);
        return;
      }
    }

    const targetIds = getTargetsForAction(game, actionType, actorId);
    if (!targetIds.length) {
      await answerTelegramCallback(ctx, t(actorLang, "action.failed"), true);
      return;
    }
    const choices = await buildUserChoices(null, targetIds);
    const totalPages = Math.max(1, Math.ceil(choices.length / BUTTON_PAGE_SIZE));
    const direction = data.action === ACTIONS.PAGE_NEXT ? 1 : -1;
    const newPage = Math.max(0, Math.min(totalPages - 1, data.page + direction));
    const text = getPromptTextForAction(actorLang, game, actionType);
    const extraButtons = [];
    if (actionType === ACTIONS.DAY_VOTE && game.config.allowAbstain) {
      extraButtons.push({
        text: t(actorLang, "button.abstain"),
        value: SPECIAL_TARGETS.ABSTAIN,
        actionId: ACTIONS.DAY_VOTE,
      });
    }
    if (actionType === ACTIONS.MAFIA_VOTE && game.config.allowNoKill) {
      extraButtons.push({
        text: t(actorLang, "button.no_kill"),
        value: SPECIAL_TARGETS.NO_KILL,
        actionId: ACTIONS.MAFIA_VOTE,
      });
    }
    const reply_markup = buildTelegramPlayerKeyboard({
      chatId: rawChatId,
      actionId: actionType,
      players: choices,
      page: newPage,
      pageSize: BUTTON_PAGE_SIZE,
      lang: actorLang,
      extraButtons,
    });
    await updateTelegramActionMessage(ctx, text, reply_markup);
    await answerTelegramCallback(ctx);
  });
}

async function handleTelegramPlayerAction(ctx, data) {
  const rawChatId = data.chatId;
  const channelId = makeChannelKey(PLATFORM_TELEGRAM, rawChatId);
  const actorId = getTelegramUserKeyFromCtx(ctx);
  const actorLang = await getUserLang(actorId);
  const targetId = data.target;

  if (!rawChatId || !targetId) {
    await answerTelegramCallback(ctx, t(actorLang, "action.failed"), true);
    return;
  }

  await withChannelLock(channelId, async () => {
    const game = getGame(channelId);
    if (!game) {
      await answerTelegramCallback(ctx, t(actorLang, "action.game_ended"), true);
      return;
    }
    if (!isPlayerAlive(game, actorId)) {
      await answerTelegramCallback(ctx, t(actorLang, "action.not_in_game"), true);
      return;
    }

    if (data.action === ACTIONS.DAY_VOTE) {
      if (game.state !== "day") {
        await answerTelegramCallback(ctx, t(actorLang, "action.not_day"), true);
        return;
      }
      if (game.day.votes[actorId]) {
        await answerTelegramCallback(ctx, t(actorLang, "action.already_voted"), true);
        return;
      }
      if (targetId === SPECIAL_TARGETS.ABSTAIN && !game.config.allowAbstain) {
        await answerTelegramCallback(ctx, t(actorLang, "action.abstain_disabled"), true);
        return;
      }
      if (targetId !== SPECIAL_TARGETS.ABSTAIN && !isPlayerAlive(game, targetId)) {
        await answerTelegramCallback(ctx, t(actorLang, "action.choose_alive"), true);
        return;
      }
      game.day.votes[actorId] = targetId;
      saveGame(game);
      const text =
        targetId === SPECIAL_TARGETS.ABSTAIN
          ? t(actorLang, "action.vote_abstain")
          : t(actorLang, "action.vote_recorded", { target: mention(targetId) });
      await updateTelegramActionMessage(ctx, text, undefined);

      if (maybeShortenPhase(game, "day")) {
        await announceToChannelLocalized(null, game, "warn.shortened_day");
        await postOrUpdateDashboard(null, game);
        saveGame(game);
      }

      if (dayReady(game)) {
        clearPhaseTimers(channelId);
        await resolveDay(null, game, false);
      }
      await answerTelegramCallback(ctx);
      return;
    }

    if (game.state !== "night") {
      await answerTelegramCallback(ctx, t(actorLang, "action.not_night"), true);
      return;
    }

    if (data.action === ACTIONS.MAFIA_VOTE) {
      if (!isMafia(game, actorId)) {
        await answerTelegramCallback(ctx, t(actorLang, "action.mafia_only"), true);
        return;
      }
      if (game.night.mafiaVotes[actorId]) {
        await answerTelegramCallback(ctx, t(actorLang, "action.already_acted"), true);
        return;
      }
      if (targetId === SPECIAL_TARGETS.NO_KILL && !game.config.allowNoKill) {
        await answerTelegramCallback(ctx, t(actorLang, "action.no_kill_disabled"), true);
        return;
      }
      if (targetId !== SPECIAL_TARGETS.NO_KILL) {
        if (!isPlayerAlive(game, targetId)) {
          await answerTelegramCallback(ctx, t(actorLang, "action.choose_alive"), true);
          return;
        }
        if (isMafia(game, targetId)) {
          await answerTelegramCallback(ctx, t(actorLang, "action.no_mafia_target"), true);
          return;
        }
      }
      game.night.mafiaVotes[actorId] = targetId;
      saveGame(game);
      const text =
        targetId === SPECIAL_TARGETS.NO_KILL
          ? t(actorLang, "action.no_kill")
          : t(actorLang, "action.choice_recorded", { target: mention(targetId) });
      await updateTelegramActionMessage(ctx, text, undefined);
    }

    if (data.action === ACTIONS.DOCTOR_SAVE) {
      if (game.roles.doctorId !== actorId) {
        await answerTelegramCallback(ctx, t(actorLang, "action.doctor_only"), true);
        return;
      }
      if (game.night.doctorSave) {
        await answerTelegramCallback(ctx, t(actorLang, "action.already_acted"), true);
        return;
      }
      if (!isPlayerAlive(game, targetId)) {
        await answerTelegramCallback(ctx, t(actorLang, "action.choose_alive"), true);
        return;
      }
      if (
        targetId === actorId &&
        game.doctorSelfSavesUsed >= game.config.doctorSelfSaveLimit
      ) {
        await answerTelegramCallback(ctx, t(actorLang, "action.doctor_self_save_limit"), true);
        return;
      }
      game.night.doctorSave = targetId;
      if (targetId === actorId) game.doctorSelfSavesUsed += 1;
      saveGame(game);
      await updateTelegramActionMessage(
        ctx,
        t(actorLang, "action.doctor_save", { target: mention(targetId) }),
        undefined
      );
    }

    if (data.action === ACTIONS.DETECTIVE_CHECK) {
      if (game.roles.detectiveId !== actorId) {
        await answerTelegramCallback(ctx, t(actorLang, "action.detective_only"), true);
        return;
      }
      if (game.night.detectiveCheck || game.night.detectiveKill) {
        await answerTelegramCallback(ctx, t(actorLang, "action.already_acted"), true);
        return;
      }
      if (!isPlayerAlive(game, targetId)) {
        await answerTelegramCallback(ctx, t(actorLang, "action.choose_alive"), true);
        return;
      }
      game.night.detectiveCheck = targetId;
      saveGame(game);
      await updateTelegramActionMessage(
        ctx,
        t(actorLang, "action.detective_check", { target: mention(targetId) }),
        undefined
      );

      const result = isDetectiveSeesMafia(game, targetId)
        ? t(actorLang, "action.result_mafia")
        : t(actorLang, "action.result_not_mafia");
      await sendInteractiveDM(null, actorId, t(actorLang, "action.detective_result", {
        target: mention(targetId),
        result,
      }));

      const sergeantId = game.roles.sergeantId;
      if (
        sergeantId &&
        sergeantId !== actorId &&
        isPlayerAlive(game, sergeantId) &&
        !isTestUserId(sergeantId)
      ) {
        const serLang = await getUserLang(sergeantId);
        const serResult = isDetectiveSeesMafia(game, targetId)
          ? t(serLang, "action.result_mafia")
          : t(serLang, "action.result_not_mafia");
        await sendInteractiveDM(null, sergeantId, t(serLang, "sergeant.info", {
          target: mention(targetId),
          result: serResult,
        }));
      }
    }

    if (data.action === ACTIONS.DETECTIVE_KILL) {
      if (game.roles.detectiveId !== actorId) {
        await answerTelegramCallback(ctx, t(actorLang, "action.detective_only"), true);
        return;
      }
      if (game.night.detectiveCheck || game.night.detectiveKill) {
        await answerTelegramCallback(ctx, t(actorLang, "action.already_acted"), true);
        return;
      }
      if (!isPlayerAlive(game, targetId) || targetId === actorId) {
        await answerTelegramCallback(ctx, t(actorLang, "action.choose_alive"), true);
        return;
      }
      game.night.detectiveKill = targetId;
      saveGame(game);
      await updateTelegramActionMessage(
        ctx,
        t(actorLang, "action.detective_kill", { target: mention(targetId) }),
        undefined
      );
    }

    if (data.action === ACTIONS.BODYGUARD_PROTECT) {
      if (game.roles.bodyguardId !== actorId) {
        await answerTelegramCallback(ctx, t(actorLang, "action.bodyguard_only"), true);
        return;
      }
      if (game.night.bodyguardProtect) {
        await answerTelegramCallback(ctx, t(actorLang, "action.already_acted"), true);
        return;
      }
      if (!isPlayerAlive(game, targetId)) {
        await answerTelegramCallback(ctx, t(actorLang, "action.choose_alive"), true);
        return;
      }
      game.night.bodyguardProtect = targetId;
      saveGame(game);
      await updateTelegramActionMessage(
        ctx,
        t(actorLang, "action.bodyguard_protect", { target: mention(targetId) }),
        undefined
      );
    }

    if (data.action === ACTIONS.BUM_VISIT) {
      if (game.roles.bumId !== actorId) {
        await answerTelegramCallback(ctx, t(actorLang, "action.bum_only"), true);
        return;
      }
      if (game.night.bumVisit) {
        await answerTelegramCallback(ctx, t(actorLang, "action.already_acted"), true);
        return;
      }
      if (!isPlayerAlive(game, targetId)) {
        await answerTelegramCallback(ctx, t(actorLang, "action.choose_alive"), true);
        return;
      }
      game.night.bumVisit = targetId;
      saveGame(game);
      await updateTelegramActionMessage(
        ctx,
        t(actorLang, "action.bum_visit", { target: mention(targetId) }),
        undefined
      );
    }

    if (data.action === ACTIONS.LAWYER_PROTECT) {
      if (game.roles.lawyerId !== actorId) {
        await answerTelegramCallback(ctx, t(actorLang, "action.lawyer_only"), true);
        return;
      }
      if (game.night.lawyerProtect) {
        await answerTelegramCallback(ctx, t(actorLang, "action.already_acted"), true);
        return;
      }
      if (!isPlayerAlive(game, targetId)) {
        await answerTelegramCallback(ctx, t(actorLang, "action.choose_alive"), true);
        return;
      }
      game.night.lawyerProtect = targetId;
      saveGame(game);
      await updateTelegramActionMessage(
        ctx,
        t(actorLang, "action.lawyer_protect", { target: mention(targetId) }),
        undefined
      );
    }

    if (data.action === ACTIONS.STALKER_KILL) {
      if (game.roles.stalkerId !== actorId) {
        await answerTelegramCallback(ctx, t(actorLang, "action.stalker_only"), true);
        return;
      }
      if (game.night.stalkerKill) {
        await answerTelegramCallback(ctx, t(actorLang, "action.already_acted"), true);
        return;
      }
      if (!isPlayerAlive(game, targetId) || targetId === actorId) {
        await answerTelegramCallback(ctx, t(actorLang, "action.choose_alive"), true);
        return;
      }
      game.night.stalkerKill = targetId;
      saveGame(game);
      await updateTelegramActionMessage(
        ctx,
        t(actorLang, "action.stalker_kill", { target: mention(targetId) }),
        undefined
      );
    }

    if (maybeShortenPhase(game, "night")) {
      await announceToChannelLocalized(null, game, "warn.shortened_night");
      await postOrUpdateDashboard(null, game);
      saveGame(game);
    }

    if (nightReady(game)) {
      clearPhaseTimers(channelId);
      await resolveNight(null, game, false);
    }
    await answerTelegramCallback(ctx);
  });
}

async function handleTelegramLobbyAction(ctx, data) {
  const rawChatId = data.chatId || ctx?.chat?.id;
  const channelId = makeChannelKey(PLATFORM_TELEGRAM, rawChatId);
  const userId = getTelegramUserKeyFromCtx(ctx);
  const lang = await getUserLang(userId);

  if (!rawChatId) {
    await answerTelegramCallback(ctx, t(lang, "err.channel_unknown"), true);
    return;
  }

  if (await isMaintenanceEnabled() && !isDevUser(userId)) {
    await answerTelegramCallback(ctx, t(lang, "maintenance.blocked"), true);
    return;
  }

  await withChannelLock(channelId, async () => {
    const game = getGame(channelId);
    if (!game || game.state !== "lobby") {
      await answerTelegramCallback(ctx, t(lang, "err.lobby_not_active"), true);
      return;
    }

    if (data.action === ACTIONS.LOBBY_JOIN) {
      const blocking = findBlockingGame(userId, channelId);
      if (blocking) {
        await answerTelegramCallback(
          ctx,
          t(lang, "err.already_in_other", { channel: channelMention(blocking.channelId) }),
          true
        );
        return;
      }
      if (game.players[userId]) {
        await answerTelegramCallback(ctx, t(lang, "err.already_in"), true);
        return;
      }
      game.players[userId] = {
        id: userId,
        role: null,
        alive: true,
        joinedAt: now(),
        name: tgUserCache.get(userId)?.label || null,
        ready: false,
      };
      saveGame(game);
      await announceToChannelLocalized(null, game, "lobby.joined", async (l) => ({
        user: await getNameOrMention(null, game, userId, l),
        count: Object.keys(game.players).length,
      }));
      await postOrUpdateLobbyPanel(null, game);
      await postOrUpdateDashboard(null, game);
      saveGame(game);
      await updateHomeForGame(null, game);
      await answerTelegramCallback(ctx);
      return;
    }

    if (data.action === ACTIONS.LOBBY_LEAVE) {
      if (!game.players[userId]) {
        await answerTelegramCallback(ctx, t(lang, "err.not_in_lobby"), true);
        return;
      }
      delete game.players[userId];
      if (game.hostId === userId) {
        const remaining = Object.values(game.players).sort(
          (a, b) => a.joinedAt - b.joinedAt
        );
        game.hostId = remaining[0]?.id || null;
      }
      if (!game.hostId) {
        await closeLobby(null, game, { key: "lobby.empty_closed" });
        await answerTelegramCallback(ctx);
        return;
      }
      saveGame(game);
      await announceToChannelLocalized(null, game, "lobby.left", async (l) => ({
        user: await getNameOrMention(null, game, userId, l),
        count: Object.keys(game.players).length,
      }));
      await postOrUpdateLobbyPanel(null, game);
      await postOrUpdateDashboard(null, game);
      saveGame(game);
      await updateHomeForGame(null, game);
      await answerTelegramCallback(ctx);
      return;
    }

    if (data.action === ACTIONS.LOBBY_START) {
      if (game.hostId !== userId) {
        await answerTelegramCallback(ctx, t(lang, "err.only_host_start"), true);
        return;
      }
      if (Object.keys(game.players).length < game.config.minPlayers) {
        await answerTelegramCallback(
          ctx,
          t(lang, "err.need_min_players", { min: game.config.minPlayers }),
          true
        );
        return;
      }
      await startGameFromLobby(null, game, { key: "lobby.host_start" });
      await answerTelegramCallback(ctx);
      return;
    }

    if (data.action === ACTIONS.LOBBY_READY) {
      if (!game.players[userId]) {
        await answerTelegramCallback(ctx, t(lang, "err.not_in_lobby"), true);
        return;
      }
      game.players[userId].ready = !game.players[userId].ready;
      saveGame(game);
      await postOrUpdateLobbyPanel(null, game);
      await postOrUpdateDashboard(null, game);
      saveGame(game);
      await updateHomeForGame(null, game);
      if (
        Object.keys(game.players).length >= game.config.minPlayers &&
        allPlayersReady(game)
      ) {
        await startGameFromLobby(null, game, { key: "lobby.ready_start" });
      }
      await answerTelegramCallback(ctx);
      return;
    }

    if (data.action === ACTIONS.LOBBY_EXTEND) {
      if (!canExtendLobby(game, userId)) {
        await answerTelegramCallback(ctx, t(lang, "err.extend_not_allowed"), true);
        return;
      }
      const minutes = DEFAULTS.LOBBY_EXTEND_MINUTES;
      game.phaseDeadline =
        Math.max(now(), game.phaseDeadline || now()) + toMs(minutes);
      schedulePhaseTimers(game);
      saveGame(game);
      await announceToChannelLocalized(null, game, "lobby.extended", () => ({
        minutes,
      }));
      await postOrUpdateLobbyPanel(null, game);
      await postOrUpdateDashboard(null, game);
      saveGame(game);
      await updateHomeForGame(null, game);
      await answerTelegramCallback(ctx);
      return;
    }

    if (data.action === ACTIONS.LOBBY_END) {
      if (game.hostId !== userId) {
        await answerTelegramCallback(ctx, t(lang, "err.only_host_end"), true);
        return;
      }
      await closeLobby(null, game, { key: "lobby.end" });
      await answerTelegramCallback(ctx);
    }
  });
}

async function handleTelegramChannelListingAction(ctx, data) {
  const rawChatId = data.chatId;
  const channelId = makeChannelKey(PLATFORM_TELEGRAM, rawChatId);
  const userId = getTelegramUserKeyFromCtx(ctx);
  const lang = await getUserLang(userId);
  const pref =
    (await getChannelPref(channelId)) || (await ensureChannelPref(channelId));

  if (!rawChatId) {
    await answerTelegramCallback(ctx, t(lang, "err.channel_unknown"), true);
    return;
  }

  const isPublicAction = data.action === ACTIONS.CHANNEL_LIST_PUBLIC;
  const chatInfo = tgChatCache.get(channelId);
  const isPublicChat = Boolean(chatInfo?.username);
  if (isPublicAction && !isPublicChat) {
    await updateTelegramActionMessage(ctx, t(lang, "find.private_not_allowed"));
    await setChannelListing(channelId, 0, {
      channelType: pref?.channel_type || chatInfo?.type || null,
      listedBy: userId,
    });
    await answerTelegramCallback(ctx);
    return;
  }

  await setChannelListing(channelId, isPublicAction, {
    channelType: pref?.channel_type || chatInfo?.type || null,
    listedBy: userId,
  });

  const channel = channelMention(channelId);
  const text = t(lang, isPublicAction ? "find.set_public" : "find.set_private", {
    channel,
  });
  await updateTelegramActionMessage(ctx, text);
  await answerTelegramCallback(ctx);
}

async function handleTelegramChannelLangAction(ctx, data) {
  const rawChatId = data.chatId;
  const channelId = makeChannelKey(PLATFORM_TELEGRAM, rawChatId);
  const userId = getTelegramUserKeyFromCtx(ctx);
  const lang = await getUserLang(userId);
  const pref = await getChannelPref(channelId);

  if (!pref || pref.listed_by !== userId) {
    await answerTelegramCallback(ctx, t(lang, "my_channels.not_owner"), true);
    return;
  }

  const newLang = data.action === ACTIONS.CHANNEL_LANG_RU ? "ru" : "en";
  const settings = {
    ...(await getChannelSettings(channelId)),
    channelLang: newLang,
  };
  await setChannelSettings(channelId, settings, { listedBy: pref.listed_by });

  const game = getGame(channelId);
  if (game && game.state === "lobby") {
    applyChannelSettingsToGame(game, settings);
    saveGame(game);
    await postOrUpdateLobbyPanel(null, game);
    await postOrUpdateDashboard(null, game);
    saveGame(game);
  }

  const { text, reply_markup } = await buildTelegramChannelEditMessage(channelId, lang);
  await updateTelegramActionMessage(ctx, text, reply_markup);
  await answerTelegramCallback(ctx);
}

async function handleTelegramMyChannelsAction(ctx, data) {
  const userId = getTelegramUserKeyFromCtx(ctx);
  const lang = await getUserLang(userId);
  const page = data.page || 0;

  if (data.action === ACTIONS.MY_CHANNELS_OPEN) {
    const message = await buildTelegramMyChannelsMessage(userId, lang, 0);
    await updateTelegramActionMessage(ctx, message.text, message.reply_markup);
    await answerTelegramCallback(ctx);
    return;
  }

  if (data.action === ACTIONS.MY_CHANNELS_PAGE_PREV || data.action === ACTIONS.MY_CHANNELS_PAGE_NEXT) {
    const delta = data.action === ACTIONS.MY_CHANNELS_PAGE_NEXT ? 1 : -1;
    const message = await buildTelegramMyChannelsMessage(userId, lang, page + delta);
    await updateTelegramActionMessage(ctx, message.text, message.reply_markup);
    await answerTelegramCallback(ctx);
    return;
  }

  if (data.action === ACTIONS.CHANNEL_EDIT_OPEN) {
    const channelId = makeChannelKey(PLATFORM_TELEGRAM, data.chatId);
    const pref = await getChannelPref(channelId);
    if (!pref || pref.listed_by !== userId) {
      await answerTelegramCallback(ctx, t(lang, "my_channels.not_owner"), true);
      return;
    }
    const { text, reply_markup } = await buildTelegramChannelEditMessage(channelId, lang);
    await updateTelegramActionMessage(ctx, text, reply_markup);
    await answerTelegramCallback(ctx);
  }
}

async function handleTelegramFindGamesAction(ctx, data) {
  const userId = getTelegramUserKeyFromCtx(ctx);
  const lang = await getUserLang(userId);
  const currentFilter = data.chatId || "recruiting";
  const currentLang = data.target || "all";
  let filter = currentFilter;
  let langFilter = currentLang;
  let page = data.page || 0;

  if (data.action === ACTIONS.FIND_FILTER_ACTIVE) {
    filter = "active";
    page = 0;
  } else if (data.action === ACTIONS.FIND_FILTER_RECRUITING) {
    filter = "recruiting";
    page = 0;
  } else if (data.action === ACTIONS.FIND_FILTER_INACTIVE) {
    filter = "inactive";
    page = 0;
  } else if (data.action === ACTIONS.FIND_LANG_ALL) {
    langFilter = "all";
    page = 0;
  } else if (data.action === ACTIONS.FIND_LANG_EN) {
    langFilter = "en";
    page = 0;
  } else if (data.action === ACTIONS.FIND_LANG_RU) {
    langFilter = "ru";
    page = 0;
  } else if (data.action === ACTIONS.FIND_PAGE_PREV) {
    page = Math.max(0, page - 1);
  } else if (data.action === ACTIONS.FIND_PAGE_NEXT) {
    page += 1;
  }

  const message = await buildTelegramFindGamesMessage(lang, filter, page, langFilter);
  await updateTelegramActionMessage(ctx, message.text, message.reply_markup);
  await answerTelegramCallback(ctx);
}

async function handleTelegramFaqAction(ctx, data) {
  const userId = getTelegramUserKeyFromCtx(ctx);
  const lang = await getUserLang(userId);
  const page = data.page || 0;

  if (data.action === ACTIONS.FAQ_OPEN) {
    const message = buildTelegramFaqList(lang, page);
    await updateTelegramActionMessage(ctx, message.text, message.reply_markup);
    await answerTelegramCallback(ctx);
    return;
  }

  if (data.action === ACTIONS.FAQ_PAGE_PREV || data.action === ACTIONS.FAQ_PAGE_NEXT) {
    const delta = data.action === ACTIONS.FAQ_PAGE_NEXT ? 1 : -1;
    const message = buildTelegramFaqList(lang, page + delta);
    await updateTelegramActionMessage(ctx, message.text, message.reply_markup);
    await answerTelegramCallback(ctx);
    return;
  }

  if (data.action === ACTIONS.FAQ_TOPIC) {
    const message = buildTelegramFaqDetail(lang, data.chatId, page);
    await updateTelegramActionMessage(ctx, message.text, message.reply_markup);
    await answerTelegramCallback(ctx);
    return;
  }

  if (data.action === ACTIONS.FAQ_BACK) {
    const message = buildTelegramFaqList(lang, page);
    await updateTelegramActionMessage(ctx, message.text, message.reply_markup);
    await answerTelegramCallback(ctx);
  }
}

async function handleTelegramHelpAction(ctx, data) {
  const userId = getTelegramUserKeyFromCtx(ctx);
  const lang = await getUserLang(userId);
  let text = t(lang, "dm.help_intro_tg");
  if (data.action === ACTIONS.DM_HELP_ADD) text = t(lang, "dm.help_add_tg");
  if (data.action === ACTIONS.DM_HELP_COMMANDS)
    text = t(lang, "dm.help_commands_tg");
  if (data.action === ACTIONS.DM_HELP_SETTINGS)
    text = t(lang, "dm.help_settings_tg");
  text = withDevHint(text, lang, userId);

  const reply_markup = buildTelegramDmHelpKeyboard(lang);
  await updateTelegramActionMessage(ctx, text, reply_markup);
  await answerTelegramCallback(ctx);
}

async function handleTelegramRoleHelpAction(ctx, data) {
  const userId = getTelegramUserKeyFromCtx(ctx);
  const lang = await getUserLang(userId);
  const role = data.chatId;
  const helpKey = `role_help.${role}`;
  const helpText = t(lang, helpKey) || t(lang, "role_help.town");

  let channel = "-";
  const game = getUserCurrentGame(userId);
  if (game) channel = channelMention(game.channelId);

  const text = `${t(lang, "action.role_dm", {
    channel,
    role: roleLabel(role, lang),
  })}\n\n${helpText}`;

  await updateTelegramActionMessage(ctx, text, undefined);
  await answerTelegramCallback(ctx);
}

async function handleTelegramLangSelect(ctx, data) {
  const userId = getTelegramUserKeyFromCtx(ctx);
  const choice = data.action === ACTIONS.LANG_SELECT_RU ? "ru" : "en";
  const updated = await setUserLang(userId, choice);
  const text =
    updated.lang === "ru" ? t("ru", "dm.lang_set_ru") : t("en", "dm.lang_set_en");
  await updateTelegramActionMessage(ctx, text, undefined);
  await answerTelegramCallback(ctx);
}

async function handleTelegramDevToggle(ctx) {
  const userId = getTelegramUserKeyFromCtx(ctx);
  const lang = await getUserLang(userId);

  if (!isDevUser(userId)) {
    await answerTelegramCallback(ctx, t(lang, "dev.not_authorized"), true);
    return;
  }

  const state = await getMaintenanceState();
  const enabled = !state.enabled;
  await setMaintenanceState({
    enabled,
    by: userId,
    requested_at: now(),
    notified: enabled ? false : state.notified,
  });

  if (enabled) {
    await closeAllLobbiesForMaintenance(null);
  }

  await maybeNotifyMaintenanceDone(null);

  const status = enabled
    ? t(lang, "dev.panel.status_on")
    : t(lang, "dev.panel.status_off");
  const buttonText = enabled
    ? t(lang, "dev.panel.button_disable")
    : t(lang, "dev.panel.button_enable");
  const reply_markup = Markup.inlineKeyboard([
    [Markup.button.callback(buttonText, buildTelegramCallback(ACTIONS.DEV_MAINT_TOGGLE, ""))],
  ]).reply_markup;
  await updateTelegramActionMessage(ctx, `${t(lang, "dev.panel.title")}\n${status}`, reply_markup);
  await answerTelegramCallback(ctx);
}

async function handleTelegramCallback(ctx) {
  const data = parseTelegramCallback(ctx?.callbackQuery?.data);
  if (!data) {
    await answerTelegramCallback(ctx);
    return;
  }

  if (data.action === "noop") {
    await answerTelegramCallback(ctx);
    return;
  }

  if (data.action === ACTIONS.ROLE_HELP) {
    await handleTelegramRoleHelpAction(ctx, data);
    return;
  }

  if (data.action === ACTIONS.LANG_SELECT_EN || data.action === ACTIONS.LANG_SELECT_RU) {
    await handleTelegramLangSelect(ctx, data);
    return;
  }

  if (data.action === ACTIONS.DEV_MAINT_TOGGLE) {
    await handleTelegramDevToggle(ctx);
    return;
  }

  if (data.action === ACTIONS.DETECTIVE_MODE_CHECK || data.action === ACTIONS.DETECTIVE_MODE_KILL) {
    await handleTelegramDetectiveMode(ctx, data);
    return;
  }

  if (data.action === ACTIONS.PAGE_PREV || data.action === ACTIONS.PAGE_NEXT) {
    await handleTelegramPageAction(ctx, data);
    return;
  }

  if (
    data.action === ACTIONS.DAY_VOTE ||
    data.action === ACTIONS.MAFIA_VOTE ||
    data.action === ACTIONS.DOCTOR_SAVE ||
    data.action === ACTIONS.DETECTIVE_CHECK ||
    data.action === ACTIONS.DETECTIVE_KILL ||
    data.action === ACTIONS.BODYGUARD_PROTECT ||
    data.action === ACTIONS.BUM_VISIT ||
    data.action === ACTIONS.LAWYER_PROTECT ||
    data.action === ACTIONS.STALKER_KILL
  ) {
    await handleTelegramPlayerAction(ctx, data);
    return;
  }

  if (
    data.action === ACTIONS.LOBBY_JOIN ||
    data.action === ACTIONS.LOBBY_LEAVE ||
    data.action === ACTIONS.LOBBY_START ||
    data.action === ACTIONS.LOBBY_EXTEND ||
    data.action === ACTIONS.LOBBY_END ||
    data.action === ACTIONS.LOBBY_READY
  ) {
    await handleTelegramLobbyAction(ctx, data);
    return;
  }

  if (
    data.action === ACTIONS.CHANNEL_LIST_PUBLIC ||
    data.action === ACTIONS.CHANNEL_LIST_PRIVATE
  ) {
    await handleTelegramChannelListingAction(ctx, data);
    return;
  }

  if (
    data.action === ACTIONS.CHANNEL_LANG_EN ||
    data.action === ACTIONS.CHANNEL_LANG_RU
  ) {
    await handleTelegramChannelLangAction(ctx, data);
    return;
  }

  if (data.action === ACTIONS.MY_CHANNELS_OPEN) {
    if (data.chatId === "list") {
      await handleTelegramMyChannelsAction(ctx, data);
      return;
    }
    const userId = getTelegramUserKeyFromCtx(ctx);
    const lang = await getUserLang(userId);
    const message = await buildTelegramMyChannelsMessage(userId, lang, 0);
    await replyToTelegramMessage(ctx, message.text, message.reply_markup);
    await answerTelegramCallback(ctx);
    return;
  }

  if (
    data.action === ACTIONS.MY_CHANNELS_PAGE_PREV ||
    data.action === ACTIONS.MY_CHANNELS_PAGE_NEXT ||
    data.action === ACTIONS.CHANNEL_EDIT_OPEN
  ) {
    await handleTelegramMyChannelsAction(ctx, data);
    return;
  }

  if (
    data.action === ACTIONS.FIND_FILTER_ACTIVE ||
    data.action === ACTIONS.FIND_FILTER_RECRUITING ||
    data.action === ACTIONS.FIND_FILTER_INACTIVE ||
    data.action === ACTIONS.FIND_LANG_ALL ||
    data.action === ACTIONS.FIND_LANG_EN ||
    data.action === ACTIONS.FIND_LANG_RU ||
    data.action === ACTIONS.FIND_PAGE_PREV ||
    data.action === ACTIONS.FIND_PAGE_NEXT
  ) {
    await handleTelegramFindGamesAction(ctx, data);
    return;
  }

  if (
    data.action === ACTIONS.FAQ_TOPIC ||
    data.action === ACTIONS.FAQ_BACK ||
    data.action === ACTIONS.FAQ_PAGE_PREV ||
    data.action === ACTIONS.FAQ_PAGE_NEXT ||
    (data.action === ACTIONS.FAQ_OPEN && data.chatId === "list")
  ) {
    await handleTelegramFaqAction(ctx, data);
    return;
  }

  if (
    data.action === ACTIONS.DM_HELP_ADD ||
    data.action === ACTIONS.DM_HELP_COMMANDS ||
    data.action === ACTIONS.DM_HELP_SETTINGS
  ) {
    await handleTelegramHelpAction(ctx, data);
    return;
  }

  if (data.action === ACTIONS.FIND_GAMES_OPEN) {
    const userId = getTelegramUserKeyFromCtx(ctx);
    const lang = await getUserLang(userId);
    const message = await buildTelegramFindGamesMessage(lang, "recruiting", 0, "all");
    await replyToTelegramMessage(ctx, message.text, message.reply_markup);
    await answerTelegramCallback(ctx);
    return;
  }

  if (data.action === ACTIONS.FAQ_OPEN) {
    const userId = getTelegramUserKeyFromCtx(ctx);
    const lang = await getUserLang(userId);
    const message = buildTelegramFaqList(lang, 0);
    await replyToTelegramMessage(ctx, message.text, message.reply_markup);
    await answerTelegramCallback(ctx);
    return;
  }

  await answerTelegramCallback(ctx);
}

async function handleTelegramPrivateCommand(ctx, command, args) {
  const userId = getTelegramUserKeyFromCtx(ctx);
  const userLangInfo = await getUserLangInfo(userId);
  const userLang = userLangInfo.lang;

  if (await isMaintenanceEnabled() && !isDevUser(userId)) {
    const allowCommands = ["lang", "whisper"];
    const activeGame = getUserCurrentGame(userId);
    const hasActiveGame =
      activeGame && (activeGame.state === "day" || activeGame.state === "night");
    if (!allowCommands.includes(command) || !hasActiveGame) {
      await replyToTelegramMessage(ctx, t(userLang, "maintenance.reply"));
      return;
    }
  }

  if (command === "dev") {
    if (!isDevUser(userId)) {
      await replyToTelegramMessage(ctx, t(userLang, "dev.not_authorized"));
      return;
    }
    const code = (args[0] || "").trim();
    if (!isDevCode(code)) {
      await replyToTelegramMessage(ctx, t(userLang, "dev.code_invalid"));
      return;
    }
    await sendDevPanel(null, userId);
    return;
  }

  if (command === "lang") {
    const choice = (args[0] || "").toLowerCase();
    if (!LANGS.includes(choice)) {
      await replyToTelegramMessage(ctx, t(userLang, "dm.lang_usage"));
      return;
    }
    const updated = await setUserLang(userId, choice);
    await replyToTelegramMessage(
      ctx,
      updated.lang === "ru" ? t("ru", "dm.lang_set_ru") : t("en", "dm.lang_set_en")
    );
    return;
  }

  if (command === "home") {
    const text = await buildTelegramHomeText(userId, userLang);
    await replyToTelegramMessage(ctx, text);
    return;
  }

  if (command === "faq") {
    const faqId = args[0] ? String(args[0]).trim().toLowerCase() : null;
    const message = faqId
      ? buildTelegramFaqDetail(userLang, faqId, 0)
      : buildTelegramFaqList(userLang, 0);
    await replyToTelegramMessage(ctx, message.text, message.reply_markup);
    return;
  }

  if (command === "find") {
    const message = await buildTelegramFindGamesMessage(userLang, "recruiting", 0, "all");
    await replyToTelegramMessage(ctx, message.text, message.reply_markup);
    return;
  }

  if (command === "mychannels" || command === "my_channels") {
    const message = await buildTelegramMyChannelsMessage(userId, userLang, 0);
    await replyToTelegramMessage(ctx, message.text, message.reply_markup);
    return;
  }

  if (command === "whisper") {
    if (await isMaintenanceEnabled() && !isDevUser(userId)) {
      await replyToTelegramMessage(ctx, t(userLang, "maintenance.reply"));
      return;
    }
    const whisperText = args.join(" ").trim();
    if (!whisperText) {
      await replyToTelegramMessage(ctx, t(userLang, "whisper.usage"));
      return;
    }
    const game = getUserCurrentGame(userId);
    if (!game) {
      await replyToTelegramMessage(ctx, t(userLang, "action.not_in_game"));
      return;
    }
    await withChannelLock(game.channelId, async () => {
      if (game.state !== "day") {
        await replyToTelegramMessage(ctx, t(userLang, "whisper.not_day"));
        return;
      }
      if (!game.config.whisperEnabled) {
        await replyToTelegramMessage(ctx, t(userLang, "whisper.disabled"));
        return;
      }
      if (!isPlayerAlive(game, userId)) {
        await replyToTelegramMessage(ctx, t(userLang, "action.not_in_game"));
        return;
      }
      if (game.whispersUsed[userId] === game.round) {
        await replyToTelegramMessage(ctx, t(userLang, "whisper.already_used"));
        return;
      }
      game.whispersUsed[userId] = game.round;
      saveGame(game);
      await announceToChannelLocalized(null, game, "whisper.post", () => ({
        text: whisperText,
      }));
      await replyToTelegramMessage(ctx, t(userLang, "whisper.sent"));
      await postOrUpdateDashboard(null, game);
    });
    return;
  }

  const helpText = withDevHint(
    t(userLang, "dm.help_intro_tg"),
    userLang,
    userId
  );
  await replyToTelegramMessage(ctx, helpText, buildTelegramDmHelpKeyboard(userLang));
}

async function handleTelegramPrivateText(ctx) {
  const userId = getTelegramUserKeyFromCtx(ctx);
  const text = (ctx.message?.text || "").trim();
  if (!text) return;

  if (text.startsWith("/")) {
    return;
  }

  const langMatch = text.match(/^lang\s+(en|ru)$/i);
  if (langMatch) {
    await handleTelegramPrivateCommand(ctx, "lang", [langMatch[1]]);
    return;
  }

  const langInfo = await getUserLangInfo(userId);
  const userLang = langInfo.lang;

  const pendingLastWords = getLastWordsEntry(userId);
  if (pendingLastWords) {
    if (now() > pendingLastWords.expiresAt) {
      clearLastWords(userId);
      await replyToTelegramMessage(ctx, t(userLang, "last_words.expired"));
      return;
    }

    const name = await getUserLabel(null, userId);
    const pendingGame = getGame(pendingLastWords.channelId);
    if (pendingGame) {
      await announceToChannelLocalized(
        null,
        pendingGame,
        "last_words.post",
        () => ({ name, text })
      );
    } else {
      await announceToChannel(
        null,
        pendingLastWords.channelId,
        t("en", "last_words.post", { name, text })
      );
    }
    clearLastWords(userId);
    await replyToTelegramMessage(ctx, t(userLang, "last_words.received"));
    return;
  }

  if (!langInfo.explicit && !languagePrompted.has(userId)) {
    languagePrompted.add(userId);
    const promptText = t("en", "dm.lang_prompt");
    await replyToTelegramMessage(ctx, promptText, buildTelegramLangKeyboard());
    return;
  }

  if (await isMaintenanceEnabled() && !isDevUser(userId)) {
    await replyToTelegramMessage(ctx, t(userLang, "maintenance.reply"));
    return;
  }

  const helpText = withDevHint(
    t(userLang, "dm.help_intro_tg"),
    userLang,
    userId
  );
  await replyToTelegramMessage(ctx, helpText, buildTelegramDmHelpKeyboard(userLang));
}

async function handleTelegramGroupCommand(ctx, command, args) {
  const channelId = getTelegramChannelKeyFromCtx(ctx);
  const userId = getTelegramUserKeyFromCtx(ctx);
  const lang = await getUserLang(userId);

  if (await isMaintenanceEnabled() && !isDevUser(userId)) {
    await replyToTelegramMessage(ctx, t(lang, "maintenance.reply"));
    return;
  }

  await promptTelegramChannelListing(ctx.chat.id, userId, ctx.chat.type);

  await withChannelLock(channelId, async () => {
    let game = getGame(channelId);

    if (command === "help") {
      await replyToTelegramMessage(ctx, t(lang, "help.commands"));
      return;
    }

    if (command === "create") {
      if (game && game.state !== "ended") {
        await replyToTelegramMessage(ctx, t(lang, "err.lobby_exists"));
        return;
      }
      const blocking = findBlockingGame(userId, channelId);
      if (blocking) {
        await replyToTelegramMessage(
          ctx,
          t(lang, "err.already_in_other", { channel: channelMention(blocking.channelId) })
        );
        return;
      }
      game = createLobby(channelId, userId, PLATFORM_TELEGRAM);
      const channelSettings = await getChannelSettings(channelId);
      applyChannelSettingsToGame(game, channelSettings);
      gameCache.set(channelId, game);
      saveGame(game);
      schedulePhaseTimers(game);
      await announceToChannelLocalized(null, game, "lobby.created", async (l) => ({
        host: await getNameOrMention(null, game, userId, l),
      }));
      await postOrUpdateLobbyPanel(null, game);
      await postOrUpdateDashboard(null, game);
      saveGame(game);
      await updateHomeForUsers(null, [userId, ...Object.keys(game.players || {})]);
      return;
    }

    if (command === "join") {
      if (!game || game.state !== "lobby") {
        await replyToTelegramMessage(ctx, t(lang, "err.lobby_none"));
        return;
      }
      const blocking = findBlockingGame(userId, channelId);
      if (blocking) {
        await replyToTelegramMessage(
          ctx,
          t(lang, "err.already_in_other", { channel: channelMention(blocking.channelId) })
        );
        return;
      }
      if (game.players[userId]) {
        await replyToTelegramMessage(ctx, t(lang, "err.already_in"));
        return;
      }
      game.players[userId] = {
        id: userId,
        role: null,
        alive: true,
        joinedAt: now(),
        name: tgUserCache.get(userId)?.label || null,
        ready: false,
      };
      saveGame(game);
      await announceToChannelLocalized(null, game, "lobby.joined", async (l) => ({
        user: await getNameOrMention(null, game, userId, l),
        count: Object.keys(game.players).length,
      }));
      await postOrUpdateLobbyPanel(null, game);
      await postOrUpdateDashboard(null, game);
      saveGame(game);
      await updateHomeForGame(null, game);
      return;
    }

    if (command === "leave") {
      if (!game || game.state !== "lobby") {
        await replyToTelegramMessage(ctx, t(lang, "err.lobby_only"));
        return;
      }
      if (!game.players[userId]) {
        await replyToTelegramMessage(ctx, t(lang, "err.not_in_lobby"));
        return;
      }
      delete game.players[userId];
      if (game.hostId === userId) {
        const remaining = Object.values(game.players).sort(
          (a, b) => a.joinedAt - b.joinedAt
        );
        game.hostId = remaining[0]?.id || null;
      }
      if (!game.hostId) {
        await closeLobby(null, game, { key: "lobby.empty_closed" });
        return;
      }
      saveGame(game);
      await announceToChannelLocalized(null, game, "lobby.left", async (l) => ({
        user: await getNameOrMention(null, game, userId, l),
        count: Object.keys(game.players).length,
      }));
      await postOrUpdateLobbyPanel(null, game);
      await postOrUpdateDashboard(null, game);
      saveGame(game);
      await updateHomeForGame(null, game);
      return;
    }

    if (command === "start") {
      if (!game || game.state !== "lobby") {
        await replyToTelegramMessage(ctx, t(lang, "err.lobby_start_none"));
        return;
      }
      if (game.hostId !== userId) {
        await replyToTelegramMessage(ctx, t(lang, "err.only_host_start"));
        return;
      }
      if (Object.keys(game.players).length < game.config.minPlayers) {
        await replyToTelegramMessage(
          ctx,
          t(lang, "err.need_min_players", { min: game.config.minPlayers })
        );
        return;
      }
      await startGameFromLobby(null, game, { key: "lobby.host_start" });
      return;
    }

    if (command === "status") {
      if (!game) {
        await replyToTelegramMessage(ctx, t(lang, "err.game_not_created"));
        return;
      }
      const alive = await listAliveDisplay(null, game, lang);
      await replyToTelegramMessage(
        ctx,
        t(lang, "status.text", {
          state: t(lang, `state.${game.state}`),
          host: await getNameOrMention(null, game, game.hostId, lang),
          alive,
        })
      );
      return;
    }

    if (command === "config") {
      if (!game || game.state !== "lobby") {
        await replyToTelegramMessage(ctx, t(lang, "err.config_lobby_only"));
        return;
      }
      if (game.hostId !== userId) {
        await replyToTelegramMessage(ctx, t(lang, "err.config_host_only"));
        return;
      }

      if (args.length === 0) {
        await replyToTelegramMessage(
          ctx,
          t(lang, "config.summary", {
            day: Math.round(game.config.dayMs / 60000),
            night: Math.round(game.config.nightMs / 60000),
            lobby: Math.round(game.config.lobbyMs / 60000),
            min: game.config.minPlayers,
            extend: game.config.extendPolicy,
          })
        );
        return;
      }

      const key = args[0];
      if (key === "extend") {
        const policy = (args[1] || "").toLowerCase();
        if (!["host", "any"].includes(policy)) {
          await replyToTelegramMessage(ctx, t(lang, "err.config_usage_extend"));
          return;
        }
        game.config.extendPolicy = policy;
      } else if (key === "lang") {
        const choice = (args[1] || "").toLowerCase();
        if (!LANGS.includes(choice)) {
          await replyToTelegramMessage(ctx, t(lang, "dm.lang_usage"));
          return;
        }
        game.config.channelLang = choice;
        const settings = {
          ...(await getChannelSettings(channelId)),
          channelLang: choice,
        };
        await setChannelSettings(channelId, settings);
      } else {
        const value = Number(args[1]);
        if (!value || Number.isNaN(value)) {
          await replyToTelegramMessage(ctx, t(lang, "err.config_usage_numbers"));
          return;
        }
        if (key === "day") {
          game.config.dayMs = toMs(value);
        } else if (key === "night") {
          game.config.nightMs = toMs(value);
        } else if (key === "lobby") {
          game.config.lobbyMs = toMs(value);
          if (game.state === "lobby") {
            game.phaseDeadline = now() + game.config.lobbyMs;
            schedulePhaseTimers(game);
          }
        } else if (key === "min") {
          game.config.minPlayers = Math.max(4, Math.floor(value));
        } else {
          await replyToTelegramMessage(ctx, t(lang, "err.config_options"));
          return;
        }
      }

      saveGame(game);
      await replyToTelegramMessage(ctx, t(lang, "ok.settings_updated"));
      if (game.state === "lobby") {
        await postOrUpdateLobbyPanel(null, game);
        await postOrUpdateDashboard(null, game);
        saveGame(game);
        await updateHomeForGame(null, game);
      }
      return;
    }

    if (command === "extend") {
      if (!game || game.state !== "lobby") {
        await replyToTelegramMessage(ctx, t(lang, "err.extend_lobby_only"));
        return;
      }
      if (!canExtendLobby(game, userId)) {
        await replyToTelegramMessage(ctx, t(lang, "err.extend_not_allowed"));
        return;
      }
      const minutes = Number(args[0]) || DEFAULTS.LOBBY_EXTEND_MINUTES;
      game.phaseDeadline =
        Math.max(now(), game.phaseDeadline || now()) + toMs(minutes);
      schedulePhaseTimers(game);
      saveGame(game);
      await announceToChannelLocalized(null, game, "lobby.extended", () => ({
        minutes,
      }));
      await postOrUpdateLobbyPanel(null, game);
      await postOrUpdateDashboard(null, game);
      saveGame(game);
      await updateHomeForGame(null, game);
      return;
    }

    if (command === "end") {
      if (!game) {
        await replyToTelegramMessage(ctx, t(lang, "err.no_active_game"));
        return;
      }
      if (game.hostId !== userId) {
        await replyToTelegramMessage(ctx, t(lang, "err.only_host_end"));
        return;
      }
      clearPhaseTimers(channelId);
      if (game.state === "lobby") {
        await closeLobby(null, game, { key: "lobby.end" });
      } else {
        await finalizeDashboard(null, game);
        gameCache.delete(channelId);
        deleteGame(channelId);
        await announceToChannelLocalized(null, game, "lobby.end");
        await updateHomeForUsers(null, Object.keys(game.players || {}));
        await maybeNotifyMaintenanceDone(null);
      }
      return;
    }

    await replyToTelegramMessage(ctx, t(lang, "err.unknown_command"));
  });
}

async function startTelegram() {
  if (!TELEGRAM_BOT_TOKEN) {
    telegramMode = "disabled";
    return telegramMode;
  }
  telegramBot = new Telegraf(TELEGRAM_BOT_TOKEN);

  telegramBot.use(async (ctx, next) => {
    if (ctx.from) cacheTelegramUser(ctx.from);
    const chat = ctx.chat || ctx.callbackQuery?.message?.chat;
    if (chat) cacheTelegramChat(chat);
    return next();
  });

  telegramBot.use(async (ctx, next) => {
    if (ctx.updateType !== "message") return next();
    if (isTelegramPrivateChat(ctx)) return next();
    if (!ctx.message?.from || ctx.message.from.is_bot) return next();

    const channelId = getTelegramChannelKeyFromCtx(ctx);
    const userId = getTelegramUserKeyFromCtx(ctx);
    const game = getGame(channelId);
    if (!game || game.state === "ended") return next();
    if (!game.players[userId]) return next();
    if (isPlayerAlive(game, userId)) return next();

    try {
      await ctx.deleteMessage();
    } catch (err) {
      const channelLang = getChannelLangForGame(game);
      await replyToTelegramMessage(ctx, t(channelLang, "dead.message_deleted"));
    }
    return;
  });

  telegramBot.on("callback_query", handleTelegramCallback);

  telegramBot.on("my_chat_member", async (ctx) => {
    const update = ctx.update?.my_chat_member;
    if (!update) return;
    const newStatus = update.new_chat_member?.status;
    const oldStatus = update.old_chat_member?.status;
    if (!["member", "administrator"].includes(newStatus)) return;
    if (newStatus === oldStatus) return;
    const chat = update.chat;
    if (!chat) return;
    cacheTelegramChat(chat);
    const inviterId = update.from
      ? makeUserKey(PLATFORM_TELEGRAM, update.from.id)
      : null;
    await promptTelegramChannelListing(chat.id, inviterId, chat.type);
  });

  telegramBot.command("start", async (ctx) => {
    if (!isTelegramPrivateChat(ctx)) return;
    const userId = getTelegramUserKeyFromCtx(ctx);
    const langInfo = await getUserLangInfo(userId);
    if (!langInfo.explicit && !languagePrompted.has(userId)) {
      languagePrompted.add(userId);
      const promptText = t("en", "dm.lang_prompt");
      await replyToTelegramMessage(ctx, promptText, buildTelegramLangKeyboard());
      return;
    }
    const helpText = withDevHint(
      t(langInfo.lang, "dm.help_intro_tg"),
      langInfo.lang,
      userId
    );
    await replyToTelegramMessage(ctx, helpText, buildTelegramDmHelpKeyboard(langInfo.lang));
  });

  telegramBot.command(["help"], async (ctx) => {
    if (!isTelegramPrivateChat(ctx)) {
      const userId = getTelegramUserKeyFromCtx(ctx);
      const lang = await getUserLang(userId);
      await replyToTelegramMessage(ctx, t(lang, "help.commands"));
      return;
    }
    await handleTelegramPrivateCommand(ctx, "help", []);
  });

  telegramBot.command("home", async (ctx) => {
    if (!isTelegramPrivateChat(ctx)) return;
    await handleTelegramPrivateCommand(ctx, "home", []);
  });

  telegramBot.command("faq", async (ctx) => {
    if (!isTelegramPrivateChat(ctx)) return;
    const args = ctx.message?.text?.split(/\s+/).slice(1) || [];
    await handleTelegramPrivateCommand(ctx, "faq", args);
  });

  telegramBot.command("find", async (ctx) => {
    if (!isTelegramPrivateChat(ctx)) return;
    await handleTelegramPrivateCommand(ctx, "find", []);
  });

  telegramBot.command(["mychannels", "my_channels"], async (ctx) => {
    if (!isTelegramPrivateChat(ctx)) return;
    await handleTelegramPrivateCommand(ctx, "mychannels", []);
  });

  telegramBot.command("lang", async (ctx) => {
    if (!isTelegramPrivateChat(ctx)) return;
    const args = ctx.message?.text?.split(/\s+/).slice(1) || [];
    await handleTelegramPrivateCommand(ctx, "lang", args);
  });

  telegramBot.command("dev", async (ctx) => {
    if (!isTelegramPrivateChat(ctx)) return;
    const args = ctx.message?.text?.split(/\s+/).slice(1) || [];
    await handleTelegramPrivateCommand(ctx, "dev", args);
  });

  telegramBot.command("whisper", async (ctx) => {
    if (!isTelegramPrivateChat(ctx)) return;
    const args = ctx.message?.text?.split(/\s+/).slice(1) || [];
    await handleTelegramPrivateCommand(ctx, "whisper", args);
  });

  telegramBot.command("create", async (ctx) => {
    if (isTelegramPrivateChat(ctx)) return;
    await handleTelegramGroupCommand(ctx, "create", []);
  });
  telegramBot.command("join", async (ctx) => {
    if (isTelegramPrivateChat(ctx)) return;
    await handleTelegramGroupCommand(ctx, "join", []);
  });
  telegramBot.command("leave", async (ctx) => {
    if (isTelegramPrivateChat(ctx)) return;
    await handleTelegramGroupCommand(ctx, "leave", []);
  });
  telegramBot.command("start", async (ctx) => {
    if (isTelegramPrivateChat(ctx)) return;
    await handleTelegramGroupCommand(ctx, "start", []);
  });
  telegramBot.command("extend", async (ctx) => {
    if (isTelegramPrivateChat(ctx)) return;
    const args = ctx.message?.text?.split(/\s+/).slice(1) || [];
    await handleTelegramGroupCommand(ctx, "extend", args);
  });
  telegramBot.command("status", async (ctx) => {
    if (isTelegramPrivateChat(ctx)) return;
    await handleTelegramGroupCommand(ctx, "status", []);
  });
  telegramBot.command("end", async (ctx) => {
    if (isTelegramPrivateChat(ctx)) return;
    await handleTelegramGroupCommand(ctx, "end", []);
  });
  telegramBot.command("config", async (ctx) => {
    if (isTelegramPrivateChat(ctx)) return;
    const args = ctx.message?.text?.split(/\s+/).slice(1) || [];
    await handleTelegramGroupCommand(ctx, "config", args);
  });

  telegramBot.on("text", async (ctx) => {
    if (!isTelegramPrivateChat(ctx)) return;
    await handleTelegramPrivateText(ctx);
  });

  if (TELEGRAM_WEBHOOK_DOMAIN) {
    const hookPath =
      TELEGRAM_WEBHOOK_PATH.startsWith("/")
        ? TELEGRAM_WEBHOOK_PATH
        : `/${TELEGRAM_WEBHOOK_PATH}`;
    let attempt = 0;
    const maxAttempts = 3;
    while (attempt < maxAttempts) {
      try {
        await telegramBot.launch({
          webhook: { domain: TELEGRAM_WEBHOOK_DOMAIN, hookPath, port: PORT },
        });
        telegramMode = "webhook";
        console.log("Telegram bot is running (webhook).");
        return telegramMode;
      } catch (err) {
        if (telegramBot.webhookServer) {
          try {
            telegramBot.webhookServer.close();
          } catch (closeErr) {
            console.warn(
              "Failed to close Telegram webhook server:",
              closeErr?.message || closeErr
            );
          } finally {
            telegramBot.webhookServer = undefined;
          }
        }
        if (err?.code === "EADDRINUSE") {
          console.warn(
            `Telegram webhook port ${PORT} is already in use. Falling back to polling.`
          );
          try {
            await telegramBot.telegram.deleteWebhook();
          } catch (deleteErr) {
            console.warn(
              "Failed to delete Telegram webhook before polling:",
              deleteErr?.message || deleteErr
            );
          }
          telegramMode = "polling";
          telegramBot
            .launch()
            .then(() => {
              console.log("Telegram bot is running (polling).");
            })
            .catch((launchErr) => {
              console.error(
                "Telegram polling failed:",
                launchErr?.message || launchErr
              );
            });
          return telegramMode;
        }
        const retryAfter =
          err?.response?.parameters?.retry_after ||
          err?.parameters?.retry_after ||
          0;
        if (err?.response?.error_code === 429 && retryAfter >= 0) {
          const waitMs = (Number(retryAfter) + 1) * 1000;
          console.warn(
            `Telegram webhook rate-limited. Retry in ${Math.ceil(
              waitMs / 1000
            )}s.`
          );
          await sleep(waitMs);
          attempt += 1;
          continue;
        }
        throw err;
      }
    }
    console.warn(
      "Telegram webhook failed after retries. Falling back to polling."
    );
    telegramMode = "polling";
    telegramBot
      .launch()
      .then(() => {
        console.log("Telegram bot is running (polling).");
      })
      .catch((launchErr) => {
        console.error("Telegram polling failed:", launchErr?.message || launchErr);
      });
    return telegramMode;
  }

  telegramMode = "polling";
  telegramBot
    .launch()
    .then(() => {
      console.log("Telegram bot is running (polling).");
    })
    .catch((launchErr) => {
      console.error("Telegram polling failed:", launchErr?.message || launchErr);
    });
  return telegramMode;
}

async function restoreActiveGames() {
  const games = await loadAllGames();
  const maintenanceEnabled = await isMaintenanceEnabled();
  for (const game of games) {
    normalizeGame(game);
    gameCache.set(game.channelId, game);
    let dirty = false;
    if (game.lastWords?.pending) {
      Object.entries(game.lastWords.pending).forEach(([userId, entry]) => {
        if (entry?.expiresAt && entry.expiresAt > now()) {
          lastWordsPending.set(userId, entry);
        } else {
          delete game.lastWords.pending[userId];
          dirty = true;
        }
      });
    }
    if (dirty) await saveGame(game);
    if (maintenanceEnabled && game.state === "lobby") {
      withChannelLock(game.channelId, async () => {
        const current = getGame(game.channelId);
        if (current && current.state === "lobby") {
          await closeLobby(app.client, current, {
            key: "maintenance.lobby_closed",
          });
        }
      });
      return;
    }
    if (["day", "night", "lobby"].includes(game.state)) {
      if (!game.phaseDeadline || game.phaseDeadline <= now()) {
        withChannelLock(game.channelId, async () => {
          await autoResolvePhase(app.client, game);
        });
      } else {
        schedulePhaseTimers(game);
        if (game.state === "lobby") {
          withChannelLock(game.channelId, async () => {
            await postOrUpdateLobbyPanel(app.client, game);
            await postOrUpdateDashboard(app.client, game);
            await saveGame(game);
          });
        }
        if (game.state === "day" || game.state === "night") {
          withChannelLock(game.channelId, async () => {
            await postOrUpdateDashboard(app.client, game);
            await saveGame(game);
          });
        }
      }
    }
  }
}

(async () => {
  const useTelegramWebhook = Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_WEBHOOK_DOMAIN);
  const slackPort = useTelegramWebhook
    ? Number.isFinite(SLACK_PORT) && SLACK_PORT > 0
      ? SLACK_PORT
      : 3001
    : Number.isFinite(SLACK_PORT) && SLACK_PORT > 0
      ? SLACK_PORT
      : 0;
  await db.initDb();
  await app.start(slackPort);
  if (useTelegramWebhook) {
    console.log(
      `Slack listening on port ${slackPort} to avoid conflict with Telegram webhook port ${PORT}.`
    );
  }
  await initBotIdentity(app.client);
  try {
    await startTelegram();
  } catch (err) {
    console.error("Telegram failed to start:", err?.message || err);
    telegramMode = "disabled";
  }
  if (telegramMode !== "webhook") {
    startHealthServer();
  }
  startKeepAlive();
  await restoreActiveGames();
  await maybeNotifyMaintenanceDone(app.client);
  console.log("Mafia bot is running (Socket Mode).");
})();
