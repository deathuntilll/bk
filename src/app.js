import "dotenv/config";

import {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AuditLogEvent
} from "discord.js";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* =========================================================
   BK SECURITY
   ========================================================= */

const BOT_NAME = "BK";
const VERSION = "3.0.0";
const PREFIX = "!";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "bk.json");
const BACKUP_FILE = path.join(DATA_DIR, "bk.backup.json");

const COUNTER_WINDOW = 60_000;
const AUDIT_LOOKBACK = 15_000;

/* =========================================================
   DEFAULT CONFIG
   ========================================================= */

const DEFAULT_LIMITS = {
  ban: 3,
  kick: 5,
  role: 5,
  channel: 3,
  webhook: 3
};

const DEFAULT_CONFIG = {
  enabled: true,

  limits: {
    ban: 3,
    kick: 5,
    role: 5,
    channel: 3,
    webhook: 3
  },

  punishment: "ban",

  whitelist: [],

  logChannelId: null
};

/* =========================================================
   CLIENT
   ========================================================= */

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildModeration
  ],

  partials: [
    Partials.GuildMember,
    Partials.User,
    Partials.Channel
  ]
});

/* =========================================================
   RUNTIME
   ========================================================= */

const counters = new Map();
const processedEvents = new Set();
const punishmentLocks = new Set();

/* =========================================================
   DATABASE
   ========================================================= */

let database = {
  guilds: {}
};

function ensureDataDirectory() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, {
        recursive: true
      });
    }
  } catch (error) {
    console.error("[BK] Failed to create data directory:", error);
  }
}

function loadDatabase() {
  ensureDataDirectory();

  try {
    if (!fs.existsSync(DATA_FILE)) {
      saveDatabase();
      return;
    }

    const raw = fs.readFileSync(DATA_FILE, "utf8");

    if (!raw.trim()) {
      saveDatabase();
      return;
    }

    const parsed = JSON.parse(raw);

    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.guilds !== "object"
    ) {
      throw new Error("Invalid database format.");
    }

    database = parsed;

    console.log("[BK] Database loaded.");
  } catch (error) {
    console.error("[BK] Database corrupted:", error);

    try {
      if (fs.existsSync(DATA_FILE)) {
        fs.copyFileSync(DATA_FILE, BACKUP_FILE);
      }
    } catch (backupError) {
      console.error(
        "[BK] Failed to create database backup:",
        backupError
      );
    }

    database = {
      guilds: {}
    };

    saveDatabase();
  }
}

function saveDatabase() {
  ensureDataDirectory();

  try {
    const tempFile = `${DATA_FILE}.tmp`;

    fs.writeFileSync(
      tempFile,
      JSON.stringify(database, null, 2),
      "utf8"
    );

    fs.renameSync(tempFile, DATA_FILE);
  } catch (error) {
    console.error("[BK] Failed to save database:", error);
  }
}

/* =========================================================
   GUILD CONFIG
   ========================================================= */

function getGuildConfig(guildId) {
  if (!database.guilds[guildId]) {
    database.guilds[guildId] = {
      enabled: DEFAULT_CONFIG.enabled,

      limits: {
        ...DEFAULT_LIMITS
      },

      punishment: DEFAULT_CONFIG.punishment,

      whitelist: [],

      logChannelId: null
    };

    saveDatabase();
  }

  const config = database.guilds[guildId];

  config.limits ??= {};

  for (const [key, value] of Object.entries(DEFAULT_LIMITS)) {
    if (
      typeof config.limits[key] !== "number" ||
      config.limits[key] < 1
    ) {
      config.limits[key] = value;
    }
  }

  if (!Array.isArray(config.whitelist)) {
    config.whitelist = [];
  }

  if (
    !["ban", "strip", "both"].includes(
      config.punishment
    )
  ) {
    config.punishment = "ban";
  }

  if (typeof config.enabled !== "boolean") {
    config.enabled = true;
  }

  return config;
}

/* =========================================================
   BOX SYSTEM
   ========================================================= */

