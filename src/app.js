import "dotenv/config";

import {
    Client,
    GatewayIntentBits,
    Partials,
    PermissionsBitField,
    AuditLogEvent,
    ChannelType
} from "discord.js";

import fs from "node:fs";
import path from "node:path";

/* =========================================================
   BK CONFIG
========================================================= */

const PREFIX = "!";
const BOT_NAME = "BK";
const VERSION = "1.0.0";

const DATA_DIR = path.join(process.cwd(), "data");
const DATA_FILE = path.join(DATA_DIR, "bk.json");

const DEFAULT_LIMITS = {
    ban: 3,
    kick: 5,
    role: 5,
    channel: 3,
    webhook: 3
};

const WINDOW_MS = 60 * 1000;

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
   DATABASE
========================================================= */

function ensureDataDirectory() {
    try {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }
    } catch (error) {
        console.error("[BK DATABASE] Could not create data directory:", error);
    }
}

function defaultGuildData() {
    return {
        enabled: true,
        logChannelId: null,

        whitelist: [],

        punishment: "ban",

        limits: {
            ...DEFAULT_LIMITS
        }
    };
}

function loadDatabase() {
    ensureDataDirectory();

    try {
        if (!fs.existsSync(DATA_FILE)) {
            const initial = {};
            fs.writeFileSync(
                DATA_FILE,
                JSON.stringify(initial, null, 4),
                "utf8"
            );

            return initial;
        }

        const raw = fs.readFileSync(DATA_FILE, "utf8");

        if (!raw.trim()) {
            return {};
        }

        return JSON.parse(raw);
    } catch (error) {
        console.error("[BK DATABASE] Failed to load database:", error);

        /*
         * Don't crash the bot because the JSON file is damaged.
         * Start with an empty database instead.
         */
        return {};
    }
}

let db = loadDatabase();

function saveDatabase() {
    try {
        ensureDataDirectory();

        const temporaryFile = `${DATA_FILE}.tmp`;

        fs.writeFileSync(
            temporaryFile,
            JSON.stringify(db, null, 4),
            "utf8"
        );

        fs.renameSync(temporaryFile, DATA_FILE);
    } catch (error) {
        console.error("[BK DATABASE] Failed to save:", error);
    }
}

function getGuildData(guildId) {
    if (!db[guildId]) {
        db[guildId] = defaultGuildData();
        saveDatabase();
    }

    const guild = db[guildId];

    guild.limits ??= { ...DEFAULT_LIMITS };
    guild.whitelist ??= [];
    guild.punishment ??= "ban";
    guild.enabled ??= true;

    for (const key of Object.keys(DEFAULT_LIMITS)) {
        if (
            typeof guild.limits[key] !== "number" ||
            guild.limits[key] < 1
        ) {
            guild.limits[key] = DEFAULT_LIMITS[key];
        }
    }

    return guild;
}

/* =========================================================
   ACTION COUNTERS
========================================================= */

/*
 * Runtime only.
 *
 * Structure:
 * actionCounters[guildId][userId][action] = [timestamps]
 */

const actionCounters = new Map();

function getCounter(guildId, userId, action) {
    if (!actionCounters.has(guildId)) {
        actionCounters.set(guildId, new Map());
    }

    const guildCounters = actionCounters.get(guildId);

    if (!guildCounters.has(userId)) {
        guildCounters.set(userId, {});
    }

    const userCounters = guildCounters.get(userId);

    if (!userCounters[action]) {
        userCounters[action] = [];
    }

    return userCounters[action];
}

function recordAction(guildId, userId, action) {
    const now = Date.now();

    const timestamps = getCounter(
        guildId,
        userId,
        action
    );

    /*
     * Remove timestamps older than 60 seconds.
     */
    while (
        timestamps.length > 0 &&
        now - timestamps[0] > WINDOW_MS
    ) {
        timestamps.shift();
    }

    timestamps.push(now);

    return timestamps.length;
}

function clearUserCounters(guildId, userId) {
    const guildCounters = actionCounters.get(guildId);

    if (!guildCounters) return;

    guildCounters.delete(userId);
}

/* =========================================================
   BOX RESPONSES
========================================================= */

