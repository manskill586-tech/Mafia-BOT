
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { App, LogLevel } = require("@slack/bolt");

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

const LANGS = ["en", "ru"];
const DEFAULT_LANG = "en";

const I18N = {
  en: {
    role: {
      mafia: "😈 Mafia",
      doctor: "🧑‍⚕️ Doctor",
      detective: "🕵️ Detective",
      mayor: "🎩 Mayor",
      bodyguard: "🛡️ Bodyguard",
      town: "👤 Townsperson",
      jester: "🤡 Jester",
      godfather: "🕴️ Godfather",
      lucky: "🍀 Lucky",
      bum: "🧴 Bum",
      sergeant: "🎖️ Sergeant",
      lawyer: "⚖️ Lawyer",
      stalker: "🎯 Stalker",
    },
    role_help: {
      mafia:
        "😈 You are Mafia. Coordinate at night, choose a target, and reach parity with the town.",
      godfather:
        "🕴️ You are the Godfather. You are mafia, but the Detective sees you as Town.",
      doctor:
        "🧑‍⚕️ You are the Doctor. Each night choose someone to save from death (including yourself within the limit).",
      detective:
        "🕵️ You are the Detective. Each night you can either check a player or kill a target (only one action).",
      mayor:
        "🎩 You are the Mayor. Your vote counts as 2 during the day.",
      bodyguard:
        "🛡️ You are the Bodyguard. Choose a player to protect; if mafia attacks them, you take the hit.",
      jester:
        "🤡 You are the Jester. If you are executed by vote, you win instantly.",
      town:
        "👤 You are a Townsperson. Find mafia and vote them out.",
      lucky:
        "🍀 You are Lucky. Each night you have a 50% chance to survive any killing attempt.",
      bum:
        "🧴 You are the Bum. Visit someone at night; if they die, you witness who killed them.",
      sergeant:
        "🎖️ You are the Sergeant. The Detective shares results with you. If the Detective dies, you get their actions.",
      lawyer:
        "⚖️ You are the Lawyer. At night protect a player; if you protect mafia, the Detective sees them as Town. Your goal is mafia victory.",
      stalker:
        "🎯 You are the Stalker. You have a contract on a role. Kill that role yourself to score a win.",
    },
    time: {
      sec: "{seconds} sec",
      min: "{minutes} min",
      min_sec: "{minutes} min {seconds} sec",
    },
    button: {
      join: "➕ Join",
      leave: "➖ Leave",
      start: "▶️ Start",
      extend: "⏳ Extend +2m",
      end: "⏹️ End",
      ready: "✅ Ready",
      abstain: "🤐 Abstain",
      no_kill: "🛑 No kill",
      role_help: "ℹ️ What to do?",
      detective_check: "🔍 Check",
      detective_kill: "🎯 Kill",
      prev: "◀️ Prev",
      next: "▶️ Next",
      page: "📄 Page {page}/{total}",
      help_add: "➕ Add bot",
      help_commands: "📜 Commands",
      help_settings: "⚙️ Settings",
      find_games: "🔎 Find games",
      my_channels: "🗂️ My channels",
      faq: "❓ FAQ",
      back: "⬅️ Back",
      public: "🌐 Public",
      private: "🔒 Private",
      filter_active: "🟢 Active",
      filter_recruiting: "🟡 Recruiting",
      filter_inactive: "⚪ Inactive",
      filter_lang_all: "🌍 All",
      filter_lang_en: "🇬🇧 ENG",
      filter_lang_ru: "🇷🇺 RU",
      lang_en: "🇬🇧 English",
      lang_ru: "🇷🇺 Russian",
    },
    dashboard: {
      title: "🧭 Game Dashboard",
      phase: "🧭 Phase: {phase}",
      timer: "⏳ Timer: {time}",
      alive: "🧍 Alive ({count}): {list}",
      ready: "✅ Ready: {ready}/{total}",
    },
    home: {
      title: "🏠 MafiaBot",
      tagline: "🎮 Your Mafia game control center for Slack. (Developer: @bob)",
      quickstart:
        "*🚀 Quick Start*\n" +
        "1️⃣ Add me to a channel: `/invite @MafiaBot`\n" +
        "2️⃣ Create a lobby: `@MafiaBot create`\n" +
        "3️⃣ Players press `Join`, host presses `Start` or everyone `Ready`",
      controls:
        "*🧩 Lobby Controls*\n" +
        "- Buttons: `Join`, `Leave`, `Ready`, `Start`, `Extend`, `End`\n" +
        "- Commands: `@MafiaBot join`, `leave`, `start`, `extend 2`, `status`, `config`",
      gameplay:
        "*🌙 During the Game*\n" +
        "- Night actions and day voting arrive in DM\n" +
        "- `whisper <text>` in DM once per day\n" +
        "- If eliminated, you get one “last words” DM",
      features:
        "*✨ Highlights*\n" +
        "- Roles: Mafia, Doctor, Detective, Mayor, Bodyguard, Jester, Godfather, Lucky, Bum, Sergeant, Lawyer, Stalker\n" +
        "- Anonymous voting, auto‑timers, saved state (SQLite)\n" +
        "- Mafia room + graveyard (if permissions allow)",
      tips:
        "*💡 Tips*\n" +
        "- If you have multiple games, include `#channel` in DM commands\n" +
        "- Change language in DM: `lang en` / `lang ru`\n" +
        "- Edit channel defaults in DM: `My channels`\n" +
        "- Open FAQ in DM: `FAQ`",
      stats_title: "📊 Your stats",
      stats_line:
        "Games: {games} • Wins: {wins} • Losses: {losses} • Winrate: {rate}%",
      channel_stats_title: "🧩 This channel",
      channel_stats_line:
        "Games: {games} • Wins: {wins} • Losses: {losses} • Winrate: {rate}%",
      role_stats_title: "🎭 Role stats",
      role_stats_empty: "ℹ️ No role stats yet.",
      current_title: "🕹️ Current game",
      current_none: "ℹ️ No active game.",
      current_line:
        "Channel: {channel}\n" +
        "Phase: {phase}\n" +
        "Timer: {time}\n" +
        "Alive: {alive}\n" +
        "You: {status}\n" +
        "Role: {role}",
      status_alive: "✅ Alive",
      status_dead: "❌ Eliminated",
      role_unknown: "ℹ️ Unknown",
      history_title: "🌙 Last 3 nights",
      history_empty: "ℹ️ No night results yet.",
      history_line: "🌙 Night {round}: {text}",
    },
    find: {
      prompt_public: "ℹ️ Make {channel} public in Find Games?",
      set_public: "✅ {channel} is now public in Find Games.",
      set_private: "ℹ️ {channel} is private and won't be listed.",
      private_not_allowed: "❌ Private channels can't be listed in Find Games.",
      title: "🔎 Find games",
      empty: "ℹ️ No channels match this filter.",
      status_active: "🟢 Active — {phase} {round} • Alive {alive}",
      status_recruiting: "🟡 Recruiting — {count}/{min}, starts in {time}",
      status_inactive: "⚪ Inactive — no active game",
      filters: "🎛️ Filter:",
      filter_lang: "🌐 Language:",
      lang_label_en: "🇬🇧 ENG",
      lang_label_ru: "🇷🇺 RU",
    },
    faq: {
      title: "❓ FAQ",
      intro:
        "ℹ️ Choose a question below. You can also type `faq <id>` in DM to open a specific answer.",
      id_label: "🔗 FAQ ID: `faq {id}`",
      not_found: "⚠️ Question not found. Showing FAQ list.",
      command_open: "❓ Open the FAQ:",
      command_detail: "❓ Open FAQ question `{id}`:",
      open_button: "❓ Open FAQ",
    },
    my_channels: {
      title: "🗂️ My channels",
      empty: "ℹ️ No channels yet.",
      status_public: "🌐 Public",
      status_private: "🔒 Private",
      not_owner: "❌ You are not the owner for this channel.",
      saved: "✅ Channel settings saved.",
      edit_intro: "⚙️ Editing {channel}",
    },
    settings: {
      title: "⚙️ Channel settings",
      privacy_label: "🔎 Find Games visibility",
      privacy_public: "🌐 Public",
      privacy_private: "🔒 Private",
      channel_lang: "🌐 Channel language",
      channel_lang_en: "English (ENG)",
      channel_lang_ru: "Russian (RU)",
      day_minutes: "☀️ Day minutes",
      night_minutes: "🌙 Night minutes",
      lobby_minutes: "🧩 Lobby minutes",
      min_players: "👥 Minimum players",
      extend_policy: "🧩 Who can extend lobby?",
      extend_host: "👑 Host only",
      extend_any: "👥 Anyone",
      warning_1: "⚠️ Warning #1 (sec)",
      warning_2: "⚠️ Warning #2 (sec)",
      auto_shorten: "⏱️ Auto‑shorten phase",
      whisper_enabled: "💬 Whisper enabled",
      allow_abstain: "🤐 Allow abstain",
      allow_no_kill: "🛑 Allow no‑kill",
      doctor_self_save: "🧑‍⚕️ Self‑save limit",
      toggle_on: "✅ On",
      toggle_off: "❌ Off",
      submit: "✅ Save",
      cancel: "❌ Cancel",
      invalid_number: "⚠️ Enter a valid number.",
      invalid_min_players: "⚠️ Min players must be at least 4.",
      invalid_warning: "⚠️ Warnings must be > 0.",
      invalid_self_save: "⚠️ Self‑save limit must be >= 0.",
    },
    dm: {
      lang_prompt:
        "🌐 Choose language below (English / Русский). You can change later with `lang en` / `lang ru`.",
      lang_set_en: "✅ Language set to English.",
      lang_set_ru: "✅ Language set to Russian.",
      lang_usage: "ℹ️ Usage: `lang en` or `lang ru`.",
      lang_change_command:
        "ℹ️ Language is already set. Change it with `lang en` / `lang ru`.",
      help_intro:
        "👋 Hi! I'm MafiaBot.\n" +
        "🚀 How to start:\n" +
        "1) Add me to a channel: `/invite @MafiaBot`\n" +
        "2) Create a lobby: `@MafiaBot create` (or button)\n" +
        "3) Players join with `Join`, host starts with `Start`\n" +
        "💡 If you have multiple games, include the channel in DM: `vote @user #channel`\n" +
        "💬 DM: `whisper <text>` (once per day)\n" +
        "🌐 Change language: `lang en` / `lang ru`.\n" +
        "🔎 Use `Find games` to browse public lobbies.\n" +
        "🗂️ Use `My channels` to edit your channel settings.\n" +
        "❓ Use `FAQ` for common questions.",
      help_add:
        "➕ To add me to a channel:\n" +
        "1) Open the channel\n" +
        "2) Type `/invite @MafiaBot`\n" +
        "Then create a lobby with `@MafiaBot create` or the button.",
      help_commands:
        "📜 Channel commands:\n" +
        "- `@MafiaBot create` — create lobby\n" +
        "- `@MafiaBot join` / `leave`\n" +
        "- `@MafiaBot start` — start (host)\n" +
        "- `@MafiaBot extend 2` — extend lobby\n" +
        "- `@MafiaBot status`, `config`, `end`\n" +
        "💬 DM: `whisper <text>` (once per day)\n" +
        "🌐 Change language: `lang en` / `lang ru`.\n" +
        "🔎 Find games: use the `Find games` button in DM.\n" +
        "🗂️ My channels: `mychannels` in DM.\n" +
        "🗂️ My channels: use the `My channels` button in DM.\n" +
        "❓ FAQ: use the `FAQ` button in DM.",
      help_settings:
        "⚙️ Settings (lobby only):\n" +
        "- `@MafiaBot config day 5`\n" +
        "- `@MafiaBot config night 2`\n" +
        "- `@MafiaBot config lobby 5`\n" +
        "- `@MafiaBot config min 4`\n" +
        "- `@MafiaBot config extend host|any`\n" +
        "🌐 Change language: `lang en` / `lang ru`.\n" +
        "🔎 Find games: use the `Find games` button in DM.\n" +
        "🗂️ My channels: use the `My channels` button in DM.\n" +
        "❓ FAQ: use the `FAQ` button in DM.",
    },
    dev: {
      panel: {
        title: "🛠️ Dev panel",
        status_on: "🟢 Maintenance: ON",
        status_off: "🔴 Maintenance: OFF",
        button_enable: "🛠️ Enable maintenance",
        button_disable: "🛠️ Disable maintenance",
      },
      not_authorized: "❌ You are not authorized to use developer commands.",
      code_invalid: "❌ Invalid developer code.",
      help: "🛠️ Dev: `dev <code>` • `test setup #channel Alice,Bob` • `as Alice vote Bob`",
    },
    maintenance: {
      reply: "⏳ MafiaBot is updating and will be back soon.",
      blocked: "⚠️ MafiaBot is updating. New lobbies are temporarily disabled.",
      lobby_closed: "⚠️ Lobby closed due to maintenance.",
      done: "✅ All active games finished. You can update the bot now.",
    },
    last_words: {
      prompt:
        "🕯️ You are eliminated. Send one last message within 2 minutes. It will be posted in {channel}.",
      received: "✅ Your last words were posted.",
      expired: "⏳ Time is up. Last words were not sent.",
      post: "🕯️ Last words from {name}: {text}",
    },
    dead: {
      no_talk: "🚫 You are eliminated and cannot speak in this channel.",
      message_deleted: "🚫 You are eliminated and cannot speak in this channel.",
    },
    graveyard: {
      unavailable:
        "⚠️ Graveyard channel is unavailable (missing permission to create/invite).",
    },
    mafia_room: {
      intro: "🕶️ Mafia room created. Discuss here during the night.",
    },
    whisper: {
      usage: "ℹ️ Usage: `whisper <text>`",
      not_day: "⚠️ Whisper is only available during the day.",
      disabled: "🚫 Whisper is disabled for this channel.",
      already_used: "⚠️ You already used a whisper this day.",
      sent: "✅ Your whisper was sent anonymously.",
      post: "💬 Anonymous whisper: {text}",
    },
    lobby: {
      title: "🧩 Mafia lobby",
      host: "👑 Host: {host}",
      players: "👥 Players: {count}/{min}",
      ready: "✅ Ready: {ready}/{total}",
      start_in: "⏳ Starts in: {time}",
      created:
        "🧩 Lobby created. Host: {host}. Join with `@MafiaBot join` or the button.",
      joined: "➕ {user} joined. Players: {count}",
      left: "➖ {user} left. Players: {count}",
      empty_closed: "ℹ️ Lobby is empty. Game removed.",
      closed_not_enough:
        "⚠️ Lobby closed: need at least {min} players, now {count}.",
      timeout_start: "⏳ Lobby time ended. Starting game!",
      host_start: "▶️ Host started the game.",
      ready_start: "✅ All players are ready. Starting game!",
      extended: "⏳ Lobby extended by {minutes} min.",
      closed: "❌ Lobby closed.",
      starting: "▶️ Lobby closed. Game starting.",
      end: "⏹️ Game ended.",
      panel_summary: "🧩 Lobby players {count}/{min}.",
    },
    warn: {
      day: "⚠️ Day ends in {seconds} sec.",
      night: "⚠️ Night ends in {seconds} sec.",
      lobby: "⚠️ Lobby auto-start in {seconds} sec.",
      shortened_day: "⚡ Day shortened due to high activity.",
      shortened_night: "⚡ Night shortened due to high activity.",
    },
    reminder: {
      night_action: "night action 🌙",
      vote: "vote 🗳️",
      text: "🔔 Reminder: finish {action} for the game in {channel}.",
    },
    phase: {
      night_start: "🌙 Night {round}. The city falls asleep...",
      day_start: "☀️ Day {round}. The city wakes up...",
    },
    night: {
      ended_killed: "🌙 Night is over. Killed: {targets}.",
      ended_none: "🌙 Night is over. Nobody died.",
      bodyguard: "🛡️ Bodyguard took the hit.",
    },
    day: {
      ended_executed: "🗳️ Voting ended. Executed: {target} ({role}).",
      ended_tie: "🗳️ Voting ended. Tie — nobody executed.",
    },
    auto: {
      applied: "🤖 Auto actions applied.",
    },
    winner: {
      mafia: "🏆 Mafia wins!",
      town: "🏆 Town wins!",
      jester: "🏆 Jester wins!",
      summary: "{winner}\nMafia: {mafia}\nTown: {town}",
      summary_jester: "{winner}\nJester: {jester}\nMafia: {mafia}\nTown: {town}",
    },
    prompt: {
      mafia: "😈 Game in {channel}. Choose mafia target.",
      doctor: "🧑‍⚕️ Game in {channel}. Who to save tonight?",
      detective_mode: "🕵️ Choose your action for tonight:",
      detective: "🕵️ Game in {channel}. Who to check?",
      detective_kill: "🎯 Game in {channel}. Who to kill?",
      bodyguard: "🛡️ Game in {channel}. Who to protect?",
      bum: "🧴 Game in {channel}. Who to visit tonight?",
      lawyer: "⚖️ Game in {channel}. Who to protect?",
      stalker: "🎯 Contract: {role}. Choose your target.",
      day: "🗳️ Game in {channel}. Your vote to eliminate.",
    },
    select: {
      player: "👤 Select a player",
      target: "🎯 Select a target",
    },
    help: {
      commands:
        "ℹ️ Commands: create, join, leave, start, status, end, config, extend. Voting and night actions are in DM.",
    },
    config: {
      summary:
        "⚙️ Settings: day={day}m, night={night}m, lobby={lobby}m, min={min}, extend={extend}",
    },
    status: {
      text: "ℹ️ Status: {state}. Host: {host}. Alive: {alive}",
    },
    state: {
      lobby: "🧩 lobby",
      day: "☀️ day",
      night: "🌙 night",
      ended: "🏁 ended",
    },
    err: {
      channel_unknown: "❌ Could not determine channel.",
      already_in_other: "❌ You are already in a lobby or game in {channel}.",
      lobby_not_active: "⚠️ Lobby is not active.",
      lobby_exists: "⚠️ A lobby already exists in this channel.",
      lobby_none: "❌ No lobby right now. Create: @MafiaBot create",
      already_in: "⚠️ You are already in the game.",
      lobby_only: "❌ You can leave only in the lobby.",
      not_in_lobby: "❌ You are not in the lobby.",
      lobby_start_none: "⚠️ No active lobby to start.",
      only_host_start: "❌ Only the host can start the game.",
      need_min_players: "⚠️ Need at least {min} players.",
      game_not_created: "❌ Game not created.",
      config_lobby_only: "⚠️ Configuration is only available in the lobby.",
      config_host_only: "❌ Only the host can configure the game.",
      config_usage_extend: "ℹ️ Usage: @MafiaBot config extend host|any",
      config_usage_numbers:
        "ℹ️ Usage: @MafiaBot config day 5 | night 2 | lobby 5 | min 4",
      config_options: "ℹ️ Available settings: day, night, lobby, min, extend",
      extend_lobby_only: "⚠️ You can extend only in the lobby.",
      extend_not_allowed: "❌ Only the host or an allowed participant can extend.",
      no_active_game: "⚠️ No active game.",
      only_host_end: "❌ Only the host can end the game.",
      unknown_command: "❌ Unknown command. Type @MafiaBot help",
    },
    ok: {
      settings_updated: "✅ Settings updated.",
    },
    action: {
      role_dm: "🎭 Your role in the game {channel}: *{role}*.",
      failed: "❌ Failed to process selection.",
      game_ended: "⚠️ Game already ended.",
      not_in_game: "❌ You are not in the game or you are eliminated.",
      not_day: "⚠️ It is not day now.",
      choose_alive: "ℹ️ Choose a living player.",
      already_acted: "⚠️ You already acted this phase.",
      already_voted: "⚠️ Your vote is already locked.",
      vote_recorded: "✅ Your vote recorded: {target}.",
      vote_abstain: "✅ You abstained.",
      not_night: "⚠️ It is not night now.",
      mafia_only: "❌ Only mafia can do that.",
      no_mafia_target: "⚠️ You cannot choose mafia.",
      choice_recorded: "✅ Your choice: {target}.",
      no_kill: "✅ Your choice: no kill.",
      doctor_only: "❌ Only the doctor can do that.",
      detective_only: "❌ Only the detective can do that.",
      bodyguard_only: "❌ Only the bodyguard can do that.",
      bum_only: "❌ Only the Bum can do that.",
      lawyer_only: "❌ Only the Lawyer can do that.",
      stalker_only: "❌ Only the Stalker can do that.",
      doctor_self_save_limit: "⚠️ You can only save yourself once per game.",
      doctor_save: "✅ You save: {target}.",
      detective_check: "✅ You check: {target}.",
      detective_kill: "✅ You kill: {target}.",
      detective_result: "ℹ️ Check result: {target} is {result}.",
      bodyguard_protect: "✅ You protect: {target}.",
      bum_visit: "✅ You visit: {target}.",
      lawyer_protect: "✅ You protect: {target}.",
      stalker_kill: "✅ You hunt: {target}.",
      result_mafia: "😈 mafia",
      result_not_mafia: "👤 not mafia",
    },
    bum: {
      witness: "🧴 You witnessed a murder: {killer} killed {victim}.",
      nothing: "🧴 You saw nothing tonight.",
    },
    stalker: {
      target_assigned: "🎯 Your contract role: {role}.",
      success: "🏆 Contract completed! Wins: {wins}. New target: {role}.",
      failed: "⚠️ Contract failed. New target: {role}.",
      no_targets: "⚠️ No available roles to target right now.",
    },
    sergeant: {
      promoted: "🎖️ The Detective is dead. You take over their actions.",
      info: "🎖️ Detective result: {target} is {result}.",
    },
    dm_cmd: {
      no_game: "⚠️ No active game for this command.",
      need_alive: "ℹ️ You must mention a living player.",
      day_only: "⚠️ Day actions are only available during the day.",
      night_only: "⚠️ Night actions are only available at night.",
      mafia_only: "❌ Only mafia can do that.",
      no_mafia_target: "⚠️ You cannot choose mafia.",
      abstain_disabled: "🚫 Abstain is disabled in this channel.",
      no_kill_disabled: "🚫 No‑kill is disabled in this channel.",
      doctor_only: "❌ Only the doctor can do that.",
      detective_only: "❌ Only the detective can do that.",
      bodyguard_only: "❌ Only the bodyguard can do that.",
      bum_only: "❌ Only the Bum can do that.",
      lawyer_only: "❌ Only the Lawyer can do that.",
      stalker_only: "❌ Only the Stalker can do that.",
      doctor_self_save_limit: "⚠️ You can only save yourself once per game.",
      vote_recorded: "✅ Your vote recorded: {target}.",
      choice_recorded: "✅ Your choice: {target}.",
      doctor_save: "✅ You save: {target}.",
      detective_check: "✅ You check: {target}.",
      detective_kill: "✅ You kill: {target}.",
      detective_result: "ℹ️ Check result: {target} is {result}.",
      result_mafia: "😈 mafia",
      result_not_mafia: "👤 not mafia",
      bodyguard_protect: "✅ You protect: {target}.",
      bum_visit: "✅ You visit: {target}.",
      lawyer_protect: "✅ You protect: {target}.",
      stalker_kill: "✅ You hunt: {target}.",
      unknown_command:
        "❌ Unknown command. Use kill/save/check/protect/visit/defend/stalk @user.",
    },
    test: {
      not_dev: "❌ Only the developer can use test commands.",
      setup_usage: "ℹ️ Usage: `test setup #channel Alice,Bob,Charlie`",
      list_usage: "ℹ️ Usage: `test list #channel`",
      setup_ok:
        "✅ 🧪 Test lobby ready in {channel}. Players: {players}\nUse: `as <name> <action>`.",
      duplicate_names: "❌ Duplicate test names: {names}.",
      active_game: "⚠️ Can't setup test mode during an active game.",
      real_players: "⚠️ Remove real players from the lobby before using test mode.",
      no_game: "⚠️ No test game found. Use `test setup` or specify #channel.",
      list: "🧪 Test players in {channel}: {players}",
      as_usage: "ℹ️ Usage: `as <name> <action> [target]`",
      actor_not_found: "❌ Test player `{name}` not found.",
      target_not_found: "❌ Target not found: `{name}`.",
      roles_summary: "🧪 *Test roles* in {channel}:\n{list}",
      actions_reminder_night:
        "🌙 *Test actions (night)* in {channel}:\n{list}\nUse: `as <name> <action> <target>`",
      actions_reminder_day:
        "☀️ *Test actions (day)* in {channel}:\n{list}\nUse: `as <name> vote <target>` or `as <name> abstain`",
    },
  },
  ru: {
    role: {
      mafia: "😈 Мафия",
      doctor: "🧑‍⚕️ Доктор",
      detective: "🕵️ Детектив",
      mayor: "🎩 Мэр",
      bodyguard: "🛡️ Телохранитель",
      town: "👤 Мирный",
      jester: "🤡 Шут",
      godfather: "🕴️ Крёстный отец",
      lucky: "🍀 Счастливчик",
      bum: "🧴 Бомж",
      sergeant: "🎖️ Сержант",
      lawyer: "⚖️ Адвокат",
      stalker: "🎯 Сталкер",
    },
    role_help: {
      mafia:
        "😈 Ты — Мафия. Ночью выбирайте цель и добейтесь паритета с городом.",
      godfather:
        "🕴️ Ты — Крёстный отец. Ты мафия, но Детектив видит тебя как мирного.",
      doctor:
        "🧑‍⚕️ Ты — Доктор. Ночью выбираешь кого спасти (включая себя в пределах лимита).",
      detective:
        "🕵️ Ты — Детектив. Ночью можешь либо проверить игрока, либо убить цель (только одно действие).",
      mayor:
        "🎩 Ты — Мэр. Твой дневной голос считается за 2.",
      bodyguard:
        "🛡️ Ты — Телохранитель. Защищай цель; если мафия атакует её, ты принимаешь удар.",
      jester:
        "🤡 Ты — Шут. Если тебя казнят голосованием — ты выигрываешь мгновенно.",
      town:
        "👤 Ты — Мирный житель. Найди мафию и казни её днём.",
      lucky:
        "🍀 Ты — Счастливчик. Каждую ночь у тебя 50% шанс выжить при убийстве.",
      bum:
        "🧴 Ты — Бомж. Ночью заходишь к игроку; если его убьют, ты увидишь убийцу.",
      sergeant:
        "🎖️ Ты — Сержант. Детектив делится с тобой результатами. Если детектив погибнет, ты получишь его действия.",
      lawyer:
        "⚖️ Ты — Адвокат. Ночью защищаешь игрока; если защищаешь мафию, детектив видит её как мирную. Твоя цель — победа мафии.",
      stalker:
        "🎯 Ты — Сталкер. У тебя контракт на роль. Убей цель лично, чтобы получить победу.",
    },
    time: {
      sec: "{seconds} сек.",
      min: "{minutes} мин.",
      min_sec: "{minutes} мин {seconds} сек.",
    },
    button: {
      join: "➕ Войти",
      leave: "➖ Выйти",
      start: "▶️ Старт",
      extend: "⏳ Продлить +2м",
      end: "⏹️ Завершить",
      ready: "✅ Готов",
      abstain: "🤐 Воздержаться",
      no_kill: "🛑 Не убивать",
      role_help: "ℹ️ Что делать?",
      detective_check: "🔍 Проверить",
      detective_kill: "🎯 Убить",
      prev: "◀️ Назад",
      next: "▶️ Вперёд",
      page: "📄 Стр. {page}/{total}",
      help_add: "➕ Как добавить бота",
      help_commands: "📜 Команды",
      help_settings: "⚙️ Настройки",
      find_games: "🔎 Найти игры",
      my_channels: "🗂️ Мои каналы",
      faq: "❓ FAQ",
      back: "⬅️ Назад",
      public: "🌐 Публичный",
      private: "🔒 Частный",
      filter_active: "🟢 Активные",
      filter_recruiting: "🟡 В наборе",
      filter_inactive: "⚪ Не активные",
      filter_lang_all: "🌍 Все",
      filter_lang_en: "🇬🇧 ENG",
      filter_lang_ru: "🇷🇺 RU",
      lang_en: "🇬🇧 English",
      lang_ru: "🇷🇺 Русский",
    },
    dashboard: {
      title: "🧭 Панель игры",
      phase: "🧭 Фаза: {phase}",
      timer: "⏳ Таймер: {time}",
      alive: "🧍 Живые ({count}): {list}",
      ready: "✅ Готовы: {ready}/{total}",
    },
    home: {
      title: "🏠 MafiaBot",
      tagline: "🎮 Ваш центр управления мафией в Slack. (Разработчик: @bob)",
      quickstart:
        "*🚀 Быстрый старт*\n" +
        "1️⃣ Добавьте меня в канал: `/invite @MafiaBot`\n" +
        "2️⃣ Создайте лобби: `@MafiaBot create`\n" +
        "3️⃣ Игроки жмут `Join`, хост жмёт `Start` или все `Ready`",
      controls:
        "*🧩 Управление лобби*\n" +
        "- Кнопки: `Join`, `Leave`, `Ready`, `Start`, `Extend`, `End`\n" +
        "- Команды: `@MafiaBot join`, `leave`, `start`, `extend 2`, `status`, `config`",
      gameplay:
        "*🌙 Во время игры*\n" +
        "- Ночные действия и дневное голосование приходят в личку\n" +
        "- `whisper <текст>` в личке раз в день\n" +
        "- После смерти есть «последние слова» в личке",
      features:
        "*✨ Возможности*\n" +
        "- Роли: Мафия, Доктор, Детектив, Мэр, Телохранитель, Шут, Крёстный отец, Счастливчик, Бомж, Сержант, Адвокат, Сталкер\n" +
        "- Анонимные голосования, авто‑таймеры, сохранение в SQLite\n" +
        "- Комната мафии + кладбище (если есть права)",
      tips:
        "*💡 Подсказки*\n" +
        "- Если несколько игр, указывайте `#channel` в личных командах\n" +
        "- Смена языка в личке: `lang en` / `lang ru`\n" +
        "- Редактирование настроек: `Мои каналы` в личке\n" +
        "- Открыть FAQ: `FAQ` в личке",
      stats_title: "📊 Ваша статистика",
      stats_line:
        "Игры: {games} • Победы: {wins} • Поражения: {losses} • Винрейт: {rate}%",
      channel_stats_title: "🧩 В этом канале",
      channel_stats_line:
        "Игры: {games} • Победы: {wins} • Поражения: {losses} • Винрейт: {rate}%",
      role_stats_title: "🎭 Статистика по ролям",
      role_stats_empty: "ℹ️ Пока нет статистики по ролям.",
      current_title: "🕹️ Текущая игра",
      current_none: "ℹ️ Активной игры нет.",
      current_line:
        "Канал: {channel}\n" +
        "Фаза: {phase}\n" +
        "Таймер: {time}\n" +
        "Живые: {alive}\n" +
        "Вы: {status}\n" +
        "Роль: {role}",
      status_alive: "✅ Жив",
      status_dead: "❌ Выбыли",
      role_unknown: "ℹ️ Неизвестно",
      history_title: "🌙 Последние 3 ночи",
      history_empty: "ℹ️ Пока нет итогов ночи.",
      history_line: "🌙 Ночь {round}: {text}",
    },
    find: {
      prompt_public: "ℹ️ Сделать {channel} публичным в «Найти игры»?",
      set_public: "✅ {channel} теперь публичный в «Найти игры».",
      set_private: "ℹ️ {channel} приватный и не будет отображаться.",
      private_not_allowed:
        "❌ Приватные каналы нельзя показывать в «Найти игры».",
      title: "🔎 Найти игры",
      empty: "ℹ️ Нет каналов для этого фильтра.",
      status_active: "🟢 Активна — {phase} {round} • Живых {alive}",
      status_recruiting: "🟡 В наборе — {count}/{min}, старт через {time}",
      status_inactive: "⚪ Не активна — игра не идёт",
      filters: "🎛️ Фильтр:",
      filter_lang: "🌐 Язык:",
      lang_label_en: "🇬🇧 ENG",
      lang_label_ru: "🇷🇺 RU",
    },
    faq: {
      title: "❓ FAQ",
      intro:
        "ℹ️ Выберите вопрос ниже. Можно написать в личку `faq <id>`, чтобы открыть конкретный ответ.",
      id_label: "🔗 FAQ ID: `faq {id}`",
      not_found: "⚠️ Вопрос не найден. Открываю список FAQ.",
      command_open: "❓ Открыть FAQ:",
      command_detail: "❓ Открыть вопрос FAQ `{id}`:",
      open_button: "❓ Открыть FAQ",
    },
    my_channels: {
      title: "🗂️ Мои каналы",
      empty: "ℹ️ Пока нет каналов.",
      status_public: "🌐 Публичный",
      status_private: "🔒 Частный",
      not_owner: "❌ Вы не владелец этого канала.",
      saved: "✅ Настройки канала сохранены.",
      edit_intro: "⚙️ Настройка {channel}",
    },
    settings: {
      title: "⚙️ Настройки канала",
      privacy_label: "🔎 Видимость в «Найти игры»",
      privacy_public: "🌐 Публичный",
      privacy_private: "🔒 Частный",
      channel_lang: "🌐 Язык канала",
      channel_lang_en: "English (ENG)",
      channel_lang_ru: "Русский (RU)",
      day_minutes: "☀️ День (мин.)",
      night_minutes: "🌙 Ночь (мин.)",
      lobby_minutes: "🧩 Лобби (мин.)",
      min_players: "👥 Минимум игроков",
      extend_policy: "🧩 Кто может продлевать?",
      extend_host: "👑 Только хост",
      extend_any: "👥 Все",
      warning_1: "⚠️ Предупреждение #1 (сек.)",
      warning_2: "⚠️ Предупреждение #2 (сек.)",
      auto_shorten: "⏱️ Автосокращение фазы",
      whisper_enabled: "💬 Шёпот включён",
      allow_abstain: "🤐 Разрешить воздержание",
      allow_no_kill: "🛑 Разрешить «без убийства»",
      doctor_self_save: "🧑‍⚕️ Лимит self‑save",
      toggle_on: "✅ Вкл",
      toggle_off: "❌ Выкл",
      submit: "✅ Сохранить",
      cancel: "❌ Отмена",
      invalid_number: "⚠️ Введите корректное число.",
      invalid_min_players: "⚠️ Минимум игроков должен быть >= 4.",
      invalid_warning: "⚠️ Предупреждения должны быть > 0.",
      invalid_self_save: "⚠️ Лимит self‑save должен быть >= 0.",
    },
    dm: {
      lang_prompt:
        "🌐 Выберите язык кнопками ниже. Позже можно изменить командой `lang en` / `lang ru`.",
      lang_set_en: "✅ Language set to English.",
      lang_set_ru: "✅ Язык установлен: русский.",
      lang_usage: "ℹ️ Использование: `lang en` или `lang ru`.",
      lang_change_command:
        "ℹ️ Язык уже установлен. Измените его командой `lang en` / `lang ru`.",
      help_intro:
        "👋 Привет! Я MafiaBot.\n" +
        "🚀 Как начать:\n" +
        "1) Добавьте меня в нужный канал: `/invite @MafiaBot`\n" +
        "2) В канале создайте лобби: `@MafiaBot create` (или кнопка)\n" +
        "3) Игроки заходят через `Join`, хост запускает `Start`\n" +
        "💡 Если у вас несколько игр, указывайте канал в личке: `vote @user #channel`\n" +
        "💬 Личка: `whisper <текст>` (раз в день)\n" +
        "🌐 Смена языка: `lang en` / `lang ru`.\n" +
        "🔎 Поиск игр: кнопка `Найти игры` в личке.\n" +
        "🗂️ Кнопка `Мои каналы` — редактирование настроек.\n" +
        "❓ Кнопка `FAQ` — ответы на частые вопросы.",
      help_add:
        "➕ Чтобы добавить меня в канал:\n" +
        "1) Откройте нужный канал\n" +
        "2) Напишите `/invite @MafiaBot`\n" +
        "Далее создайте лобби командой `@MafiaBot create` или кнопкой.",
      help_commands:
        "📜 Команды в канале:\n" +
        "- `@MafiaBot create` — создать лобби\n" +
        "- `@MafiaBot join` / `leave`\n" +
        "- `@MafiaBot start` — старт (хост)\n" +
        "- `@MafiaBot extend 2` — продлить лобби\n" +
        "- `@MafiaBot status`, `config`, `end`\n" +
        "💬 Личка: `whisper <текст>` (раз в день)\n" +
        "🌐 Смена языка: `lang en` / `lang ru`.\n" +
        "🔎 Поиск игр: кнопка `Найти игры` в личке.\n" +
        "🗂️ Мои каналы: `mychannels` в личке.\n" +
        "🗂️ Кнопка `Мои каналы` — редактирование настроек.\n" +
        "❓ Кнопка `FAQ` — ответы на частые вопросы.",
      help_settings:
        "⚙️ Настройки (только в лобби):\n" +
        "- `@MafiaBot config day 5`\n" +
        "- `@MafiaBot config night 2`\n" +
        "- `@MafiaBot config lobby 5`\n" +
        "- `@MafiaBot config min 4`\n" +
        "- `@MafiaBot config extend host|any`\n" +
        "🌐 Смена языка: `lang en` / `lang ru`.\n" +
        "🔎 Поиск игр: кнопка `Найти игры` в личке.\n" +
        "🗂️ Кнопка `Мои каналы` — редактирование настроек.\n" +
        "❓ Кнопка `FAQ` — ответы на частые вопросы.",
    },
    dev: {
      panel: {
        title: "🛠️ Панель разработчика",
        status_on: "🟢 Обновление: ВКЛ",
        status_off: "🔴 Обновление: ВЫКЛ",
        button_enable: "🛠️ Включить обновление",
        button_disable: "🛠️ Выключить обновление",
      },
      not_authorized: "❌ У вас нет доступа к командам разработчика.",
      code_invalid: "❌ Неверный код разработчика.",
      help: "🛠️ Dev: `dev <code>` • `test setup #channel Alice,Bob` • `as Alice vote Bob`",
    },
    maintenance: {
      reply: "⏳ MafiaBot обновляется и скоро вернётся.",
      blocked: "⚠️ Идёт обновление. Новые лобби временно недоступны.",
      lobby_closed: "⚠️ Лобби закрыто из‑за обновления.",
      done: "✅ Все активные игры завершены. Можно обновлять бота.",
    },
    last_words: {
      prompt:
        "🕯️ Вы выбыли. Напишите одно последнее сообщение в течение 2 минут — оно будет опубликовано в {channel}.",
      received: "✅ Ваши последние слова опубликованы.",
      expired: "⏳ Время вышло. Последние слова не отправлены.",
      post: "🕯️ Последние слова от {name}: {text}",
    },
    dead: {
      no_talk: "🚫 Вы выбыли и не можете писать в этом канале.",
      message_deleted: "🚫 Вы выбыли и не можете писать в этом канале.",
    },
    graveyard: {
      unavailable:
        "⚠️ Кладбище недоступно (нет прав на создание/приглашение).",
    },
    mafia_room: {
      intro: "🕶️ Мафия‑комната создана. Обсуждайте здесь ночью.",
    },
    whisper: {
      usage: "ℹ️ Использование: `whisper <текст>`",
      not_day: "⚠️ Шёпот доступен только днём.",
      disabled: "🚫 Шёпот отключён для этого канала.",
      already_used: "⚠️ Вы уже использовали шёпот сегодня.",
      sent: "✅ Ваш шёпот отправлен анонимно.",
      post: "💬 Анонимный шёпот: {text}",
    },
    lobby: {
      title: "🧩 Лобби мафии",
      host: "👑 Хост: {host}",
      players: "👥 Игроки: {count}/{min}",
      ready: "✅ Готовы: {ready}/{total}",
      start_in: "⏳ Старт через: {time}",
      created:
        "🧩 Создано лобби. Хост: {host}. Присоединяйтесь через `@MafiaBot join` или кнопку.",
      joined: "➕ {user} присоединился. Игроков: {count}",
      left: "➖ {user} вышел. Игроков: {count}",
      empty_closed: "ℹ️ Лобби пустое. Игра удалена.",
      closed_not_enough:
        "⚠️ Лобби закрыто: нужно минимум {min} игроков, сейчас {count}.",
      timeout_start: "⏳ Время лобби истекло. Начинаем игру!",
      host_start: "▶️ Хост запускает игру.",
      ready_start: "✅ Все игроки готовы. Начинаем игру!",
      extended: "⏳ Лобби продлено на {minutes} мин.",
      closed: "❌ Лобби закрыто.",
      starting: "▶️ Лобби закрыто. Игра стартует.",
      end: "⏹️ Игра завершена.",
      panel_summary: "🧩 Лобби: игроков {count}/{min}.",
    },
    warn: {
      day: "⚠️ До конца дня осталось {seconds} сек.",
      night: "⚠️ До конца ночи осталось {seconds} сек.",
      lobby: "⚠️ До автозапуска лобби осталось {seconds} сек.",
      shortened_day: "⚡ День сокращён из‑за высокой активности.",
      shortened_night: "⚡ Ночь сокращена из‑за высокой активности.",
    },
    reminder: {
      night_action: "ночное действие 🌙",
      vote: "голосование 🗳️",
      text: "🔔 Напоминание: завершите {action} для игры в {channel}.",
    },
    phase: {
      night_start: "🌙 Ночь {round}. Город засыпает...",
      day_start: "☀️ День {round}. Город просыпается...",
    },
    night: {
      ended_killed: "🌙 Ночь окончена. Убиты: {targets}.",
      ended_none: "🌙 Ночь окончена. Никто не погиб.",
      bodyguard: "🛡️ Телохранитель принял удар на себя.",
    },
    day: {
      ended_executed: "🗳️ Голосование завершено. Казнен: {target} ({role}).",
      ended_tie: "🗳️ Голосование завершено. Ничья, никто не казнен.",
    },
    auto: {
      applied: "🤖 Автодействия применены.",
    },
    winner: {
      mafia: "🏆 Победа мафии!",
      town: "🏆 Победа мирных!",
      jester: "🏆 Победа шута!",
      summary: "{winner}\nМафия: {mafia}\nМирные: {town}",
      summary_jester: "{winner}\nШут: {jester}\nМафия: {mafia}\nМирные: {town}",
    },
    prompt: {
      mafia: "😈 Игра в {channel}. Выберите цель для мафии.",
      doctor: "🧑‍⚕️ Игра в {channel}. Кого спасти этой ночью?",
      detective_mode: "🕵️ Выберите действие на эту ночь:",
      detective: "🕵️ Игра в {channel}. Кого проверить?",
      detective_kill: "🎯 Игра в {channel}. Кого убить?",
      bodyguard: "🛡️ Игра в {channel}. Кого защищать?",
      bum: "🧴 Игра в {channel}. К кому зайти этой ночью?",
      lawyer: "⚖️ Игра в {channel}. Кого защищать?",
      stalker: "🎯 Контракт: {role}. Выберите цель.",
      day: "🗳️ Игра в {channel}. Ваш голос за исключение.",
    },
    select: {
      player: "👤 Выберите игрока",
      target: "🎯 Выберите цель",
    },
    help: {
      commands:
        "ℹ️ Команды: create, join, leave, start, status, end, config, extend. Голосование и ночные действия приходят в личку.",
    },
    config: {
      summary:
        "⚙️ Настройки: day={day}m, night={night}m, lobby={lobby}m, min={min}, extend={extend}",
    },
    status: {
      text: "ℹ️ Статус: {state}. Хост: {host}. Живые: {alive}",
    },
    state: {
      lobby: "🧩 лобби",
      day: "☀️ день",
      night: "🌙 ночь",
      ended: "🏁 завершено",
    },
    err: {
      channel_unknown: "❌ Не удалось определить канал.",
      already_in_other: "❌ Вы уже находитесь в лобби или игре в {channel}.",
      lobby_not_active: "⚠️ Лобби не активно.",
      lobby_exists: "⚠️ Игра уже создана в этом канале.",
      lobby_none: "❌ Сейчас нет лобби. Создайте: @MafiaBot create",
      already_in: "⚠️ Вы уже в игре.",
      lobby_only: "❌ Покинуть можно только лобби.",
      not_in_lobby: "❌ Вас нет в лобби.",
      lobby_start_none: "⚠️ Нет активного лобби для старта.",
      only_host_start: "❌ Запускать игру может только хост.",
      need_min_players: "⚠️ Нужно минимум {min} игроков.",
      game_not_created: "❌ Игра не создана.",
      config_lobby_only: "⚠️ Настройка доступна только в лобби.",
      config_host_only: "❌ Настраивать игру может только хост.",
      config_usage_extend: "ℹ️ Использование: @MafiaBot config extend host|any",
      config_usage_numbers:
        "ℹ️ Использование: @MafiaBot config day 5 | night 2 | lobby 5 | min 4",
      config_options: "ℹ️ Доступные настройки: day, night, lobby, min, extend",
      extend_lobby_only: "⚠️ Продлевать можно только в лобби.",
      extend_not_allowed: "❌ Продлевать может только хост или участник по настройке.",
      no_active_game: "⚠️ Нет активной игры.",
      only_host_end: "❌ Завершить игру может только хост.",
      unknown_command: "❌ Неизвестная команда. Напишите @MafiaBot help",
    },
    ok: {
      settings_updated: "✅ Настройки обновлены.",
    },
    action: {
      role_dm: "🎭 Ваша роль в игре {channel}: *{role}*.",
      failed: "❌ Не удалось обработать выбор.",
      game_ended: "⚠️ Игра уже завершена.",
      not_in_game: "❌ Вы не участвуете или выбыли.",
      not_day: "⚠️ Сейчас не день.",
      choose_alive: "ℹ️ Нужно выбрать живого игрока.",
      already_acted: "⚠️ Вы уже сделали действие в этой фазе.",
      already_voted: "⚠️ Ваш голос уже зафиксирован.",
      vote_recorded: "✅ Ваш голос учтен: {target}.",
      vote_abstain: "✅ Вы воздержались.",
      not_night: "⚠️ Сейчас не ночь.",
      mafia_only: "❌ Команда доступна только мафии.",
      no_mafia_target: "⚠️ Нельзя выбрать мафию.",
      abstain_disabled: "🚫 Воздержание отключено в этом канале.",
      no_kill_disabled: "🚫 «Без убийства» отключено в этом канале.",
      choice_recorded: "✅ Ваш выбор: {target}.",
      no_kill: "✅ Ваш выбор: не убивать.",
      doctor_only: "❌ Команда доступна только доктору.",
      detective_only: "❌ Команда доступна только детективу.",
      bodyguard_only: "❌ Команда доступна только телохранителю.",
      bum_only: "❌ Команда доступна только Бомжу.",
      lawyer_only: "❌ Команда доступна только Адвокату.",
      stalker_only: "❌ Команда доступна только Сталкеру.",
      doctor_self_save_limit: "⚠️ Себя можно спасать только один раз за игру.",
      doctor_save: "✅ Вы спасаете: {target}.",
      detective_check: "✅ Вы проверяете: {target}.",
      detective_kill: "✅ Вы убиваете: {target}.",
      detective_result: "ℹ️ Результат проверки: {target} — {result}.",
      bodyguard_protect: "✅ Вы защищаете: {target}.",
      bum_visit: "✅ Вы заходите к: {target}.",
      lawyer_protect: "✅ Вы защищаете: {target}.",
      stalker_kill: "✅ Вы охотитесь на: {target}.",
      result_mafia: "😈 мафия",
      result_not_mafia: "👤 не мафия",
    },
    bum: {
      witness: "🧴 Вы стали свидетелем убийства: {killer} убил {victim}.",
      nothing: "🧴 Сегодня вы ничего не увидели.",
    },
    stalker: {
      target_assigned: "🎯 Ваша цель по роли: {role}.",
      success: "🏆 Контракт выполнен! Побед: {wins}. Новая цель: {role}.",
      failed: "⚠️ Контракт провален. Новая цель: {role}.",
      no_targets: "⚠️ Нет доступных ролей для цели.",
    },
    sergeant: {
      promoted: "🎖️ Детектив погиб. Теперь его действия доступны вам.",
      info: "🎖️ Результат детектива: {target} — {result}.",
    },
    dm_cmd: {
      no_game: "⚠️ Нет активной игры для этой команды.",
      need_alive: "ℹ️ Нужно указать живого игрока.",
      day_only: "⚠️ Дневные действия доступны только днём.",
      night_only: "⚠️ Ночные действия доступны только ночью.",
      mafia_only: "❌ Команда доступна только мафии.",
      no_mafia_target: "⚠️ Нельзя выбрать мафию.",
      doctor_only: "❌ Команда доступна только доктору.",
      detective_only: "❌ Команда доступна только детективу.",
      bodyguard_only: "❌ Команда доступна только телохранителю.",
      bum_only: "❌ Команда доступна только Бомжу.",
      lawyer_only: "❌ Команда доступна только Адвокату.",
      stalker_only: "❌ Команда доступна только Сталкеру.",
      doctor_self_save_limit: "⚠️ Себя можно спасать только один раз за игру.",
      vote_recorded: "✅ Ваш голос учтен: {target}.",
      choice_recorded: "✅ Ваш выбор: {target}.",
      doctor_save: "✅ Вы спасаете: {target}.",
      detective_check: "✅ Вы проверяете: {target}.",
      detective_kill: "✅ Вы убиваете: {target}.",
      detective_result: "ℹ️ Результат проверки: {target} — {result}.",
      result_mafia: "😈 мафия",
      result_not_mafia: "👤 не мафия",
      bodyguard_protect: "✅ Вы защищаете: {target}.",
      bum_visit: "✅ Вы заходите к: {target}.",
      lawyer_protect: "✅ Вы защищаете: {target}.",
      stalker_kill: "✅ Вы охотитесь на: {target}.",
      unknown_command:
        "❌ Команда не распознана. Используйте kill/save/check/protect/visit/defend/stalk @user.",
    },
    test: {
      not_dev: "❌ Только разработчик может использовать тест‑команды.",
      setup_usage: "ℹ️ Использование: `test setup #channel Alice,Bob,Charlie`",
      list_usage: "ℹ️ Использование: `test list #channel`",
      setup_ok:
        "✅ 🧪 Тестовое лобби готово в {channel}. Игроки: {players}\nКоманда: `as <name> <action>`.",
      duplicate_names: "❌ Повторяющиеся имена: {names}.",
      active_game: "⚠️ Нельзя включить тест‑режим во время активной игры.",
      real_players:
        "⚠️ Уберите реальных игроков из лобби перед включением тест‑режима.",
      no_game: "⚠️ Тестовая игра не найдена. Используйте `test setup` или укажите #channel.",
      list: "🧪 Тестовые игроки в {channel}: {players}",
      as_usage: "ℹ️ Использование: `as <name> <action> [target]`",
      actor_not_found: "❌ Тестовый игрок `{name}` не найден.",
      target_not_found: "❌ Цель не найдена: `{name}`.",
      roles_summary: "🧪 *Роли тест‑игроков* в {channel}:\n{list}",
      actions_reminder_night:
        "🌙 *Тест‑действия (ночь)* в {channel}:\n{list}\nКоманда: `as <name> <action> <target>`",
      actions_reminder_day:
        "☀️ *Тест‑действия (день)* в {channel}:\n{list}\nКоманда: `as <name> vote <target>` или `as <name> abstain`",
    },
  },
};