function createBox(title, lines = [], footer = "BK") {
  const width = 36;

  const top = `╭${"─".repeat(width)}╮`;
  const middle = `├${"─".repeat(width)}┤`;
  const bottom = `╰${"─".repeat(width)}╯`;

  const output = [];

  output.push(top);

  const titleText = String(title)
    .slice(0, width - 2);

  const titlePadding =
    width - titleText.length - 2;

  const leftPadding =
    Math.floor(titlePadding / 2);

  const rightPadding =
    titlePadding - leftPadding;

  output.push(
    `│${" ".repeat(leftPadding)}${titleText}${" ".repeat(
      rightPadding
    )}│`
  );

  output.push(middle);

  for (const line of lines) {
    const text = String(line)
      .slice(0, width - 2);

    output.push(
      `│ ${text.padEnd(width - 2)} │`
    );
  }

  output.push(bottom);
  output.push(`│ ${footer}`);

  return output.join("\n");
}

/* =========================================================
   RESPONSE BOXES
   ========================================================= */

function responseSuccess(title, lines) {
  return createBox(
    `✓ ${title}`,
    lines,
    "BK • SECURITY"
  );
}

function responseError(lines) {
  return createBox(
    "⚠ ERROR",
    lines,
    "BK"
  );
}

function responseSecurity(lines) {
  return createBox(
    "⚠ BK SECURITY",
    lines,
    "BK • ANTI-NUKE"
  );
}

function responseInfo(title, lines) {
  return createBox(
    `◆ ${title}`,
    lines,
    "BK • SECURITY"
  );
}

/* =========================================================
   SAFE SEND
   ========================================================= */

async function safeSend(channel, payload) {
  if (!channel) {
    return null;
  }

  try {
    if (typeof payload === "string") {
      return await channel.send({
        content: payload
      });
    }

    return await channel.send(payload);
  } catch (error) {
    console.error("[BK] Failed to send message:", error);
    return null;
  }
}

/* =========================================================
   PERMISSION HELPERS
   ========================================================= */

function hasPermission(member, permission) {
  if (!member) {
    return false;
  }

  return member.permissions.has(permission);
}

function isServerOwner(member) {
  if (!member?.guild) {
    return false;
  }

  return member.id === member.guild.ownerId;
}

function isWhitelisted(guild, userId) {
  if (!guild) {
    return false;
  }

  if (userId === guild.ownerId) {
    return true;
  }

  const config = getGuildConfig(guild.id);

  return config.whitelist.includes(userId);
}

function canManageSecurity(member) {
  if (!member) {
    return false;
  }

  if (isServerOwner(member)) {
    return true;
  }

  return member.permissions.has(
    PermissionsBitField.Flags.Administrator
  );
}

/* =========================================================
   COUNTER SYSTEM
   ========================================================= */

function getCounterKey(guildId, userId, action) {
  return `${guildId}:${userId}:${action}`;
}

function registerAction(guildId, userId, action) {
  const key = getCounterKey(
    guildId,
    userId,
    action
  );

  const now = Date.now();

  if (!counters.has(key)) {
    counters.set(key, []);
  }

  const timestamps = counters.get(key);

  while (
    timestamps.length > 0 &&
    now - timestamps[0] > COUNTER_WINDOW
  ) {
    timestamps.shift();
  }

  timestamps.push(now);

  return timestamps.length;
}

function getActionCount(guildId, userId, action) {
  const key = getCounterKey(
    guildId,
    userId,
    action
  );

  const timestamps = counters.get(key);

  if (!timestamps) {
    return 0;
  }

  const now = Date.now();

  while (
    timestamps.length > 0 &&
    now - timestamps[0] > COUNTER_WINDOW
  ) {
    timestamps.shift();
  }

  return timestamps.length;
}

/* =========================================================
   AUDIT LOG
   ========================================================= */

async function findAuditExecutor(
  guild,
  type,
  targetId = null
) {
  try {
    const logs = await guild.fetchAuditLogs({
      type,
      limit: 10
    });

    const now = Date.now();

    const entry = logs.entries.find((log) => {
      if (!log?.executorId) {
        return false;
      }

      if (
        now - log.createdTimestamp >
        AUDIT_LOOKBACK
      ) {
        return false;
      }

      if (
        targetId &&
        log.target?.id &&
        log.target.id !== targetId
      ) {
        return false;
      }

      return true;
    });

    return entry || null;
  } catch (error) {
    console.error(
      `[BK] Audit log lookup failed for ${guild.id}:`,
      error
    );

    return null;
  }
}