function box(title, lines = []) {
    const width = 34;

    const top = `╭${"─".repeat(width)}╮`;
    const middle = `├${"─".repeat(width)}┤`;
    const bottom = `╰${"─".repeat(width)}╯`;

    const output = [
        top,
        `│${centerText(title, width)}│`,
        middle
    ];

    for (const line of lines) {
        const text = String(line).slice(0, width - 2);
        output.push(`│ ${text.padEnd(width - 2)} │`);
    }

    output.push(bottom);
    output.push(`│ ${BOT_NAME} • SECURITY`);

    return output.join("\n");
}

function centerText(text, width) {
    const value = String(text).slice(0, width);

    const left = Math.floor((width - value.length) / 2);
    const right = width - value.length - left;

    return `${" ".repeat(left)}${value}${" ".repeat(right)}`;
}

async function safeSend(channel, content) {
    try {
        if (!channel || !channel.isTextBased()) {
            return null;
        }

        return await channel.send({
            content: String(content).slice(0, 2000)
        });
    } catch (error) {
        console.error("[BK SEND ERROR]", error.message);
        return null;
    }
}

/* =========================================================
   SECURITY LOGGING
========================================================= */

async function securityLog(guild, content) {
    try {
        const settings = getGuildData(guild.id);

        if (!settings.logChannelId) {
            return;
        }

        const channel = guild.channels.cache.get(
            settings.logChannelId
        );

        if (!channel) {
            return;
        }

        await safeSend(channel, content);
    } catch (error) {
        console.error("[BK LOG ERROR]", error.message);
    }
}

/* =========================================================
   PERMISSION / WHITELIST
========================================================= */

function isOwner(guild, userId) {
    return guild.ownerId === userId;
}

function isWhitelisted(guild, userId) {
    const settings = getGuildData(guild.id);

    return (
        isOwner(guild, userId) ||
        settings.whitelist.includes(userId)
    );
}

function canManageSecurity(guild, userId) {
    /*
     * Only the server owner can modify BK's security settings.
     */
    return isOwner(guild, userId);
}

/* =========================================================
   HELP
========================================================= */

function helpMessage() {
    return box("BK SECURITY", [
        "",
        "!help",
        "show this panel",
        "",
        "!wl add @user",
        "whitelist a user",
        "",
        "!wl remove @user",
        "remove whitelist",
        "",
        "!wl list",
        "show whitelist",
        "",
        "!security setup",
        "enable BK + set logs",
        "",
        "!security status",
        "show security status",
        "",
        "!security enable",
        "enable protection",
        "",
        "!security disable",
        "disable protection",
        "",
        "!security limit ban 3",
        "set ban limit",
        "",
        "!security limit kick 5",
        "set kick limit",
        "",
        "!security punishment ban",
        "set punishment",
        "",
        "!security logs #channel",
        "set security logs"
    ]);
}

/* =========================================================
   PUNISHMENT
========================================================= */

async function stripDangerousRoles(guild, userId) {
    try {
        const member = await guild.members
            .fetch(userId)
            .catch(() => null);

        if (!member) {
            return false;
        }

        if (member.id === guild.ownerId) {
            return false;
        }

        const me = guild.members.me;

        if (!me) {
            return false;
        }

        /*
         * Only remove roles BK can actually manage.
         */
        const removableRoles = member.roles.cache.filter(
            role =>
                role.id !== guild.id &&
                !role.managed &&
                role.position < me.roles.highest.position
        );

        if (removableRoles.size === 0) {
            return false;
        }

        await member.roles.remove(
            removableRoles,
            "BK Security - security limit exceeded"
        );

        return true;
    } catch (error) {
        console.error(
            "[BK STRIP ERROR]",
            error.message
        );

        return false;
    }
}