const FAQ_ITEMS = [
  {
    id: "add-bot",
    q: {
      en: "How do I add the bot to a channel?",
      ru: "Как добавить бота в канал?",
    },
    a: {
      en:
        "Open the channel and type `/invite @MafiaBot`. The bot must be in the channel to run a game.",
      ru:
        "Откройте канал и напишите `/invite @MafiaBot`. Бот должен быть в канале, чтобы вести игру.",
    },
  },
  {
    id: "create-lobby",
    q: {
      en: "How do I create a lobby?",
      ru: "Как создать лобби?",
    },
    a: {
      en:
        "In the channel: `@MafiaBot create` (or use the lobby buttons). The creator becomes the host.",
      ru:
        "В канале: `@MafiaBot create` (или кнопки лобби). Создатель становится хостом.",
    },
  },
  {
    id: "join-leave",
    q: {
      en: "How do players join or leave?",
      ru: "Как игрокам войти или выйти?",
    },
    a: {
      en:
        "Press `Join` / `Leave` in the lobby panel or use `@MafiaBot join` / `leave`.",
      ru:
        "Нажмите `Войти` / `Выйти` в панели лобби или используйте `@MafiaBot join` / `leave`.",
    },
  },
  {
    id: "ready",
    q: {
      en: "What does Ready do?",
      ru: "Что делает кнопка «Готов»?",
    },
    a: {
      en:
        "When all players are Ready and minimum players is reached, the game auto-starts.",
      ru:
        "Если все нажали «Готов» и достигнут минимум игроков, игра стартует автоматически.",
    },
  },
  {
    id: "start-game",
    q: {
      en: "How do I start the game?",
      ru: "Как начать игру?",
    },
    a: {
      en:
        "The host presses `Start` in the lobby panel or uses `@MafiaBot start`.",
      ru:
        "Хост нажимает `Старт` в панели лобби или пишет `@MafiaBot start`.",
    },
  },
  {
    id: "lobby-timer",
    q: {
      en: "How long does the lobby last and how to extend it?",
      ru: "Сколько длится лобби и как его продлить?",
    },
    a: {
      en:
        "Default is 5 minutes. Use `Extend +2m` or `@MafiaBot extend 2` (host or allowed).",
      ru:
        "По умолчанию 5 минут. Используйте `Продлить +2м` или `@MafiaBot extend 2` (хост или разрешённые).",
    },
  },
  {
    id: "night-actions",
    q: {
      en: "How do night actions work?",
      ru: "Как работают ночные действия?",
    },
    a: {
      en:
        "At night the bot sends DMs with buttons for mafia/doctor/detective/bodyguard. Choices are private.",
      ru:
        "Ночью бот отправляет личные сообщения с кнопками для мафии/доктора/детектива/телохранителя. Выборы приватные.",
    },
  },
  {
    id: "day-vote",
    q: {
      en: "How does daytime voting work?",
      ru: "Как работает дневное голосование?",
    },
    a: {
      en:
        "During the day each alive player receives a DM with vote buttons. Votes are anonymous.",
      ru:
        "Днём каждый живой получает личку с кнопками голосования. Голосование анонимное.",
    },
  },
  {
    id: "roles",
    q: {
      en: "What roles exist in this bot?",
      ru: "Какие роли есть в этом боте?",
    },
    a: {
      en:
        "Main roles: Mafia, Doctor, Detective, Mayor, Bodyguard, Jester, Godfather, Lucky, Bum, Sergeant, Lawyer, Stalker, Town.",
      ru:
        "Основные роли: Мафия, Доктор, Детектив, Мэр, Телохранитель, Шут, Крёстный отец, Счастливчик, Бомж, Сержант, Адвокат, Сталкер, Мирный.",
    },
  },
  {
    id: "mafia-room",
    q: {
      en: "What is the mafia room?",
      ru: "Что такое комната мафии?",
    },
    a: {
      en:
        "If permissions allow, the bot creates a private mafia chat (MPIM) for discussion at night.",
      ru:
        "Если права позволяют, бот создаёт приватный чат мафии (MPIM) для обсуждения ночью.",
    },
  },
  {
    id: "graveyard",
    q: {
      en: "What is the graveyard?",
      ru: "Что такое кладбище?",
    },
    a: {
      en:
        "A private channel for eliminated players. If permissions allow, the bot invites dead players there.",
      ru:
        "Приватный канал для выбывших. Если права позволяют, бот приглашает туда мёртвых.",
    },
  },
  {
    id: "last-words",
    q: {
      en: "What are last words?",
      ru: "Что такое «последние слова»?",
    },
    a: {
      en:
        "After elimination, you get 2 minutes to send one DM. It will be posted in the game channel.",
      ru:
        "После выбывания даётся 2 минуты, чтобы отправить одно сообщение в личку. Оно будет опубликовано в канале.",
    },
  },
  {
    id: "whisper",
    q: {
      en: "What is Whisper?",
      ru: "Что такое «шёпот»?",
    },
    a: {
      en:
        "Once per day you can DM `whisper <text>` and it will be posted anonymously in the channel.",
      ru:
        "Раз в день можно написать в личку `whisper <текст>` — сообщение появится анонимно в канале.",
    },
  },
  {
    id: "find-games",
    q: {
      en: "What is Find Games?",
      ru: "Что такое «Найти игры»?",
    },
    a: {
      en:
        "It lists public channels where the bot was marked as Public. Use the `Find games` button in DM.",
      ru:
        "Это список публичных каналов, где бот помечен как Public. Откройте кнопкой `Найти игры` в личке.",
    },
  },
  {
    id: "privacy",
    q: {
      en: "Public vs Private listing — what does it mean?",
      ru: "Публичный/Частный список — что это значит?",
    },
    a: {
      en:
        "Public channels appear in Find Games. Private channels are hidden and cannot be listed.",
      ru:
        "Публичные каналы показываются в «Найти игры». Приватные скрыты и не могут быть в списке.",
    },
  },
  {
    id: "durations",
    q: {
      en: "What do Day/Night/Lobby minutes change?",
      ru: "Что меняют минуты дня/ночи/лобби?",
    },
    a: {
      en:
        "They set the default duration for each phase. Warnings are sent before the timer ends.",
      ru:
        "Это длительность каждой фазы. Предупреждения приходят заранее.",
    },
  },
  {
    id: "min-players",
    q: {
      en: "What is Minimum players?",
      ru: "Что такое минимум игроков?",
    },
    a: {
      en:
        "The game can start only when at least this number of players joined.",
      ru:
        "Игра стартует только когда набрано не меньше этого числа игроков.",
    },
  },
  {
    id: "extend-policy",
    q: {
      en: "Who can extend the lobby?",
      ru: "Кто может продлевать лобби?",
    },
    a: {
      en:
        "`Host only` means only the lobby host can extend. `Anyone` lets any player extend.",
      ru:
        "`Только хост` — продлевать может только хост. `Все` — может любой игрок лобби.",
    },
  },
  {
    id: "warnings",
    q: {
      en: "What are warnings?",
      ru: "Что такое предупреждения таймера?",
    },
    a: {
      en:
        "These are reminder times (in seconds) before a phase ends. Example: 60 and 30.",
      ru:
        "Это напоминания за X секунд до конца фазы. Например: 60 и 30.",
    },
  },
  {
    id: "auto-shorten",
    q: {
      en: "What is Auto‑shorten?",
      ru: "Что такое авто‑сокращение фаз?",
    },
    a: {
      en:
        "If most actions are done early, the bot shortens the remaining time to speed up the game.",
      ru:
        "Если большинство действий сделано, бот сокращает оставшееся время, чтобы ускорить игру.",
    },
  },
  {
    id: "abstain",
    q: {
      en: "What is Abstain?",
      ru: "Что такое «Воздержаться»?",
    },
    a: {
      en:
        "A voting option that counts as a vote cast, but does not target anyone.",
      ru:
        "Опция голосования: голос засчитывается, но без выбора цели.",
    },
  },
  {
    id: "no-kill",
    q: {
      en: "What is No‑kill for mafia?",
      ru: "Что такое «Без убийства» у мафии?",
    },
    a: {
      en:
        "Mafia can choose to skip killing at night. It can be used for strategy or bluff.",
      ru:
        "Мафия может пропустить убийство ночью. Это стратегический выбор/блеф.",
    },
  },
  {
    id: "doctor-self-save",
    q: {
      en: "Doctor self‑save limit — how it works?",
      ru: "Лимит self‑save доктора — как работает?",
    },
    a: {
      en:
        "The doctor can save themselves only a limited number of times (default 1).",
      ru:
        "Доктор может лечить себя ограниченное число раз (по умолчанию 1).",
    },
  },
  {
    id: "language",
    q: {
      en: "How do I change language?",
      ru: "Как сменить язык?",
    },
    a: {
      en: "In DM, use `lang en` or `lang ru`.",
      ru: "В личке используйте `lang en` или `lang ru`.",
    },
  },
  {
    id: "my-channels",
    q: {
      en: "What is My channels?",
      ru: "Что такое «Мои каналы»?",
    },
    a: {
      en:
        "A list of channels where you last changed privacy. Use it to edit default settings.",
      ru:
        "Список каналов, где вы последний меняли приватность. Там можно менять настройки по умолчанию.",
    },
  },
  {
    id: "channel-language",
    q: {
      en: "What is Channel language?",
      ru: "Что такое язык канала?",
    },
    a: {
      en:
        "It sets the language for channel announcements and the Find Games label.",
      ru:
        "Определяет язык канальных объявлений и метку в «Найти игры».",
    },
  },
  {
    id: "dm-not-working",
    q: {
      en: "Why doesn’t the bot DM me?",
      ru: "Почему бот не пишет в личку?",
    },
    a: {
      en:
        "Check that messages to apps are allowed in your Slack. If DM fails, the bot will post in the channel.",
      ru:
        "Проверьте, что в Slack разрешены сообщения от приложений. Если личка недоступна, бот пишет в канал.",
    },
  },
  {
    id: "remove-bot",
    q: {
      en: "How do I remove the bot from a channel?",
      ru: "Как удалить бота из канала?",
    },
    a: {
      en: "Use `/remove @MafiaBot` in the channel.",
      ru: "Напишите `/remove @MafiaBot` в канале.",
    },
  },
];