/* =========================================================
   LOGGING
   ========================================================= */

async function sendSecurityLog(
  guild,
  content
) {
  try {
    const config = getGuildConfig(guild.id);

    if (!config.logChannelId) {
      return;
    }

    const channel =
      guild.channels.cache.get(
        config.logChannelId
      );

    if (!channel) {
      return;
    }

    await safeSend(channel, content);
  } catch (error) {
    console.error(
      "[BK] Failed to send security log:",
      error
    );
  }
}

/* =========================================================
   ROLE STRIPPING
   ========================================================= */

async function stripDangerousRoles(member) {
  if (!member) {
    return false;
  }

  let changed = false;

  try {
    const botMember =
      member.guild.members.me;

    if (!botMember) {
      return false;
    }

    const manageableRoles =
      member.roles.cache.filter(
        (role) =>
          role.id !== member.guild.id &&
          !role.managed &&
          role.position <
            botMember.roles.highest.position
      );

    if (manageableRoles.size === 0) {
      return false;
    }

    await member.roles.remove(
      manageableRoles,
      "BK Security | Security violation"
    );

    changed = true;
  } catch (error) {
    console.error(
      "[BK] Failed to strip roles:",
      error
    );
  }

  return changed;
}

/* =========================================================
   SAFE BAN
   ========================================================= */

async function safeBanMember(
  guild,
  member,
  reason
) {
  try {
    if (!member) {
      return false;
    }

    const botMember =
      guild.members.me;

    if (!botMember) {
      return false;
    }

    if (
      member.id === guild.ownerId
    ) {
      return false;
    }

    if (
      member.roles.highest.position >=
      botMember.roles.highest.position
    ) {
      return false;
    }

    if (!botMember.permissions.has(
      PermissionsBitField.Flags.BanMembers
    )) {
      return false;
    }

    await member.ban({
      reason
    });

    return true;
  } catch (error) {
    console.error(
      "[BK] Failed to ban member:",
      error
    );

    return false;
  }
}

/* =========================================================
   PUNISHMENT
   ========================================================= */

async function punishMember({
  guild,
  member,
  action,
  count,
  limit
}) {
  if (!guild || !member) {
    return;
  }

  const config =
    getGuildConfig(guild.id);

  const lockKey =
    `${guild.id}:${member.id}:${action}`;

  if (punishmentLocks.has(lockKey)) {
    return;
  }

  punishmentLocks.add(lockKey);

  try {
    const reason =
      `BK Security | ${action} limit exceeded | ${count} ${action}s within 60 seconds | User ID: ${member.id}`;

    let stripped = false;
    let banned = false;

    if (
      config.punishment === "strip" ||
      config.punishment === "both"
    ) {
      stripped =
        await stripDangerousRoles(member);
    }

    if (
      config.punishment === "ban" ||
      config.punishment === "both"
    ) {
      banned =
        await safeBanMember(
          guild,
          member,
          reason
        );
    }

    const punishmentText =
      config.punishment === "ban"
        ? banned
          ? "user banned"
          : "ban failed"
        : config.punishment === "strip"
          ? stripped
            ? "roles stripped"
            : "role removal failed"
          : `roles ${
              stripped
                ? "stripped"
                : "not stripped"
            } • ${
              banned
                ? "user banned"
                : "ban failed"
            }`;

    const message =
      responseSecurity([
        "abnormal activity detected.",
        "",
        `user     → ${member.user?.tag || member.id}`,
        `id       → ${member.id}`,
        `action   → ${action}`,
        `count    → ${count} / ${limit}`,
        "",
        `reason   → ${action} limit exceeded.`,
        `action   → ${punishmentText}.`
      ]);

    await sendSecurityLog(
      guild,
      message
    );
  } finally {
    setTimeout(() => {
      punishmentLocks.delete(lockKey);
    }, 5000);
  }
}

/* =========================================================
   LIMIT ENFORCEMENT
   ========================================================= */