async function banUser(guild, userId, reason) {
    try {
        if (userId === guild.ownerId) {
            return false;
        }

        const me = guild.members.me;

        if (!me) {
            return false;
        }

        if (
            !me.permissions.has(
                PermissionsBitField.Flags.BanMembers
            )
        ) {
            console.error(
                "[BK] Missing Ban Members permission."
            );

            return false;
        }

        const member = await guild.members
            .fetch(userId)
            .catch(() => null);

        if (member) {
            if (
                member.roles.highest.position >=
                me.roles.highest.position
            ) {
                console.error(
                    "[BK] Cannot ban user because their highest role is above/equal to BK."
                );

                return false;
            }
        }

        await guild.members.ban(userId, {
            reason
        });

        return true;
    } catch (error) {
        console.error(
            "[BK BAN ERROR]",
            error.message
        );

        return false;
    }
}

async function punishUser(
    guild,
    userId,
    action,
    count,
    limit
) {
    const settings = getGuildData(guild.id);

    if (isOwner(guild, userId)) {
        return;
    }

    if (isWhitelisted(guild, userId)) {
        return;
    }

    const reason =
        `BK Security | ${action.toUpperCase()} limit exceeded | ` +
        `${count} ${action}s within 60 seconds | ` +
        `User ID: ${userId}`;

    let stripped = false;
    let banned = false;

    if (
        settings.punishment === "strip" ||
        settings.punishment === "both"
    ) {
        stripped = await stripDangerousRoles(
            guild,
            userId
        );
    }

    if (
        settings.punishment === "ban" ||
        settings.punishment === "both"
    ) {
        banned = await banUser(
            guild,
            userId,
            reason
        );
    }

    clearUserCounters(guild.id, userId);

    const punishmentText = [
        stripped ? "roles stripped" : null,
        banned ? "user banned" : null
    ]
        .filter(Boolean)
        .join(" + ") || "action attempted";

    const message = box(
        "⚠ BK SECURITY",
        [
            "",
            "abnormal activity detected.",
            "",
            `user → ${userId}`,
            `action → ${action}`,
            `count → ${count} / ${limit}`,
            "",
            `reason → ${action} limit exceeded`,
            `action → ${punishmentText}`
        ]
    );

    await securityLog(guild, message);
}

/* =========================================================
   AUDIT LOG FINDER
========================================================= */

async function findRecentAuditExecutor(
    guild,
    auditAction,
    targetId
) {
    try {
        const logs = await guild.fetchAuditLogs({
            type: auditAction,
            limit: 10
        });

        const now = Date.now();

        const entry = logs.entries.find(entry => {
            if (!entry) return false;

            if (targetId && entry.targetId !== targetId) {
                return false;
            }

            if (!entry.createdTimestamp) {
                return false;
            }

            /*
             * Only accept very recent actions.
             */
            return now - entry.createdTimestamp < 10000;
        });

        if (!entry) {
            return null;
        }

        return entry.executorId || null;
    } catch (error) {
        console.error(
            "[BK AUDIT ERROR]",
            error.message
        );

        return null;
    }
}

/* =========================================================
   MODERATION MONITOR
========================================================= */

async function monitorAction(
    guild,
    userId,
    action
) {
    try {
        if (!guild || !userId) {
            return;
        }

        const settings = getGuildData(guild.id);

        if (!settings.enabled) {
            return;
        }

        /*
         * BK itself should never trigger punishment.
         */
        if (userId === client.user?.id) {
            return;
        }

        /*
         * Server owner is always protected.
         */
        if (isOwner(guild, userId)) {
            return;
        }

        /*
         * BK whitelist bypasses punishment.
         */
        if (isWhitelisted(guild, userId)) {
            return;
        }

        const limit =
            settings.limits[action];

        if (!limit) {
            return;
        }

        const count = recordAction(
            guild.id,
            userId,
            action
        );

        /*
         * Still within allowed limit.
         */
        if (count <= limit) {
            return;
        }

        await punishUser(
            guild,
            userId,
            action,
            count,
            limit
        );
    } catch (error) {
        console.error(
            "[BK MONITOR ERROR]",
            error.message
        );
    }
}

/* =========================================================
   BAN MONITOR
========================================================= */

client.on("guildBanAdd", async ban => {
    try {
        const guild = ban.guild;

        if (!guild) {
            return;
        }

        const executorId =
            await findRecentAuditExecutor(
                guild,
                AuditLogEvent.MemberBanAdd,
                ban.user.id
            );

        if (!executorId) {
            return;
        }

        await monitorAction(
            guild,
            executorId,
            "ban"
        );
    } catch (error) {
        console.error(
            "[BK BAN MONITOR ERROR]",
            error.message
        );
    }
});