function getByPath(obj, key) {
  return key.split(".").reduce((acc, part) => (acc ? acc[part] : undefined), obj);
}

function t(lang, key, params = {}) {
  const safeLang = LANGS.includes(lang) ? lang : DEFAULT_LANG;
  const dict = I18N[safeLang] || I18N[DEFAULT_LANG];
  const template = getByPath(dict, key) || getByPath(I18N[DEFAULT_LANG], key) || key;

  return String(template).replace(/\{(\w+)\}/g, (match, name) => {
    if (params[name] === undefined || params[name] === null) return "";
    return String(params[name]);
  });
}

function normalizeLang(lang) {
  return lang === "ru" ? "ru" : "en";
}

function getUserLangInfo(userId) {
  if (userLangCache.has(userId)) return userLangCache.get(userId);
  const row = selectUserLangStmt.get(userId);
  const info = row?.lang
    ? { lang: normalizeLang(row.lang), explicit: true }
    : { lang: DEFAULT_LANG, explicit: false };
  userLangCache.set(userId, info);
  return info;
}

function getUserLang(userId) {
  return getUserLangInfo(userId).lang;
}

function isDevUser(userId) {
  return Boolean(DEV_USER_ID && userId && userId === DEV_USER_ID);
}

function isDevCode(code) {
  return Boolean(DEV_CODE && code && code === DEV_CODE);
}