async function enforceLimit({
  guild,
  member,
  action
}) {
  if (!guild || !member) {
    return false;
  }

  const config =
    getGuildConfig(guild.id);

  if (!config.enabled) {
    return false;
  }

  if (
    isServerOwner(member) ||
    isWhitelisted(guild, member.id)
  ) {
    return false;
  }

  const limit =
    config.limits[action];

  if (
    typeof limit !== "number"
  ) {
    return false;
  }

  const count =
    registerAction(
      guild.id,
      member.id,
      action
    );

  if (count > limit) {
    await punishMember({
      guild,
      member,
      action,
      count,
      limit
    });

    return true;
  }

  await sendSecurityLog(
    guild,
    createBox(
      `✓ ${action.toUpperCase()}`,
      [
        `${member.user?.tag || member.id} performed ${action}.`,
        "",
        `security → within limit`,
        `count    → ${count} / ${limit}`,
        `status   → allowed`
      ],
      "BK • SECURITY"
    )
  );

  return false;
}

/* =========================================================
   HELP PAGES
   ========================================================= */

const HELP_PAGES = [
  {
    title: "BK SECURITY",
    lines: [
      "strict server protection.",
      "",
      "protect your server",
      "from unauthorized actions.",
      "",
      "pages → 1 / 5"
    ]
  },

  {
    title: "BK • SECURITY",
    lines: [
      "!security setup",
      "!security status",
      "!security enable",
      "!security disable",
      "",
      "configure BK security.",
      "",
      "pages → 2 / 5"
    ]
  },

  {
    title: "BK • LIMITS",
    lines: [
      "!security limit ban 3",
      "!security limit kick 5",
      "!security limit role 5",
      "!security limit channel 3",
      "",
      "limits reset every 60 seconds.",
      "",
      "pages → 3 / 5"
    ]
  },

  {
    title: "BK • WHITELIST",
    lines: [
      "!wl add @user",
      "!wl remove @user",
      "!wl list",
      "",
      "whitelisted users bypass",
      "security enforcement.",
      "",
      "pages → 4 / 5"
    ]
  },

  {
    title: "BK • ACTIONS",
    lines: [
      "!security punishment ban",
      "!security punishment strip",
      "!security punishment both",
      "",
      "!security logs #channel",
      "",
      "configure BK actions.",
      "",
      "pages → 5 / 5"
    ]
  }
];

function createHelpBox(page = 0) {
  const data =
    HELP_PAGES[page] ||
    HELP_PAGES[0];

  return createBox(
    data.title,
    data.lines,
    `BK • PAGE ${page + 1}/${HELP_PAGES.length}`
  );
}

function createHelpButtons(
  page,
  ownerId
) {
  const previous =
    new ButtonBuilder()
      .setCustomId(
        `bk_help_prev_${ownerId}_${page}`
      )
      .setLabel("‹")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === 0);

  const home =
    new ButtonBuilder()
      .setCustomId(
        `bk_help_home_${ownerId}_${page}`
      )
      .setLabel("Home")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === 0);

  const next =
    new ButtonBuilder()
      .setCustomId(
        `bk_help_next_${ownerId}_${page}`
      )
      .setLabel("›")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(
        page === HELP_PAGES.length - 1
      );

  return new ActionRowBuilder()
    .addComponents(
      previous,
      home,
      next
    );
}

/* =========================================================
   HELP COMMAND
   ========================================================= */

async function sendHelp(message) {
  await safeSend(
    message.channel,
    {
      content: createHelpBox(0),
      components: [
        createHelpButtons(
          0,
          message.author.id
        )
      ]
    }
  );
}

/* =========================================================
   MESSAGE COMMAND HANDLER
   ========================================================= */