/* =========================================================
   KICK MONITOR
========================================================= */

client.on("guildMemberRemove", async member => {
    try {
        const guild = member.guild;

        if (!guild) {
            return;
        }

        /*
         * A memberRemove event can mean:
         * - kick
         * - leave
         * - ban
         *
         * We specifically look for a recent KICK audit entry.
         */
        const executorId =
            await findRecentAuditExecutor(
                guild,
                AuditLogEvent.MemberKick,
                member.id
            );

        if (!executorId) {
            return;
        }

        await monitorAction(
            guild,
            executorId,
            "kick"
        );
    } catch (error) {
        console.error(
            "[BK KICK MONITOR ERROR]",
            error.message
        );
    }
});

/* =========================================================
   ROLE DELETE MONITOR
========================================================= */

client.on("roleDelete", async role => {
    try {
        const guild = role.guild;

        if (!guild) return;

        const executorId =
            await findRecentAuditExecutor(
                guild,
                AuditLogEvent.RoleDelete,
                role.id
            );

        if (!executorId) return;

        await monitorAction(
            guild,
            executorId,
            "role"
        );
    } catch (error) {
        console.error(
            "[BK ROLE MONITOR ERROR]",
            error.message
        );
    }
});

/* =========================================================
   CHANNEL DELETE MONITOR
========================================================= */

client.on("channelDelete", async channel => {
    try {
        const guild = channel.guild;

        if (!guild) return;

        const executorId =
            await findRecentAuditExecutor(
                guild,
                AuditLogEvent.ChannelDelete,
                channel.id
            );

        if (!executorId) return;

        await monitorAction(
            guild,
            executorId,
            "channel"
        );
    } catch (error) {
        console.error(
            "[BK CHANNEL MONITOR ERROR]",
            error.message
        );
    }
});

/* =========================================================
   COMMAND HANDLER
========================================================= */