function getDefaultMaintenanceState() {
  return { enabled: false, by: null, requested_at: null, notified: false };
}

function getMaintenanceState() {
  if (maintenanceCache) return maintenanceCache;
  const row = selectAppStateStmt.get("maintenance");
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

function setMaintenanceState(state) {
  const next = { ...getDefaultMaintenanceState(), ...state };
  maintenanceCache = next;
  upsertAppStateStmt.run("maintenance", JSON.stringify(next), now());
  return next;
}

function isMaintenanceEnabled() {
  return getMaintenanceState().enabled;
}

function setUserLang(userId, lang) {
  const normalized = normalizeLang(lang);
  upsertUserLangStmt.run(userId, normalized, now());
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

function getUserStats(userId) {
  return normalizeStatsRow(selectUserStatsStmt.get(userId));
}

function getUserChannelStats(userId, channelId) {
  return normalizeStatsRow(selectUserChannelStatsStmt.get(userId, channelId));
}

function getUserRoleStats(userId) {
  return listUserRoleStatsStmt.all(userId).map((row) => ({
    role: row.role,
    ...normalizeStatsRow(row),
  }));
}

function updateUserStats(userId, isWin) {
  const current = getUserStats(userId);
  const next = {
    wins: current.wins + (isWin ? 1 : 0),
    losses: current.losses + (isWin ? 0 : 1),
    games: current.games + 1,
  };
  upsertUserStatsStmt.run(
    userId,
    next.wins,
    next.losses,
    next.games,
    now()
  );
}

function updateUserChannelStats(userId, channelId, isWin) {
  const current = getUserChannelStats(userId, channelId);
  const next = {
    wins: current.wins + (isWin ? 1 : 0),
    losses: current.losses + (isWin ? 0 : 1),
    games: current.games + 1,
  };
  upsertUserChannelStatsStmt.run(
    userId,
    channelId,
    next.wins,
    next.losses,
    next.games,
    now()
  );
}

function updateUserRoleStats(userId, role, isWin) {
  const current = normalizeStatsRow(selectUserRoleStatsStmt.get(userId, role));
  const next = {
    wins: current.wins + (isWin ? 1 : 0),
    losses: current.losses + (isWin ? 0 : 1),
    games: current.games + 1,
  };
  upsertUserRoleStatsStmt.run(
    userId,
    role,
    next.wins,
    next.losses,
    next.games,
    now()
  );
}

function incrementUserRoleStats(userId, role, winsDelta, lossesDelta, gamesDelta) {
  const current = normalizeStatsRow(selectUserRoleStatsStmt.get(userId, role));
  const next = {
    wins: current.wins + (winsDelta || 0),
    losses: current.losses + (lossesDelta || 0),
    games: current.games + (gamesDelta || 0),
  };
  upsertUserRoleStatsStmt.run(
    userId,
    role,
    next.wins,
    next.losses,
    next.games,
    now()
  );
}

function getChannelPref(channelId) {
  return selectChannelPrefStmt.get(channelId) || null;
}

function parseSettingsJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch (err) {
    return null;
  }
}

function getChannelSettings(channelId) {
  const pref = getChannelPref(channelId);
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

function ensureChannelPref(channelId, meta = {}) {
  const existing = getChannelPref(channelId);
  if (existing) return existing;
  upsertChannelPrefStmt.run(
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

function markChannelPrompted(channelId, meta = {}) {
  const existing = getChannelPref(channelId);
  const promptedAt = existing?.prompted_at || meta.promptedAt || now();
  const listed = existing?.listed || 0;
  const listedBy = existing?.listed_by || meta.listedBy || null;
  const channelType = meta.channelType || existing?.channel_type || null;
  const settingsJson = meta.settingsJson || existing?.settings_json || null;
  upsertChannelPrefStmt.run(
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

function setChannelListing(channelId, listed, meta = {}) {
  const existing = getChannelPref(channelId);
  const channelType = meta.channelType || existing?.channel_type || null;
  const promptedAt = existing?.prompted_at || meta.promptedAt || null;
  const listedBy = meta.listedBy || existing?.listed_by || null;
  const settingsJson = meta.settingsJson || existing?.settings_json || null;
  upsertChannelPrefStmt.run(
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

function listListedChannels() {
  return listListedChannelsStmt.all();
}

function listOwnedChannels(userId) {
  return listOwnedChannelsStmt.all(userId);
}

function setChannelSettings(channelId, settings, meta = {}) {
  const existing = getChannelPref(channelId);
  const listed = existing?.listed || 0;
  const channelType = meta.channelType || existing?.channel_type || null;
  const promptedAt = existing?.prompted_at || meta.promptedAt || null;
  const listedBy = meta.listedBy || existing?.listed_by || null;
  const settingsJson =
    typeof settings === "string" ? settings : JSON.stringify(settings);
  upsertChannelPrefStmt.run(
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

const dbPath =
  process.env.MAFIA_DB_PATH || path.join(__dirname, "..", "data", "mafia.db");
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.exec(`
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
`);

const channelPrefsColumns = db
  .prepare("PRAGMA table_info(channel_prefs)")
  .all()
  .map((row) => row.name);
if (!channelPrefsColumns.includes("settings_json")) {
  db.exec("ALTER TABLE channel_prefs ADD COLUMN settings_json TEXT");
}

const saveStmt = db.prepare(
  "INSERT INTO games (channel_id, state_json, phase_deadline, updated_at) VALUES (?, ?, ?, ?) " +
    "ON CONFLICT(channel_id) DO UPDATE SET state_json=excluded.state_json, phase_deadline=excluded.phase_deadline, updated_at=excluded.updated_at"
);
const deleteStmt = db.prepare("DELETE FROM games WHERE channel_id = ?");
const selectAllStmt = db.prepare("SELECT state_json FROM games");
const selectUserLangStmt = db.prepare(
  "SELECT lang FROM user_prefs WHERE user_id = ?"
);
const upsertUserLangStmt = db.prepare(
  "INSERT INTO user_prefs (user_id, lang, updated_at) VALUES (?, ?, ?) " +
    "ON CONFLICT(user_id) DO UPDATE SET lang=excluded.lang, updated_at=excluded.updated_at"
);
const selectChannelPrefStmt = db.prepare(
  "SELECT channel_id, listed, channel_type, updated_at, prompted_at, listed_by, settings_json FROM channel_prefs WHERE channel_id = ?"
);
const upsertChannelPrefStmt = db.prepare(
  "INSERT INTO channel_prefs (channel_id, listed, channel_type, updated_at, prompted_at, listed_by, settings_json) VALUES (?, ?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(channel_id) DO UPDATE SET listed=excluded.listed, channel_type=COALESCE(excluded.channel_type, channel_prefs.channel_type), updated_at=excluded.updated_at, prompted_at=COALESCE(excluded.prompted_at, channel_prefs.prompted_at), listed_by=COALESCE(excluded.listed_by, channel_prefs.listed_by), settings_json=COALESCE(excluded.settings_json, channel_prefs.settings_json)"
);
const listListedChannelsStmt = db.prepare(
  "SELECT channel_id, listed, channel_type, updated_at, settings_json FROM channel_prefs WHERE listed = 1 ORDER BY updated_at DESC"
);
const listOwnedChannelsStmt = db.prepare(
  "SELECT channel_id, listed, channel_type, updated_at, settings_json FROM channel_prefs WHERE listed_by = ? ORDER BY updated_at DESC"
);
const selectAppStateStmt = db.prepare("SELECT value FROM app_state WHERE key = ?");
const upsertAppStateStmt = db.prepare(
  "INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?) " +
    "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at"
);
const selectUserStatsStmt = db.prepare(
  "SELECT wins, losses, games FROM user_stats WHERE user_id = ?"
);
const upsertUserStatsStmt = db.prepare(
  "INSERT INTO user_stats (user_id, wins, losses, games, updated_at) VALUES (?, ?, ?, ?, ?) " +
    "ON CONFLICT(user_id) DO UPDATE SET wins=excluded.wins, losses=excluded.losses, games=excluded.games, updated_at=excluded.updated_at"
);
const selectUserChannelStatsStmt = db.prepare(
  "SELECT wins, losses, games FROM user_channel_stats WHERE user_id = ? AND channel_id = ?"
);
const upsertUserChannelStatsStmt = db.prepare(
  "INSERT INTO user_channel_stats (user_id, channel_id, wins, losses, games, updated_at) VALUES (?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(user_id, channel_id) DO UPDATE SET wins=excluded.wins, losses=excluded.losses, games=excluded.games, updated_at=excluded.updated_at"
);
const selectUserRoleStatsStmt = db.prepare(
  "SELECT wins, losses, games FROM user_role_stats WHERE user_id = ? AND role = ?"
);
const upsertUserRoleStatsStmt = db.prepare(
  "INSERT INTO user_role_stats (user_id, role, wins, losses, games, updated_at) VALUES (?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(user_id, role) DO UPDATE SET wins=excluded.wins, losses=excluded.losses, games=excluded.games, updated_at=excluded.updated_at"
);
const listUserRoleStatsStmt = db.prepare(
  "SELECT role, wins, losses, games FROM user_role_stats WHERE user_id = ? ORDER BY games DESC"
);

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
  const name = text.trim().split(/\s+/)[0];
  if (!name) return null;
  return resolveTestPlayerIdByName(game, name);
}

function mention(userId) {
  if (isTestUserId(userId)) return getTestPlayerName(userId);
  return `<@${userId}>`;
}

function channelMention(channelId) {
  return `<#${channelId}>`;
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

function saveGame(game) {
  saveStmt.run(
    game.channelId,
    serializeGame(game),
    game.phaseDeadline || null,
    now()
  );
}

function deleteGame(channelId) {
  deleteStmt.run(channelId);
}

function loadAllGames() {
  const rows = selectAllStmt.all();
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

function createLobby(channelId, hostId) {
  const createdAt = now();
  const game = {
    channelId,
    hostId,
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

  const rolesToAssign = [];
  for (let i = 0; i < mafiaCount; i += 1) rolesToAssign.push("mafia");
  if (includeStalker) rolesToAssign.push("stalker");
  rolesToAssign.push("doctor", "detective");

  const remainingSlots = Math.max(0, totalPlayers - rolesToAssign.length);
  const picked = pool.slice(0, Math.min(remainingSlots, pool.length));
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
  const userLang = getUserLang(userId);
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
  const lang = getUserLang(stalkerId);
  const roleText = role ? roleLabel(role, lang) : t(lang, "home.role_unknown");
  await sendInteractiveDM(client, stalkerId, t(lang, key, { role: roleText, wins: game.stalker?.wins || 0 }));
}

async function assignNewStalkerTarget(client, game, reasonKey) {
  if (!game.roles.stalkerId) return;
  const newRole = pickStalkerTargetRole(game);
  if (!game.stalker) game.stalker = { targetRole: null, wins: 0, losses: 0 };
  game.stalker.targetRole = newRole;
  saveGame(game);
  if (!newRole) {
    await notifyStalker(client, game, "stalker.no_targets");
    return;
  }
  await notifyStalker(client, game, reasonKey || "stalker.target_assigned", newRole);
}

function recordStalkerWin(game) {
  if (!game.roles.stalkerId) return;
  if (!game.stalker) game.stalker = { targetRole: null, wins: 0, losses: 0 };
  game.stalker.wins = (game.stalker.wins || 0) + 1;
  if (!isTestUserId(game.roles.stalkerId)) {
    incrementUserRoleStats(game.roles.stalkerId, "stalker", 1, 0, 1);
  }
}

function recordStalkerLoss(game) {
  if (!game.roles.stalkerId) return;
  if (!game.stalker) game.stalker = { targetRole: null, wins: 0, losses: 0 };
  game.stalker.losses = (game.stalker.losses || 0) + 1;
  if (!isTestUserId(game.roles.stalkerId)) {
    incrementUserRoleStats(game.roles.stalkerId, "stalker", 0, 1, 1);
  }
}

async function maybePromoteSergeant(client, game) {
  const sergeantId = game.roles.sergeantId;
  if (!sergeantId) return;
  if (game.roles.detectiveId && isPlayerAlive(game, game.roles.detectiveId)) return;
  if (!isPlayerAlive(game, sergeantId)) return;
  if (game.roles.detectiveId === sergeantId) return;
  game.roles.detectiveId = sergeantId;
  saveGame(game);
  if (!isTestUserId(sergeantId)) {
    const lang = getUserLang(sergeantId);
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
  if (!userInfoEnabled) return { label: userId, handle: null };
  if (userDisplayCache.has(userId)) return userDisplayCache.get(userId);

  try {
    const info = await client.users.info({ user: userId });
    const profile = info.user.profile || {};
    const label =
      profile.display_name || profile.real_name || info.user.name || userId;
    const handle = info.user.name || null;
    const result = { label, handle };
    userDisplayCache.set(userId, result);
    userCache.set(userId, label);
    return result;
  } catch (err) {
    if (err?.data?.error === "missing_scope") {
      userInfoEnabled = false;
    }
    return { label: userId, handle: null };
  }
}

async function getChannelInfo(client, channelId) {
  if (!channelInfoEnabled) return { name: channelId, is_private: null };
  if (channelInfoCache.has(channelId)) return channelInfoCache.get(channelId);
  try {
    const info = await client.conversations.info({ channel: channelId });
    const name = info.channel?.name || channelId;
    const isPrivate = Boolean(info.channel?.is_private);
    const result = { name, is_private: isPrivate };
    channelInfoCache.set(channelId, result);
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
    q: item.q?.[safeLang] || item.q?.[DEFAULT_LANG] || "",
    a: item.a?.[safeLang] || item.a?.[DEFAULT_LANG] || "",
  }));
}

function getFaqItemById(id, lang) {
  if (!id) return null;
  const safeLang = LANGS.includes(lang) ? lang : DEFAULT_LANG;
  const item = buildFaqItems().find((entry) => entry.id === id);
  if (!item) return null;
  return {
    id: item.id,
    q: item.q?.[safeLang] || item.q?.[DEFAULT_LANG] || "",
    a: item.a?.[safeLang] || item.a?.[DEFAULT_LANG] || "",
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
      text: { type: "plain_text", text: t(lang, "faq.title") },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: t(lang, "faq.intro") },
    },
  ];

  slice.forEach((item) => {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `• ❓ ${item.q}` },
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
        text: { type: "plain_text", text: `❓ ${question}` },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: `ℹ️ ${answer}` },
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
  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: t(lang, "home.title") },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: t(lang, "home.tagline") },
    },
    { type: "divider" },
  ];

  const stats = getUserStats(userId);
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

  const roleStats = getUserRoleStats(userId);
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

  const game = getUserCurrentGame(userId);
  if (!game) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: t(lang, "home.current_none") },
    });
  } else {
    const channelStats = getUserChannelStats(userId, game.channelId);
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

async function publishHomeForUser(client, userId) {
  if (!userId) return;
  const langInfo = getUserLangInfo(userId);
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
    .filter((id) => !isTestUserId(id));
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

  const text =
    `*${t(lang, "lobby.title")}*\n` +
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
    `${playerList}\n` +
    `${t(lang, "lobby.start_in", { time: remaining })}`;

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

function getFindEntries(filter, lang, langFilter) {
  const rows = listListedChannels();
  const entries = [];
  rows.forEach((row) => {
    const channelId = row.channel_id;
    if (row.channel_type === "group") return;
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

function buildFindGamesBlocks(lang, filter, page, langFilter) {
  const entries = getFindEntries(filter, lang, langFilter);
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
  const rows = listOwnedChannels(userId);
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
      text: { type: "plain_text", text: "?" },
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
  const existing = getChannelPref(channelId);
  if (existing?.prompted_at) return;

  markChannelPrompted(channelId, { channelType, listedBy: inviterId });

  let dmSent = false;
  if (inviterId) {
    const lang = getUserLang(inviterId);
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
  const convo = await client.conversations.open({ users: userId });
  const payload = {
    channel: convo.channel.id,
    text,
  };
  if (blocks) payload.blocks = blocks;
  await client.chat.postMessage(payload);
}

async function sendDevPanel(client, userId) {
  const lang = getUserLang(userId);
  const state = getMaintenanceState();
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
  const state = getMaintenanceState();
  if (!state.enabled || state.notified) return;
  if (!DEV_USER_ID) return;
  if (getActiveGames().length > 0) return;

  const lang = getUserLang(DEV_USER_ID);
  await sendInteractiveDM(client, DEV_USER_ID, t(lang, "maintenance.done"));
  setMaintenanceState({ ...state, notified: true });
}

async function closeAllLobbiesForMaintenance(client) {
  const lobbies = [...gameCache.values()].filter(
    (game) => game && game.state === "lobby"
  );
  for (const lobby of lobbies) {
    await withChannelLock(lobby.channelId, async () => {
      const game = getGame(lobby.channelId);
      if (!game || game.state !== "lobby") return;
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
  if (game.dashboardTs) {
    try {
      await client.chat.update({
        channel: game.channelId,
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
    channel: game.channelId,
    text,
  });
  game.dashboardTs = result?.ts || null;
  if (game.dashboardTs) {
    try {
      await client.pins.add({
        channel: game.channelId,
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
  try {
    await client.pins.remove({
      channel: game.channelId,
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
  const lang = getUserLang(userId);
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
  await client.chat.postMessage({ channel: channelId, text });
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
    await client.chat.postEphemeral({ channel: channelId, user: userId, text });
  } catch (err) {
    console.error("Failed to send ephemeral message:", err);
  }
}

async function notifyEphemeralLocalized(client, channelId, userId, key, params) {
  const lang = getUserLang(userId);
  await notifyEphemeral(client, channelId, userId, t(lang, key, params));
}

async function postOrUpdateLobbyPanel(client, game) {
  if (game.state !== "lobby") return;
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
        channel: game.channelId,
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
    channel: game.channelId,
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
  try {
    await client.chat.update({
      channel: game.channelId,
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
  const lang = getUserLang(userId);
  const convo = await client.conversations.open({ users: userId });
  await client.chat.postMessage({
    channel: convo.channel.id,
    text: t(lang, "reminder.text", {
      action: t(lang, `reminder.${actionKey}`),
      channel: channelMention(channelId),
    }),
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
  if (isMaintenanceEnabled()) {
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
  players.forEach((player) => {
    if (player.isTest) return;
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
    updateUserStats(player.id, isWin);
    updateUserChannelStats(player.id, game.channelId, isWin);
    if (role !== "stalker") {
      updateUserRoleStats(player.id, role, isWin);
    }
  });

  await finalizeDashboard(client, game);
  clearPhaseTimers(game.channelId);
  gameCache.delete(game.channelId);
  deleteGame(game.channelId);
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

  if (narrative?.text) {
    await announceToChannel(client, game.channelId, narrative.text);
  } else if (narrative) {
    await announceToChannelLocalized(client, game, narrative.key, narrative.paramsBuilder);
  } else {
    await announceToChannelLocalized(client, game, "phase.night_start", () => ({
      round: game.round,
    }));
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

  if (narrative?.text) {
    await announceToChannel(client, game.channelId, narrative.text);
  } else if (narrative) {
    await announceToChannelLocalized(client, game, narrative.key, narrative.paramsBuilder);
  } else {
    await announceToChannelLocalized(client, game, "phase.day_start", () => ({
      round: game.round,
    }));
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
      recordStalkerLoss(game);
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
        const bumLang = getUserLang(game.roles.bumId);
        await sendInteractiveDM(client, game.roles.bumId, t(bumLang, "bum.witness", {
          killer: mention(killerId),
          victim: mention(bumTarget),
        }));
      }
    } else if (bumTarget && !isTestUserId(game.roles.bumId)) {
      const bumLang = getUserLang(game.roles.bumId);
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
        recordStalkerWin(game);
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

  const dayStartText = t(channelLang, "phase.day_start", { round: game.round });
  await startDay(client, game, { text: `${summaryText}\n${dayStartText}` });
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
      recordStalkerLoss(game);
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

  const nextRound = game.round + 1;
  const nightStartText = t(channelLang, "phase.night_start", { round: nextRound });
  await startNight(client, game, { text: `${summaryText}\n${nightStartText}` });
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
  const mafiaTargets = listAliveNonMafiaIds(game);
  const aliveIds = getAlivePlayerIds(game);

  const mafiaChoices = await buildUserChoices(client, mafiaTargets);
  const aliveChoices = await buildUserChoices(client, aliveIds);
  for (const mafiaId of game.roles.mafiaIds) {
    if (!isPlayerAlive(game, mafiaId)) continue;
    if (isTestUserId(mafiaId)) continue;
    if (mafiaChoices.length === 0) continue;
    const lang = getUserLang(mafiaId);

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
      const lang = getUserLang(game.roles.doctorId);
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
      const lang = getUserLang(game.roles.detectiveId);
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
      const lang = getUserLang(game.roles.bodyguardId);
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
      const lang = getUserLang(game.roles.bumId);
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
      const lang = getUserLang(game.roles.lawyerId);
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
      const lang = getUserLang(game.roles.stalkerId);
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

async function sendDayPrompts(client, game) {
  const aliveIds = getAlivePlayerIds(game);
  const choices = await buildUserChoices(client, aliveIds);

  for (const userId of aliveIds) {
    if (isTestUserId(userId)) continue;
    const lang = getUserLang(userId);
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

  if (isMaintenanceEnabled()) {
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
        setUserLang(userId, choice);
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
        const channelSettings = getChannelSettings(channelId);
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
        const lang = getUserLang(userId);
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
  const lang = getUserLang(userId);
  const text = t(lang, "action.role_dm", {
    channel: channelMention(game.channelId),
    role: roleLabel(role, lang),
  });
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
  const lang = getUserLang(controllerId);
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
  const lang = getUserLang(controllerId);

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
    const actorLang = getUserLang(actorId);
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
    const actorLang = getUserLang(actorId);

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
          const serLang = getUserLang(sergeantId);
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
    const actorLang = getUserLang(actorId);
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

    if (isMaintenanceEnabled()) {
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
    const langInfo = getUserLangInfo(userId);

    if (langInfo.explicit) {
      await updateActionMessage(
        client,
        body,
        t(langInfo.lang, "dm.lang_change_command")
      );
      return;
    }

    setUserLang(userId, choice);
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
  const lang = getUserLang(userId);
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
    const lang = getUserLang(userId);
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
  const lang = getUserLang(userId);

  if (!isDevUser(userId)) {
    await updateActionMessage(client, body, t(lang, "dev.not_authorized"));
    return;
  }

  const state = getMaintenanceState();
  const enabled = !state.enabled;
  setMaintenanceState({
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
  const lang = getUserLang(userId);
  const convo = await client.conversations.open({ users: userId });
  const blocks = buildFindGamesBlocks(lang, "recruiting", 0, "all");
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
    const lang = getUserLang(userId);
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

    const blocks = buildFindGamesBlocks(lang, filter, page, langFilter);
    await updateActionMessage(client, body, t(lang, "find.title"), blocks);
  }
);

app.action(ACTIONS.FAQ_OPEN, async ({ ack, body, client }) => {
  await ack();
  const userId = body.user.id;
  const lang = getUserLang(userId);
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
    const lang = getUserLang(userId);
    const currentPage = getFaqPageFromView(body.view);
    const nextPage =
      action.action_id === ACTIONS.FAQ_PAGE_NEXT
        ? currentPage + 1
        : currentPage - 1;
    const view = buildFaqListView(lang, nextPage);
    if (body.view) {
      await client.views.update({
        view_id: body.view.id,
        hash: body.view.hash,
        view,
      });
      return;
    }
    await client.views.open({ trigger_id: body.trigger_id, view });
  }
);

app.action(ACTIONS.FAQ_TOPIC, async ({ ack, body, action, client }) => {
  await ack();
  const userId = body.user.id;
  const lang = getUserLang(userId);
  const faqId = action?.value;
  const page = body.view ? getFaqPageFromView(body.view) : 0;
  const item = getFaqItemById(faqId, lang);
  const view = item
    ? buildFaqDetailView(lang, item.id, page)
    : buildFaqListView(lang, 0);

  if (body.view) {
    if (isFaqView(body.view)) {
      await client.views.update({
        view_id: body.view.id,
        hash: body.view.hash,
        view,
      });
      return;
    }
    await client.views.push({ trigger_id: body.trigger_id, view });
    return;
  }
  await client.views.open({ trigger_id: body.trigger_id, view });
});

app.action(ACTIONS.FAQ_BACK, async ({ ack, body, client }) => {
  await ack();
  const userId = body.user.id;
  const lang = getUserLang(userId);
  const page = getFaqPageFromView(body.view);
  const view = buildFaqListView(lang, page);
  if (body.view) {
    await client.views.update({
      view_id: body.view.id,
      hash: body.view.hash,
      view,
    });
    return;
  }
  await client.views.open({ trigger_id: body.trigger_id, view });
});

app.action(ACTIONS.MY_CHANNELS_OPEN, async ({ ack, body, client }) => {
  await ack();
  const userId = body.user.id;
  const lang = getUserLang(userId);
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
    const lang = getUserLang(userId);
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
  const lang = getUserLang(userId);
  const channelId = action?.value;
  if (!channelId) {
    await updateActionMessage(client, body, t(lang, "err.channel_unknown"));
    return;
  }

  const pref = getChannelPref(channelId);
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
  const lang = getUserLang(userId);
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

  const pref = getChannelPref(channelId);
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
  setChannelListing(channelId, listed, {
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
    const lang = getUserLang(userId);
    const channelId = action?.value;
    if (!channelId) {
      await updateActionMessage(client, body, t(lang, "err.channel_unknown"));
      return;
    }

    const pref = getChannelPref(channelId) || ensureChannelPref(channelId);
    const channelType = pref?.channel_type || null;
    const isPrivate = channelType === "group";
    const isPublicAction = action.action_id === ACTIONS.CHANNEL_LIST_PUBLIC;
    const isDM = body.channel?.id?.startsWith("D");
    const channel = channelMention(channelId);

    if (isPublicAction && isPrivate) {
      setChannelListing(channelId, 0, { channelType, listedBy: userId });
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
    setChannelListing(channelId, listed, { channelType, listedBy: userId });
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
  const langInfo = getUserLangInfo(userId);
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
    const updated = setUserLang(userId, choice);
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

  if (isMaintenanceEnabled() && !isDevUser(userId)) {
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
          const channelSettings = getChannelSettings(channelId);
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
        const serLang = getUserLang(sergeantId);
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

function restoreActiveGames() {
  const games = loadAllGames();
  const maintenanceEnabled = isMaintenanceEnabled();
  games.forEach((game) => {
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
    if (dirty) saveGame(game);
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
            saveGame(game);
          });
        }
        if (game.state === "day" || game.state === "night") {
          withChannelLock(game.channelId, async () => {
            await postOrUpdateDashboard(app.client, game);
            saveGame(game);
          });
        }
      }
    }
  });
}

(async () => {
  await app.start(process.env.PORT || 3000);
  await initBotIdentity(app.client);
  restoreActiveGames();
  await maybeNotifyMaintenanceDone(app.client);
  console.log("Mafia bot is running (Socket Mode).");
})();