client.on(
  "messageCreate",
  async (message) => {
    try {
      if (!message.guild) {
        return;
      }

      if (message.author.bot) {
        return;
      }

      if (
        !message.content.startsWith(PREFIX)
      ) {
        return;
      }

      const args =
        message.content
          .slice(PREFIX.length)
          .trim()
          .split(/\s+/);

      const command =
        args.shift()?.toLowerCase();

      if (!command) {
        return;
      }

      /* ================================================
         HELP
         ================================================ */

      if (command === "help") {
        await sendHelp(message);
        return;
      }

      /* ================================================
         WHITELIST
         ================================================ */

      if (
        command === "wl" ||
        command === "whitelist"
      ) {
        if (
          !canManageSecurity(
            message.member
          )
        ) {
          await safeSend(
            message.channel,
            responseError([
              `${message.author} cannot use this command.`,
              "",
              "required → Administrator",
              "status   → denied"
            ])
          );

          return;
        }

        const sub =
          args[0]?.toLowerCase();

        const config =
          getGuildConfig(
            message.guild.id
          );

        if (sub === "list") {
          if (
            config.whitelist.length === 0
          ) {
            await safeSend(
              message.channel,
              responseInfo(
                "TRUST",
                [
                  "no users are BK-whitelisted.",
                  "",
                  "use → !wl add @user"
                ]
              )
            );

            return;
          }

          const users = [];

          for (
            const id of config.whitelist
          ) {
            const member =
              await message.guild.members
                .fetch(id)
                .catch(() => null);

            users.push(
              member
                ? `${member.user.tag} → ${id}`
                : `unknown user → ${id}`
            );
          }

          await safeSend(
            message.channel,
            responseInfo(
              "TRUST",
              [
                "BK whitelist",
                "",
                ...users.slice(0, 8)
              ]
            )
          );

          return;
        }

        const target =
          message.mentions.members.first();

        if (
          !target &&
          (sub === "add" ||
            sub === "remove")
        ) {
          await safeSend(
            message.channel,
            responseError([
              "you must mention a user.",
              "",
              "example → !wl add @user"
            ])
          );

          return;
        }

        if (sub === "add") {
          if (
            target.id ===
            message.guild.ownerId
          ) {
            await safeSend(
              message.channel,
              responseInfo(
                "TRUST",
                [
                  "the server owner is",
                  "already protected by BK."
                ]
              )
            );

            return;
          }

          if (
            !config.whitelist.includes(
              target.id
            )
          ) {
            config.whitelist.push(
              target.id
            );

            saveDatabase();
          }

          await safeSend(
            message.channel,
            responseSuccess(
              "TRUST",
              [
                `${target} is BK-whitelisted.`,
                "security enforcement bypassed.",
                "actions will remain logged."
              ]
            )
          );

          return;
        }

        if (sub === "remove") {
          config.whitelist =
            config.whitelist.filter(
              (id) =>
                id !== target.id
            );

          saveDatabase();

          await safeSend(
            message.channel,
            responseSuccess(
              "TRUST",
              [
                `${target} was removed`,
                "from the BK whitelist.",
                "security enforcement restored."
              ]
            )
          );

          return;
        }

        await safeSend(
          message.channel,
          responseError([
            "unknown whitelist command.",
            "",
            "!wl add @user",
            "!wl remove @user",
            "!wl list"
          ])
        );

        return;
      }

      /* ================================================
         SECURITY
         ================================================ */

      if (command === "security") {
        if (
          !canManageSecurity(
            message.member
          )
        ) {
          await safeSend(
            message.channel,
            responseError([
              `${message.author} cannot use this command.`,
              "",
              "required → Administrator",
              "status   → denied"
            ])
          );

          return;
        }

        const sub =
          args[0]?.toLowerCase();

        const config =
          getGuildConfig(
            message.guild.id
          );

        /* ============================================
           SETUP
           ============================================ */

        if (sub === "setup") {
          config.enabled = true;

          saveDatabase();

          await safeSend(
            message.channel,
            responseSuccess(
              "SETUP",
              [
                "BK security has been configured.",
                "",
                "status → enabled",
                "limits → default",
                "punishment → ban",
                "",
                "use → !security status"
              ]
            )
          );

          return;
        }

        /* ============================================
           STATUS
           ============================================ */

        if (sub === "status") {
          await safeSend(
            message.channel,
            responseInfo(
              "STATUS",
              [
                `security → ${
                  config.enabled
                    ? "enabled"
                    : "disabled"
                }`,
                `ban      → ${config.limits.ban}`,
                `kick     → ${config.limits.kick}`,
                `role     → ${config.limits.role}`,
                `channel  → ${config.limits.channel}`,
                `webhook  → ${config.limits.webhook}`,
                `punish   → ${config.punishment}`,
                `whitelist → ${config.whitelist.length}`
              ]
            )
          );

          return;
        }

        /* ============================================
           ENABLE
           ============================================ */

        if (sub === "enable") {
          config.enabled = true;

          saveDatabase();

          await safeSend(
            message.channel,
            responseSuccess(
              "SECURITY",
              [
                "BK security is now enabled.",
                "",
                "status → active",
                "protection → enabled"
              ]
            )
          );

          return;
        }

        /* ============================================
           DISABLE
           ============================================ */

        if (sub === "disable") {
          config.enabled = false;

          saveDatabase();

          await safeSend(
            message.channel,
            responseInfo(
              "SECURITY",
              [
                "BK security is now disabled.",
                "",
                "status → inactive",
                "protection → disabled"
              ]
            )
          );

          return;
        }

        /* ============================================
           LIMIT
           ============================================ */

        if (sub === "limit") {
          const action =
            args[1]?.toLowerCase();

          const amount =
            Number(args[2]);

          const validActions = [
            "ban",
            "kick",
            "role",
            "channel",
            "webhook"
          ];

          if (
            !validActions.includes(
              action
            )
          ) {
            await safeSend(
              message.channel,
              responseError([
                "invalid security limit.",
                "",
                "valid → ban",
                "valid → kick",
                "valid → role",
                "valid → channel",
                "valid → webhook"
              ])
            );

            return;
          }

          if (
            !Number.isInteger(amount) ||
            amount < 1 ||
            amount > 100
          ) {
            await safeSend(
              message.channel,
              responseError([
                "invalid limit amount.",
                "",
                "use a number between 1 and 100."
              ])
            );

            return;
          }

          config.limits[action] =
            amount;

          saveDatabase();

          await safeSend(
            message.channel,
            responseSuccess(
              "LIMIT",
              [
                `action → ${action}`,
                `limit  → ${amount}`,
                "",
                "window → 60 seconds",
                "status → saved"
              ]
            )
          );

          return;
        }

        /* ============================================
           PUNISHMENT
           ============================================ */

        if (sub === "punishment") {
          const punishment =
            args[1]?.toLowerCase();

          if (
            ![
              "ban",
              "strip",
              "both"
            ].includes(punishment)
          ) {
            await safeSend(
              message.channel,
              responseError([
                "invalid punishment.",
                "",
                "valid → ban",
                "valid → strip",
                "valid → both"
              ])
            );

            return;
          }

          config.punishment =
            punishment;

          saveDatabase();

          await safeSend(
            message.channel,
            responseSuccess(
              "ACTION",
              [
                `punishment → ${punishment}`,
                "status → saved"
              ]
            )
          );

          return;
        }

        /* ============================================
           LOG CHANNEL
           ============================================ */

        if (sub === "logs") {
          const channel =
            message.mentions.channels.first();

          if (
            !channel
          ) {
            await safeSend(
              message.channel,
              responseError([
                "you must mention a channel.",
                "",
                "example → !security logs #security"
              ])
            );

            return;
          }

          config.logChannelId =
            channel.id;

          saveDatabase();

          await safeSend(
            message.channel,
            responseSuccess(
              "LOGS",
              [
                `channel → ${channel}`,
                "security events will be logged.",
                "status → enabled"
              ]
            )
          );

          return;
        }

        await safeSend(
          message.channel,
          responseError([
            "unknown security command.",
            "",
            "!security setup",
            "!security status",
            "!security enable",
            "!security disable",
            "!security limit",
            "!security punishment",
            "!security logs"
          ])
        );

        return;
      }
    } catch (error) {
      console.error(
        "[BK] messageCreate error:",
        error
      );

      await safeSend(
        message.channel,
        responseError([
          "an internal error occurred.",
          "",
          "status → command failed",
          "BK remains online."
        ])
      );
    }
  }
);