client.on("messageCreate", async message => {
    try {
        if (message.author.bot) {
            return;
        }

        if (!message.guild) {
            return;
        }

        if (!message.content.startsWith(PREFIX)) {
            return;
        }

        const args = message.content
            .slice(PREFIX.length)
            .trim()
            .split(/\s+/);

        const command =
            args.shift()?.toLowerCase();

        if (!command) {
            return;
        }

        /* =====================================================
           HELP
        ===================================================== */

        if (command === "help") {
            await safeSend(
                message.channel,
                helpMessage()
            );

            return;
        }

        /* =====================================================
           WHITELIST
        ===================================================== */

        if (
            command === "wl" ||
            command === "whitelist"
        ) {
            if (
                !canManageSecurity(
                    message.guild,
                    message.author.id
                )
            ) {
                await safeSend(
                    message.channel,
                    box("⚠ ERROR", [
                        "",
                        `@${message.author.username}`,
                        "you cannot manage BK.",
                        "",
                        "required → server owner"
                    ])
                );

                return;
            }

            const subcommand =
                args.shift()?.toLowerCase();

            if (subcommand === "list") {
                const settings =
                    getGuildData(message.guild.id);

                if (
                    settings.whitelist.length === 0
                ) {
                    await safeSend(
                        message.channel,
                        box("BK WHITELIST", [
                            "",
                            "no users are whitelisted."
                        ])
                    );

                    return;
                }

                const users =
                    settings.whitelist
                        .map(id => `<@${id}>`)
                        .join("\n");

                await safeSend(
                    message.channel,
                    box("BK WHITELIST", [
                        "",
                        ...users.split("\n")
                    ])
                );

                return;
            }

            const target =
                message.mentions.users.first();

            if (!target) {
                await safeSend(
                    message.channel,
                    box("⚠ ERROR", [
                        "",
                        "mention a user.",
                        "",
                        "example:",
                        "!wl add @user"
                    ])
                );

                return;
            }

            const settings =
                getGuildData(message.guild.id);

            if (subcommand === "add") {
                if (
                    !settings.whitelist.includes(
                        target.id
                    )
                ) {
                    settings.whitelist.push(
                        target.id
                    );

                    saveDatabase();
                }

                await safeSend(
                    message.channel,
                    box("✓ BK WHITELIST", [
                        "",
                        `${target.tag}`,
                        "",
                        `id → ${target.id}`,
                        "status → trusted"
                    ])
                );

                return;
            }

            if (subcommand === "remove") {
                settings.whitelist =
                    settings.whitelist.filter(
                        id => id !== target.id
                    );

                saveDatabase();

                await safeSend(
                    message.channel,
                    box("✓ BK WHITELIST", [
                        "",
                        `${target.tag}`,
                        "",
                        `id → ${target.id}`,
                        "status → removed"
                    ])
                );

                return;
            }

            await safeSend(
                message.channel,
                box("⚠ ERROR", [
                    "",
                    "unknown whitelist command.",
                    "",
                    "!wl add @user",
                    "!wl remove @user",
                    "!wl list"
                ])
            );

            return;
        }

        /* =====================================================
           SECURITY
        ===================================================== */

        if (command === "security") {
            const subcommand =
                args.shift()?.toLowerCase();

            const settings =
                getGuildData(message.guild.id);

            /* -----------------------------------------------
               STATUS
            ------------------------------------------------ */

            if (subcommand === "status") {
                const whitelistCount =
                    settings.whitelist.length;

                await safeSend(
                    message.channel,
                    box("BK SECURITY", [
                        "",
                        `status → ${settings.enabled ? "enabled" : "disabled"}`,
                        `punishment → ${settings.punishment}`,
                        "",
                        `ban → ${settings.limits.ban}/60s`,
                        `kick → ${settings.limits.kick}/60s`,
                        `role → ${settings.limits.role}/60s`,
                        `channel → ${settings.limits.channel}/60s`,
                        "",
                        `whitelist → ${whitelistCount}`
                    ])
                );

                return;
            }

            /* -----------------------------------------------
               OWNER CHECK FOR CONFIGURATION
            ------------------------------------------------ */

            if (
                !canManageSecurity(
                    message.guild,
                    message.author.id
                )
            ) {
                await safeSend(
                    message.channel,
                    box("⚠ ERROR", [
                        "",
                        "you cannot manage BK.",
                        "",
                        "required → server owner"
                    ])
                );

                return;
            }

            /* -----------------------------------------------
               SETUP
            ------------------------------------------------ */

            if (subcommand === "setup") {
                settings.enabled = true;
                settings.logChannelId =
                    message.channel.id;

                saveDatabase();

                await safeSend(
                    message.channel,
                    box("✓ BK SECURITY", [
                        "",
                        "security protection enabled.",
                        "",
                        "anti-ban → active",
                        "anti-kick → active",
                        "anti-role → active",
                        "anti-channel → active",
                        "whitelist → active",
                        "",
                        "logs → this channel"
                    ])
                );

                return;
            }

            /* -----------------------------------------------
               ENABLE
            ------------------------------------------------ */

            if (subcommand === "enable") {
                settings.enabled = true;

                saveDatabase();

                await safeSend(
                    message.channel,
                    box("✓ BK SECURITY", [
                        "",
                        "protection enabled.",
                        "",
                        "BK is now monitoring"
                    ])
                );

                return;
            }

            /* -----------------------------------------------
               DISABLE
            ------------------------------------------------ */

            if (subcommand === "disable") {
                settings.enabled = false;

                saveDatabase();

                await safeSend(
                    message.channel,
                    box("⚠ BK SECURITY", [
                        "",
                        "protection disabled.",
                        "",
                        "BK is no longer enforcing limits."
                    ])
                );

                return;
            }

            /* -----------------------------------------------
               LIMIT
            ------------------------------------------------ */

            if (subcommand === "limit") {
                const type =
                    args.shift()?.toLowerCase();

                const value =
                    Number(args.shift());

                const validTypes = [
                    "ban",
                    "kick",
                    "role",
                    "channel",
                    "webhook"
                ];

                if (
                    !validTypes.includes(type) ||
                    !Number.isInteger(value) ||
                    value < 1 ||
                    value > 100
                ) {
                    await safeSend(
                        message.channel,
                        box("⚠ ERROR", [
                            "",
                            "invalid security limit.",
                            "",
                            "examples:",
                            "!security limit ban 3",
                            "!security limit kick 5"
                        ])
                    );

                    return;
                }

                settings.limits[type] =
                    value;

                saveDatabase();

                await safeSend(
                    message.channel,
                    box("✓ SECURITY LIMIT", [
                        "",
                        `action → ${type}`,
                        `limit → ${value}/60s`,
                        "",
                        "status → updated"
                    ])
                );

                return;
            }

            /* -----------------------------------------------
               PUNISHMENT
            ------------------------------------------------ */

            if (
                subcommand === "punishment"
            ) {
                const punishment =
                    args.shift()?.toLowerCase();

                const validPunishments = [
                    "ban",
                    "strip",
                    "both"
                ];

                if (
                    !validPunishments.includes(
                        punishment
                    )
                ) {
                    await safeSend(
                        message.channel,
                        box("⚠ ERROR", [
                            "",
                            "invalid punishment.",
                            "",
                            "available:",
                            "ban",
                            "strip",
                            "both"
                        ])
                    );

                    return;
                }

                settings.punishment =
                    punishment;

                saveDatabase();

                await safeSend(
                    message.channel,
                    box("✓ SECURITY", [
                        "",
                        `punishment → ${punishment}`,
                        "status → updated"
                    ])
                );

                return;
            }

            /* -----------------------------------------------
               LOG CHANNEL
            ------------------------------------------------ */

            if (subcommand === "logs") {
                const channel =
                    message.mentions.channels.first();

                if (!channel) {
                    await safeSend(
                        message.channel,
                        box("⚠ ERROR", [
                            "",
                            "mention a text channel.",
                            "",
                            "example:",
                            "!security logs #security"
                        ])
                    );

                    return;
                }

                settings.logChannelId =
                    channel.id;

                saveDatabase();

                await safeSend(
                    message.channel,
                    box("✓ BK LOGS", [
                        "",
                        `channel → ${channel.name}`,
                        "status → enabled"
                    ])
                );

                return;
            }

            await safeSend(
                message.channel,
                box("⚠ ERROR", [
                    "",
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
            "[BK COMMAND ERROR]",
            error
        );

        /*
         * Prevent a command exception from killing BK.
         */
        await safeSend(
            message.channel,
            box("⚠ BK ERROR", [
                "",
                "an internal error occurred.",
                "",
                "the bot is still online.",
                "check the console for details."
            ])
        ).catch(() => {});
    }
});

/* =========================================================
   READY
========================================================= */

client.once("ready", () => {
    console.log("");
    console.log("================================");
    console.log(`        ${BOT_NAME} SECURITY`);
    console.log(`        VERSION ${VERSION}`);
    console.log("================================");
    console.log(`Logged in as ${client.user.tag}`);
    console.log(`Guilds: ${client.guilds.cache.size}`);
    console.log("Security monitoring: ACTIVE");
    console.log("================================");
    console.log("");
});

/* =========================================================
   CLIENT ERRORS
========================================================= */

client.on("error", error => {
    console.error("[BK CLIENT ERROR]", error);
});

client.on("warn", warning => {
    console.warn("[BK WARNING]", warning);
});

process.on("unhandledRejection", error => {
    console.error(
        "[BK UNHANDLED REJECTION]",
        error
    );
});

process.on("uncaughtException", error => {
    console.error(
        "[BK UNCAUGHT EXCEPTION]",
        error
    );

    /*
     * Don't immediately process.exit().
     * Keeping the process alive gives the bot a chance
     * to recover from non-fatal library/API errors.
     */
});

/* =========================================================
   ENV CHECK
========================================================= */

const token =
    process.env.DISCORD_TOKEN ||
    process.env.BOT_TOKEN;

if (!token) {
    console.error(
        "[BK LOGIN ERROR] DISCORD_TOKEN is missing."
    );

    console.error(
        "Create a .env file with:"
    );

    console.error(
        "DISCORD_TOKEN=YOUR_BOT_TOKEN"
    );
} else {
    client.login(token).catch(error => {
        console.error(
            "[BK LOGIN ERROR]",
            error
        );
    });
}