/* =========================================================
   HELP BUTTONS
   ========================================================= */

client.on(
  "interactionCreate",
  async (interaction) => {
    try {
      if (
        !interaction.isButton()
      ) {
        return;
      }

      if (
        !interaction.customId.startsWith(
          "bk_help_"
        )
      ) {
        return;
      }

      const parts =
        interaction.customId.split("_");

      /*
        bk_help_next_USERID_PAGE
        bk_help_prev_USERID_PAGE
        bk_help_home_USERID_PAGE
      */

      const action =
        parts[2];

      const ownerId =
        parts[3];

      const currentPage =
        Number(parts[4]);

      if (
        interaction.user.id !==
        ownerId
      ) {
        await interaction.reply({
          content: responseError([
            "this help panel belongs",
            "to another user.",
            "",
            "status → access denied"
          ]),
          ephemeral: true
        });

        return;
      }

      if (
        Number.isNaN(currentPage)
      ) {
        await interaction.reply({
          content: responseError([
            "invalid help page.",
            "",
            "status → request rejected"
          ]),
          ephemeral: true
        });

        return;
      }

      let newPage =
        currentPage;

      if (action === "next") {
        newPage++;
      }

      if (action === "prev") {
        newPage--;
      }

      if (action === "home") {
        newPage = 0;
      }

      newPage =
        Math.max(
          0,
          Math.min(
            HELP_PAGES.length - 1,
            newPage
          )
        );

      await interaction.update({
        content:
          createHelpBox(newPage),

        components: [
          createHelpButtons(
            newPage,
            ownerId
          )
        ]
      });
    } catch (error) {
      console.error(
        "[BK] interaction error:",
        error
      );

      try {
        if (
          !interaction.replied &&
          !interaction.deferred
        ) {
          await interaction.reply({
            content: responseError([
              "the button could not be processed.",
              "",
              "status → request failed"
            ]),
            ephemeral: true
          });
        }
      } catch {}
    }
  }
);

/* =========================================================
   BAN MONITOR
   ========================================================= */

client.on(
  "guildBanAdd",
  async (ban) => {
    try {
      const guild =
        ban.guild;

      if (!guild) {
        return;
      }

      const config =
        getGuildConfig(guild.id);

      if (!config.enabled) {
        return;
      }

      const entry =
        await findAuditExecutor(
          guild,
          AuditLogEvent.MemberBanAdd,
          ban.user.id
        );

      if (!entry?.executorId) {
        return;
      }

      const executor =
        await guild.members
          .fetch(entry.executorId)
          .catch(() => null);

      if (!executor) {
        return;
      }

      if (
        isServerOwner(executor) ||
        isWhitelisted(
          guild,
          executor.id
        )
      ) {
        return;
      }

      await enforceLimit({
        guild,
        member: executor,
        action: "ban"
      });
    } catch (error) {
      console.error(
        "[BK] guildBanAdd error:",
        error
      );
    }
  }
);

/* =========================================================
   KICK MONITOR
   ========================================================= */

client.on(
  "guildMemberRemove",
  async (member) => {
    try {
      const guild =
        member.guild;

      const entry =
        await findAuditExecutor(
          guild,
          AuditLogEvent.MemberKick,
          member.id
        );

      if (!entry?.executorId) {
        return;
      }

      const executor =
        await guild.members
          .fetch(entry.executorId)
          .catch(() => null);

      if (!executor) {
        return;
      }

      if (
        isServerOwner(executor) ||
        isWhitelisted(
          guild,
          executor.id
        )
      ) {
        return;
      }

      await enforceLimit({
        guild,
        member: executor,
        action: "kick"
      });
    } catch (error) {
      console.error(
        "[BK] guildMemberRemove error:",
        error
      );
    }
  }
);

/* =========================================================
   ROLE DELETE MONITOR
   ========================================================= */

client.on(
  "roleDelete",
  async (role) => {
    try {
      const guild =
        role.guild;

      const eventKey =
        `role:${guild.id}:${role.id}`;

      if (
        processedEvents.has(eventKey)
      ) {
        return;
      }

      processedEvents.add(
        eventKey
      );

      setTimeout(() => {
        processedEvents.delete(
          eventKey
        );
      }, 30_000);

      const entry =
        await findAuditExecutor(
          guild,
          AuditLogEvent.RoleDelete,
          role.id
        );

      if (!entry?.executorId) {
        return;
      }

      const executor =
        await guild.members
          .fetch(entry.executorId)
          .catch(() => null);

      if (!executor) {
        return;
      }

      if (
        isServerOwner(executor) ||
        isWhitelisted(
          guild,
          executor.id
        )
      ) {
        return;
      }

      await enforceLimit({
        guild,
        member: executor,
        action: "role"
      });
    } catch (error) {
      console.error(
        "[BK] roleDelete error:",
        error
      );
    }
  }
);

/* =========================================================
   CHANNEL DELETE MONITOR
   ========================================================= */

client.on(
  "channelDelete",
  async (channel) => {
    try {
      if (!channel.guild) {
        return;
      }

      const guild =
        channel.guild;

      const eventKey =
        `channel:${guild.id}:${channel.id}`;

      if (
        processedEvents.has(eventKey)
      ) {
        return;
      }

      processedEvents.add(
        eventKey
      );

      setTimeout(() => {
        processedEvents.delete(
          eventKey
        );
      }, 30_000);

      const entry =
        await findAuditExecutor(
          guild,
          AuditLogEvent.ChannelDelete,
          channel.id
        );

      if (!entry?.executorId) {
        return;
      }

      const executor =
        await guild.members
          .fetch(entry.executorId)
          .catch(() => null);

      if (!executor) {
        return;
      }

      if (
        isServerOwner(executor) ||
        isWhitelisted(
          guild,
          executor.id
        )
      ) {
        return;
      }

      await enforceLimit({
        guild,
        member: executor,
        action: "channel"
      });
    } catch (error) {
      console.error(
        "[BK] channelDelete error:",
        error
      );
    }
  }
);

/* =========================================================
   WEBHOOK MONITOR
   ========================================================= */

client.on(
  "webhooksUpdate",
  async (channel) => {
    try {
      if (!channel.guild) {
        return;
      }

      const guild =
        channel.guild;

      const entry =
        await findAuditExecutor(
          guild,
          AuditLogEvent.WebhookCreate
        );

      if (!entry?.executorId) {
        return;
      }

      const executor =
        await guild.members
          .fetch(entry.executorId)
          .catch(() => null);

      if (!executor) {
        return;
      }

      if (
        isServerOwner(executor) ||
        isWhitelisted(
          guild,
          executor.id
        )
      ) {
        return;
      }

      await enforceLimit({
        guild,
        member: executor,
        action: "webhook"
      });
    } catch (error) {
      console.error(
        "[BK] webhooksUpdate error:",
        error
      );
    }
  }
);

/* =========================================================
   READY
   ========================================================= */

client.once(
  "ready",
  () => {
    console.log("");
    console.log("╭────────────────────────────────────╮");
    console.log("│              BK SECURITY           │");
    console.log("├────────────────────────────────────┤");
    console.log(`│ version → ${VERSION}`.padEnd(37) + "│");
    console.log(`│ prefix  → ${PREFIX}`.padEnd(37) + "│");
    console.log(`│ user    → ${client.user.tag}`.padEnd(37) + "│");
    console.log(`│ guilds  → ${client.guilds.cache.size}`.padEnd(37) + "│");
    console.log("│ status  → online                   │");
    console.log("╰────────────────────────────────────╯");
    console.log("");
  }
);

/* =========================================================
   PROCESS SAFETY
   ========================================================= */

process.on(
  "unhandledRejection",
  (reason) => {
    console.error(
      "[BK] Unhandled rejection:",
      reason
    );
  }
);

process.on(
  "uncaughtException",
  (error) => {
    console.error(
      "[BK] Uncaught exception:",
      error
    );
  }
);

process.on(
  "SIGINT",
  async () => {
    console.log(
      "[BK] Shutting down..."
    );

    saveDatabase();

    try {
      client.destroy();
    } catch {}

    process.exit(0);
  }
);

process.on(
  "SIGTERM",
  async () => {
    console.log(
      "[BK] Shutting down..."
    );

    saveDatabase();

    try {
      client.destroy();
    } catch {}

    process.exit(0);
  }
);

/* =========================================================
   START
   ========================================================= */

loadDatabase();

const token =
  process.env.DISCORD_TOKEN;

if (!token) {
  console.error("");
  console.error(
    "╭────────────────────────────────────╮"
  );
  console.error(
    "│              ⚠ BK ERROR            │"
  );
  console.error(
    "├────────────────────────────────────┤"
  );
  console.error(
    "│ DISCORD_TOKEN is missing.          │"
  );
  console.error(
    "│                                    │"
  );
  console.error(
    "│ add it to your .env file.          │"
  );
  console.error(
    "╰────────────────────────────────────╯"
  );
  console.error("");

  process.exit(1);
}

client.login(token).catch(
  (error) => {
    console.error(
      "[BK LOGIN ERROR]",
      error
    );

    process.exit(1);
  }
);
