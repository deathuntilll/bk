import "dotenv/config";

import {
    Client,
    GatewayIntentBits,
    Partials,
    PermissionsBitField,
    AuditLogEvent
} from "discord.js";

import fs from "node:fs";
import path from "node:path";

/* =========================================================
   BK CONFIG
========================================================= */

const PREFIX = "!";
const BOT_NAME = "BK";
const VERSION = "2.0.0";

const DATA_DIR = path.join(process.cwd(), "data");
const DATA_FILE = path.join(DATA_DIR, "bk.json");
const BACKUP_FILE = path.join(DATA_DIR, "bk.backup.json");

const WINDOW_MS = 60_000;
const AUDIT_LOOKBACK_MS = 15_000;

/*
 * Default security limits.
 *
 * These are PER USER, PER SERVER, PER 60 SECONDS.
 */
const DEFAULT_LIMITS = Object.freeze({
    ban: 3,
    kick: 5,
    role: 5,
    channel: 3,
    webhook: 3
});

const VALID_ACTIONS = new Set([
    "ban",
    "kick",
    "role",
    "channel",
    "webhook"
]);

const VALID_PUNISHMENTS = new Set([
    "ban",
    "strip",
    "both"
]);

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
   RUNTIME STATE
========================================================= */

/*
 * Counters are intentionally runtime-only.
 *
 * guildId
 *   └── userId
 *        └── action
 *             └── timestamps[]
 */
const counters = new Map();

/*
 * Prevent the same audit-log event from being processed twice.
 */
const processedEvents = new Map();

/*
 * Prevent repeated punishments from racing each other.
 */
const punishmentLocks = new Set();

/* =========================================================
   DATABASE
========================================================= */

function defaultGuildConfig() {
    return {
        enabled: true,

        logChannelId: null,

        whitelist: [],

        punishment: "ban",

        limits: {
            ban: DEFAULT_LIMITS.ban,
            kick: DEFAULT_LIMITS.kick,
            role: DEFAULT_LIMITS.role,
            channel: DEFAULT_LIMITS.channel,
            webhook: DEFAULT_LIMITS.webhook
        }
    };
}

function ensureDataDirectory() {
    try {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, {
                recursive: true
            });
        }

        return true;
    } catch (error) {
        console.error(
            "[BK DATABASE] Could not create data directory:",
            error
        );

        return false;
    }
}

function loadDatabase() {
    if (!ensureDataDirectory()) {
        return {};
    }

    try {
        if (!fs.existsSync(DATA_FILE)) {
            fs.writeFileSync(
                DATA_FILE,
                JSON.stringify({}, null, 4),
                "utf8"
            );

            return {};
        }

        const raw = fs.readFileSync(
            DATA_FILE,
            "utf8"
        );

        if (!raw.trim()) {
            return {};
        }

        const parsed = JSON.parse(raw);

        if (
            !parsed ||
            typeof parsed !== "object" ||
            Array.isArray(parsed)
        ) {
            throw new Error(
                "Database root must be an object."
            );
        }

        return parsed;
    } catch (error) {
        console.error(
            "[BK DATABASE] Database could not be read:",
            error
        );

        /*
         * Preserve the broken file before recovering.
         */
        try {
            if (fs.existsSync(DATA_FILE)) {
                fs.copyFileSync(
                    DATA_FILE,
                    BACKUP_FILE
                );

                console.warn(
                    "[BK DATABASE] Broken database backed up."
                );
            }
        } catch (backupError) {
            console.error(
                "[BK DATABASE] Backup failed:",
                backupError
            );
        }

        /*
         * Recover with a clean database.
         */
        return {};
    }
}

let database = loadDatabase();

function saveDatabase() {
    if (!ensureDataDirectory()) {
        return false;
    }

    const tempFile =
        `${DATA_FILE}.tmp`;

    try {
        /*
         * Write to a temporary file first.
         *
         * This prevents a partially-written JSON file
         * if the process has an I/O problem.
         */
        fs.writeFileSync(
            tempFile,
            JSON.stringify(
                database,
                null,
                4
            ),
            "utf8"
        );

        fs.renameSync(
            tempFile,
            DATA_FILE
        );

        return true;
    } catch (error) {
        console.error(
            "[BK DATABASE] Save failed:",
            error
        );

        try {
            if (fs.existsSync(tempFile)) {
                fs.unlinkSync(tempFile);
            }
        } catch {}

        return false;
    }
}

function getGuildConfig(guildId) {
    if (!guildId) {
        return defaultGuildConfig();
    }

    if (
        !database[guildId] ||
        typeof database[guildId] !== "object"
    ) {
        database[guildId] =
            defaultGuildConfig();

        saveDatabase();
    }

    const config =
        database[guildId];

    /*
     * Repair missing fields from older database versions.
     */
    config.enabled =
        typeof config.enabled === "boolean"
            ? config.enabled
            : true;

    config.logChannelId ??= null;

    if (!Array.isArray(config.whitelist)) {
        config.whitelist = [];
    }

    if (
        !VALID_PUNISHMENTS.has(
            config.punishment
        )
    ) {
        config.punishment = "ban";
    }

    if (
        !config.limits ||
        typeof config.limits !== "object"
    ) {
        config.limits = {
            ...DEFAULT_LIMITS
        };
    }

    for (const action of Object.keys(DEFAULT_LIMITS)) {
        const value =
            Number(config.limits[action]);

        if (
            !Number.isInteger(value) ||
            value < 1 ||
            value > 100
        ) {
            config.limits[action] =
                DEFAULT_LIMITS[action];
        }
    }

    return config;
}

/* =========================================================
   SAFE UTILITIES
========================================================= */

function safeString(value, fallback = "unknown") {
    if (
        value === null ||
        value === undefined
    ) {
        return fallback;
    }

    return String(value);
}

function truncate(value, max = 200) {
    return safeString(value).slice(0, max);
}

function sleep(ms) {
    return new Promise(resolve =>
        setTimeout(resolve, ms)
    );
}

/* =========================================================
   BOX MESSAGES
========================================================= */

function makeBox(title, lines = []) {
    const width = 34;

    const top =
        `╭${"─".repeat(width)}╮`;

    const divider =
        `├${"─".repeat(width)}┤`;

    const bottom =
        `╰${"─".repeat(width)}╯`;

    const output = [
        top,
        `│${center(title, width)}│`,
        divider
    ];

    for (const line of lines) {
        const clean =
            truncate(line, width - 2);

        output.push(
            `│ ${clean.padEnd(width - 2)} │`
        );
    }

    output.push(bottom);
    output.push(`│ ${BOT_NAME} • SECURITY`);

    return output.join("\n");
}

function center(value, width) {
    const text =
        truncate(value, width);

    const left =
        Math.floor(
            (width - text.length) / 2
        );

    const right =
        width - text.length - left;

    return (
        " ".repeat(Math.max(0, left)) +
        text +
        " ".repeat(Math.max(0, right))
    );
}

/* =========================================================
   SAFE DISCORD SEND
========================================================= */

async function safeSend(channel, content) {
    try {
        if (
            !channel ||
            !channel.isTextBased()
        ) {
            return null;
        }

        return await channel.send({
            content: truncate(
                content,
                2000
            )
        });
    } catch (error) {
        console.error(
            "[BK SEND ERROR]",
            error?.message || error
        );

        return null;
    }
}

/* =========================================================
   PERMISSION HELPERS
========================================================= */

function isServerOwner(guild, userId) {
    return (
        Boolean(guild) &&
        guild.ownerId === userId
    );
}

function isBKWhitelisted(guild, userId) {
    if (!guild || !userId) {
        return false;
    }

    if (
        isServerOwner(
            guild,
            userId
        )
    ) {
        return true;
    }

    const config =
        getGuildConfig(guild.id);

    return config.whitelist.includes(
        userId
    );
}

function canConfigureBK(
    guild,
    userId
) {
    /*
     * Security settings are owner-only.
     */
    return isServerOwner(
        guild,
        userId
    );
}

/* =========================================================
   COUNTERS
========================================================= */

function getUserActionArray(
    guildId,
    userId,
    action
) {
    if (!counters.has(guildId)) {
        counters.set(
            guildId,
            new Map()
        );
    }

    const guildMap =
        counters.get(guildId);

    if (!guildMap.has(userId)) {
        guildMap.set(
            userId,
            {}
        );
    }

    const userMap =
        guildMap.get(userId);

    if (!Array.isArray(userMap[action])) {
        userMap[action] = [];
    }

    return userMap[action];
}

function cleanTimestamps(
    timestamps,
    now = Date.now()
) {
    while (
        timestamps.length > 0 &&
        now - timestamps[0] > WINDOW_MS
    ) {
        timestamps.shift();
    }
}

function addAction(
    guildId,
    userId,
    action
) {
    const now = Date.now();

    const timestamps =
        getUserActionArray(
            guildId,
            userId,
            action
        );

    cleanTimestamps(
        timestamps,
        now
    );

    timestamps.push(now);

    return timestamps.length;
}

function clearUserCounters(
    guildId,
    userId
) {
    const guildMap =
        counters.get(guildId);

    if (!guildMap) {
        return;
    }

    guildMap.delete(userId);
}

/* =========================================================
   EVENT DEDUPLICATION
========================================================= */

function eventWasProcessed(eventKey) {
    const now = Date.now();

    /*
     * Clean old entries.
     */
    for (
        const [key, timestamp]
        of processedEvents
    ) {
        if (
            now - timestamp >
            WINDOW_MS
        ) {
            processedEvents.delete(key);
        }
    }

    if (
        processedEvents.has(
            eventKey
        )
    ) {
        return true;
    }

    processedEvents.set(
        eventKey,
        now
    );

    return false;
}

/* =========================================================
   SECURITY LOG
========================================================= */

async function securityLog(
    guild,
    content
) {
    try {
        if (!guild) {
            return;
        }

        const config =
            getGuildConfig(guild.id);

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

        await safeSend(
            channel,
            content
        );
    } catch (error) {
        console.error(
            "[BK LOG ERROR]",
            error?.message || error
        );
    }
}

/* =========================================================
   AUDIT LOG
========================================================= */

async function findExecutor(
    guild,
    type,
    targetId
) {
    try {
        if (!guild) {
            return null;
        }

        const logs =
            await guild.fetchAuditLogs({
                type,
                limit: 10
            });

        const now =
            Date.now();

        const entry =
            logs.entries.find(
                auditEntry => {
                    if (!auditEntry) {
                        return false;
                    }

                    if (
                        targetId &&
                        auditEntry.targetId !==
                            targetId
                    ) {
                        return false;
                    }

                    if (
                        !auditEntry.createdTimestamp
                    ) {
                        return false;
                    }

                    return (
                        now -
                            auditEntry.createdTimestamp <=
                        AUDIT_LOOKBACK_MS
                    );
                }
            );

        return entry?.executorId || null;
    } catch (error) {
        /*
         * VERY IMPORTANT:
         *
         * If BK can't read the audit log,
         * it does NOT guess who did the action.
         *
         * Guessing could cause an innocent admin
         * to be punished.
         */
        console.error(
            "[BK AUDIT ERROR]",
            error?.message || error
        );

        return null;
    }
}

/* =========================================================
   ROLE STRIPPING
========================================================= */

async function stripDangerousRoles(
    guild,
    userId
) {
    try {
        if (
            !guild ||
            !userId ||
            isServerOwner(
                guild,
                userId
            )
        ) {
            return false;
        }

        const me =
            guild.members.me;

        if (!me) {
            return false;
        }

        if (
            !me.permissions.has(
                PermissionsBitField.Flags.ManageRoles
            )
        ) {
            return false;
        }

        const member =
            await guild.members
                .fetch(userId)
                .catch(() => null);

        if (!member) {
            return false;
        }

        /*
         * Discord's role hierarchy still applies.
         */
        const removable =
            member.roles.cache.filter(
                role =>
                    role.id !== guild.id &&
                    !role.managed &&
                    role.position <
                        me.roles.highest.position
            );

        if (!removable.size) {
            return false;
        }

        await member.roles.remove(
            removable,
            "BK Security - limit exceeded"
        );

        return true;
    } catch (error) {
        console.error(
            "[BK STRIP ERROR]",
            error?.message || error
        );

        return false;
    }
}

/* =========================================================
   BAN
========================================================= */

async function safeBan(
    guild,
    userId,
    reason
) {
    try {
        if (
            !guild ||
            !userId
        ) {
            return false;
        }

        if (
            isServerOwner(
                guild,
                userId
            )
        ) {
            return false;
        }

        const me =
            guild.members.me;

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

        const member =
            await guild.members
                .fetch(userId)
                .catch(() => null);

        if (member) {
            if (
                member.roles.highest.position >=
                me.roles.highest.position
            ) {
                console.warn(
                    `[BK] Cannot ban ${userId}; role hierarchy prevents it.`
                );

                return false;
            }
        }

        await guild.members.ban(
            userId,
            {
                reason: truncate(
                    reason,
                    500
                )
            }
        );

        return true;
    } catch (error) {
        console.error(
            "[BK BAN ERROR]",
            error?.message || error
        );

        return false;
    }
}

/* =========================================================
   PUNISHMENT
========================================================= */

async function enforceLimit(
    guild,
    userId,
    action,
    count,
    limit
) {
    if (!guild || !userId) {
        return;
    }

    const lockKey =
        `${guild.id}:${userId}:${action}`;

    /*
     * Prevent multiple simultaneous punishments.
     */
    if (punishmentLocks.has(lockKey)) {
        return;
    }

    punishmentLocks.add(lockKey);

    try {
        if (
            isServerOwner(
                guild,
                userId
            )
        ) {
            return;
        }

        if (
            isBKWhitelisted(
                guild,
                userId
            )
        ) {
            return;
        }

        const config =
            getGuildConfig(guild.id);

        const reason =
            `BK Security | ${action} limit exceeded | ` +
            `${count}/${limit} in 60 seconds | ` +
            `User ID: ${userId}`;

        let stripped = false;
        let banned = false;

        if (
            config.punishment ===
                "strip" ||
            config.punishment ===
                "both"
        ) {
            stripped =
                await stripDangerousRoles(
                    guild,
                    userId
                );
        }

        if (
            config.punishment ===
                "ban" ||
            config.punishment ===
                "both"
        ) {
            banned =
                await safeBan(
                    guild,
                    userId,
                    reason
                );
        }

        clearUserCounters(
            guild.id,
            userId
        );

        const actions = [];

        if (stripped) {
            actions.push(
                "roles stripped"
            );
        }

        if (banned) {
            actions.push(
                "user banned"
            );
        }

        if (!actions.length) {
            actions.push(
                "punishment failed"
            );
        }

        const message =
            makeBox(
                "⚠ BK SECURITY",
                [
                    "",
                    "abnormal activity detected.",
                    "",
                    `user → ${userId}`,
                    `action → ${action}`,
                    `count → ${count}/${limit}`,
                    "",
                    `reason → ${action} limit exceeded`,
                    `action → ${actions.join(" + ")}`
                ]
            );

        await securityLog(
            guild,
            message
        );
    } catch (error) {
        console.error(
            "[BK ENFORCEMENT ERROR]",
            error?.message || error
        );
    } finally {
        /*
         * Always release the lock.
         */
        punishmentLocks.delete(
            lockKey
        );
    }
}

/* =========================================================
   MONITOR ACTION
========================================================= */

async function monitorAction(
    guild,
    executorId,
    action
) {
    try {
        if (
            !guild ||
            !executorId
        ) {
            return;
        }

        if (
            !VALID_ACTIONS.has(
                action
            )
        ) {
            return;
        }

        /*
         * Never punish BK.
         */
        if (
            client.user &&
            executorId ===
                client.user.id
        ) {
            return;
        }

        /*
         * Owner is always exempt.
         */
        if (
            isServerOwner(
                guild,
                executorId
            )
        ) {
            return;
        }

        /*
         * Whitelisted users bypass
         * automatic punishment.
         */
        if (
            isBKWhitelisted(
                guild,
                executorId
            )
        ) {
            return;
        }

        const config =
            getGuildConfig(
                guild.id
            );

        if (!config.enabled) {
            return;
        }

        const limit =
            Number(
                config.limits[action]
            );

        if (
            !Number.isInteger(limit) ||
            limit < 1
        ) {
            return;
        }

        const count =
            addAction(
                guild.id,
                executorId,
                action
            );

        /*
         * Normal activity.
         */
        if (count <= limit) {
            return;
        }

        await enforceLimit(
            guild,
            executorId,
            action,
            count,
            limit
        );
    } catch (error) {
        console.error(
            "[BK MONITOR ERROR]",
            error?.message || error
        );
    }
}

/* =========================================================
   BAN EVENT
========================================================= */

client.on(
    "guildBanAdd",
    async ban => {
        try {
            if (!ban?.guild) {
                return;
            }

            const executorId =
                await findExecutor(
                    ban.guild,
                    AuditLogEvent.MemberBanAdd,
                    ban.user?.id
                );

            /*
             * NEVER guess.
             */
            if (!executorId) {
                return;
            }

            const eventKey =
                `ban:${ban.guild.id}:${ban.user.id}:${executorId}`;

            if (
                eventWasProcessed(
                    eventKey
                )
            ) {
                return;
            }

            await monitorAction(
                ban.guild,
                executorId,
                "ban"
            );
        } catch (error) {
            console.error(
                "[BK BAN EVENT ERROR]",
                error?.message || error
            );
        }
    }
);

/* =========================================================
   KICK EVENT
========================================================= */

client.on(
    "guildMemberRemove",
    async member => {
        try {
            if (!member?.guild) {
                return;
            }

            const executorId =
                await findExecutor(
                    member.guild,
                    AuditLogEvent.MemberKick,
                    member.id
                );

            /*
             * A normal leave has no kick audit entry.
             */
            if (!executorId) {
                return;
            }

            const eventKey =
                `kick:${member.guild.id}:${member.id}:${executorId}`;

            if (
                eventWasProcessed(
                    eventKey
                )
            ) {
                return;
            }

            await monitorAction(
                member.guild,
                executorId,
                "kick"
            );
        } catch (error) {
            console.error(
                "[BK KICK EVENT ERROR]",
                error?.message || error
            );
        }
    }
);

/* =========================================================
   ROLE DELETE
========================================================= */

client.on(
    "roleDelete",
    async role => {
        try {
            if (!role?.guild) {
                return;
            }

            const executorId =
                await findExecutor(
                    role.guild,
                    AuditLogEvent.RoleDelete,
                    role.id
                );

            if (!executorId) {
                return;
            }

            const eventKey =
                `role:${role.guild.id}:${role.id}:${executorId}`;

            if (
                eventWasProcessed(
                    eventKey
                )
            ) {
                return;
            }

            await monitorAction(
                role.guild,
                executorId,
                "role"
            );
        } catch (error) {
            console.error(
                "[BK ROLE EVENT ERROR]",
                error?.message || error
            );
        }
    }
);

/* =========================================================
   CHANNEL DELETE
========================================================= */

client.on(
    "channelDelete",
    async channel => {
        try {
            if (!channel?.guild) {
                return;
            }

            const executorId =
                await findExecutor(
                    channel.guild,
                    AuditLogEvent.ChannelDelete,
                    channel.id
                );

            if (!executorId) {
                return;
            }

            const eventKey =
                `channel:${channel.guild.id}:${channel.id}:${executorId}`;

            if (
                eventWasProcessed(
                    eventKey
                )
            ) {
                return;
            }

            await monitorAction(
                channel.guild,
                executorId,
                "channel"
            );
        } catch (error) {
            console.error(
                "[BK CHANNEL EVENT ERROR]",
                error?.message || error
            );
        }
    }
);

/* =========================================================
   WEBHOOK UPDATE / CREATE / DELETE MONITOR
========================================================= */

client.on(
    "webhooksUpdate",
    async channel => {
        try {
            if (!channel?.guild) {
                return;
            }

            /*
             * Discord's webhooksUpdate event does not tell us
             * which webhook action happened.
             *
             * We therefore inspect the recent audit log and
             * only count a verified webhook action.
             */
            const auditTypes = [
                AuditLogEvent.WebhookCreate,
                AuditLogEvent.WebhookUpdate,
                AuditLogEvent.WebhookDelete
            ];

            for (const type of auditTypes) {
                const executorId =
                    await findExecutor(
                        channel.guild,
                        type,
                        null
                    );

                if (!executorId) {
                    continue;
                }

                const eventKey =
                    `webhook:${channel.guild.id}:${executorId}:${type}`;

                if (
                    eventWasProcessed(
                        eventKey
                    )
                ) {
                    continue;
                }

                await monitorAction(
                    channel.guild,
                    executorId,
                    "webhook"
                );

                break;
            }
        } catch (error) {
            console.error(
                "[BK WEBHOOK EVENT ERROR]",
                error?.message || error
            );
        }
    }
);

/* =========================================================
   COMMAND HELP
========================================================= */

function helpMessage() {
    return makeBox(
        "BK SECURITY",
        [
            "",
            "!help",
            "show this panel",
            "",
            "!wl add @user",
            "whitelist user",
            "",
            "!wl remove @user",
            "remove whitelist",
            "",
            "!wl list",
            "show whitelist",
            "",
            "!security setup",
            "enable + configure BK",
            "",
            "!security status",
            "show protection status",
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
        ]
    );
}

/* =========================================================
   COMMAND PERMISSION ERROR
========================================================= */

async function sendPermissionError(
    channel,
    user
) {
    await safeSend(
        channel,
        makeBox(
            "⚠ ERROR",
            [
                "",
                `${user.username}`,
                "you are not authorized.",
                "",
                "required → server owner"
            ]
        )
    );
}

/* =========================================================
   COMMAND HANDLER
========================================================= */

client.on(
    "messageCreate",
    async message => {
        /*
         * This entire event is isolated.
         * A command error cannot kill BK.
         */
        try {
            if (
                !message ||
                message.author?.bot ||
                !message.guild
            ) {
                return;
            }

            const content =
                safeString(
                    message.content,
                    ""
                );

            if (
                !content.startsWith(
                    PREFIX
                )
            ) {
                return;
            }

            const parts =
                content
                    .slice(PREFIX.length)
                    .trim()
                    .split(/\s+/)
                    .filter(Boolean);

            const command =
                parts
                    .shift()
                    ?.toLowerCase();

            if (!command) {
                return;
            }

            /* =============================================
               HELP
            ============================================= */

            if (
                command === "help" ||
                command === "h"
            ) {
                await safeSend(
                    message.channel,
                    helpMessage()
                );

                return;
            }

            /* =============================================
               WHITELIST
            ============================================= */

            if (
                command === "wl" ||
                command === "whitelist"
            ) {
                if (
                    !canConfigureBK(
                        message.guild,
                        message.author.id
                    )
                ) {
                    await sendPermissionError(
                        message.channel,
                        message.author
                    );

                    return;
                }

                const subcommand =
                    parts
                        .shift()
                        ?.toLowerCase();

                const config =
                    getGuildConfig(
                        message.guild.id
                    );

                /* LIST */

                if (
                    subcommand === "list"
                ) {
                    if (
                        config.whitelist.length ===
                        0
                    ) {
                        await safeSend(
                            message.channel,
                            makeBox(
                                "BK WHITELIST",
                                [
                                    "",
                                    "no users whitelisted."
                                ]
                            )
                        );

                        return;
                    }

                    const lines = [
                        "",
                        `users → ${config.whitelist.length}`,
                        ""
                    ];

                    for (
                        const id
                        of config.whitelist.slice(
                            0,
                            15
                        )
                    ) {
                        lines.push(
                            `• ${id}`
                        );
                    }

                    await safeSend(
                        message.channel,
                        makeBox(
                            "BK WHITELIST",
                            lines
                        )
                    );

                    return;
                }

                /* ADD / REMOVE */

                const target =
                    message.mentions.users.first();

                if (!target) {
                    await safeSend(
                        message.channel,
                        makeBox(
                            "⚠ ERROR",
                            [
                                "",
                                "mention a user.",
                                "",
                                "!wl add @user",
                                "!wl remove @user"
                            ]
                        )
                    );

                    return;
                }

                if (
                    subcommand === "add"
                ) {
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
                        makeBox(
                            "✓ BK WHITELIST",
                            [
                                "",
                                `user → ${target.username}`,
                                `id → ${target.id}`,
                                "",
                                "status → trusted"
                            ]
                        )
                    );

                    return;
                }

                if (
                    subcommand === "remove"
                ) {
                    config.whitelist =
                        config.whitelist.filter(
                            id =>
                                id !==
                                target.id
                        );

                    saveDatabase();

                    await safeSend(
                        message.channel,
                        makeBox(
                            "✓ BK WHITELIST",
                            [
                                "",
                                `user → ${target.username}`,
                                `id → ${target.id}`,
                                "",
                                "status → removed"
                            ]
                        )
                    );

                    return;
                }

                await safeSend(
                    message.channel,
                    makeBox(
                        "⚠ ERROR",
                        [
                            "",
                            "unknown whitelist command.",
                            "",
                            "!wl add @user",
                            "!wl remove @user",
                            "!wl list"
                        ]
                    )
                );

                return;
            }

            /* =============================================
               SECURITY
            ============================================= */

            if (
                command === "security"
            ) {
                const subcommand =
                    parts
                        .shift()
                        ?.toLowerCase();

                const config =
                    getGuildConfig(
                        message.guild.id
                    );

                /* STATUS IS SAFE FOR EVERYONE */

                if (
                    subcommand ===
                    "status"
                ) {
                    await safeSend(
                        message.channel,
                        makeBox(
                            "BK SECURITY",
                            [
                                "",
                                `status → ${config.enabled ? "enabled" : "disabled"}`,
                                `punishment → ${config.punishment}`,
                                "",
                                `ban → ${config.limits.ban}/60s`,
                                `kick → ${config.limits.kick}/60s`,
                                `role → ${config.limits.role}/60s`,
                                `channel → ${config.limits.channel}/60s`,
                                `webhook → ${config.limits.webhook}/60s`,
                                "",
                                `whitelist → ${config.whitelist.length}`
                            ]
                        )
                    );

                    return;
                }

                /*
                 * Everything below this point modifies
                 * BK's security configuration.
                 */
                if (
                    !canConfigureBK(
                        message.guild,
                        message.author.id
                    )
                ) {
                    await sendPermissionError(
                        message.channel,
                        message.author
                    );

                    return;
                }

                /* SETUP */

                if (
                    subcommand ===
                    "setup"
                ) {
                    config.enabled = true;
                    config.logChannelId =
                        message.channel.id;

                    saveDatabase();

                    await safeSend(
                        message.channel,
                        makeBox(
                            "✓ BK SECURITY",
                            [
                                "",
                                "protection enabled.",
                                "",
                                "anti-ban → active",
                                "anti-kick → active",
                                "anti-role → active",
                                "anti-channel → active",
                                "anti-webhook → active",
                                "whitelist → active",
                                "",
                                "logs → this channel"
                            ]
                        )
                    );

                    return;
                }

                /* ENABLE */

                if (
                    subcommand ===
                    "enable"
                ) {
                    config.enabled = true;

                    saveDatabase();

                    await safeSend(
                        message.channel,
                        makeBox(
                            "✓ BK SECURITY",
                            [
                                "",
                                "protection enabled.",
                                "",
                                "BK is monitoring."
                            ]
                        )
                    );

                    return;
                }

                /* DISABLE */

                if (
                    subcommand ===
                    "disable"
                ) {
                    config.enabled = false;

                    saveDatabase();

                    await safeSend(
                        message.channel,
                        makeBox(
                            "⚠ BK SECURITY",
                            [
                                "",
                                "protection disabled.",
                                "",
                                "BK is not enforcing limits."
                            ]
                        )
                    );

                    return;
                }

                /* LIMIT */

                if (
                    subcommand ===
                    "limit"
                ) {
                    const action =
                        parts
                            .shift()
                            ?.toLowerCase();

                    const value =
                        Number(
                            parts.shift()
                        );

                    if (
                        !VALID_ACTIONS.has(
                            action
                        ) ||
                        !Number.isInteger(
                            value
                        ) ||
                        value < 1 ||
                        value > 100
                    ) {
                        await safeSend(
                            message.channel,
                            makeBox(
                                "⚠ ERROR",
                                [
                                    "",
                                    "invalid limit.",
                                    "",
                                    "!security limit ban 3",
                                    "!security limit kick 5",
                                    "!security limit role 5"
                                ]
                            )
                        );

                        return;
                    }

                    config.limits[action] =
                        value;

                    saveDatabase();

                    await safeSend(
                        message.channel,
                        makeBox(
                            "✓ SECURITY LIMIT",
                            [
                                "",
                                `action → ${action}`,
                                `limit → ${value}/60s`,
                                "",
                                "status → updated"
                            ]
                        )
                    );

                    return;
                }

                /* PUNISHMENT */

                if (
                    subcommand ===
                    "punishment"
                ) {
                    const punishment =
                        parts
                            .shift()
                            ?.toLowerCase();

                    if (
                        !VALID_PUNISHMENTS.has(
                            punishment
                        )
                    ) {
                        await safeSend(
                            message.channel,
                            makeBox(
                                "⚠ ERROR",
                                [
                                    "",
                                    "invalid punishment.",
                                    "",
                                    "ban",
                                    "strip",
                                    "both"
                                ]
                            )
                        );

                        return;
                    }

                    config.punishment =
                        punishment;

                    saveDatabase();

                    await safeSend(
                        message.channel,
                        makeBox(
                            "✓ BK SECURITY",
                            [
                                "",
                                `punishment → ${punishment}`,
                                "status → updated"
                            ]
                        )
                    );

                    return;
                }

                /* LOGS */

                if (
                    subcommand ===
                    "logs"
                ) {
                    const channel =
                        message.mentions.channels.first();

                    if (!channel) {
                        await safeSend(
                            message.channel,
                            makeBox(
                                "⚠ ERROR",
                                [
                                    "",
                                    "mention a channel.",
                                    "",
                                    "!security logs #security"
                                ]
                            )
                        );

                        return;
                    }

                    config.logChannelId =
                        channel.id;

                    saveDatabase();

                    await safeSend(
                        message.channel,
                        makeBox(
                            "✓ BK LOGS",
                            [
                                "",
                                `channel → ${channel.name}`,
                                "status → enabled"
                            ]
                        )
                    );

                    return;
                }

                await safeSend(
                    message.channel,
                    makeBox(
                        "⚠ ERROR",
                        [
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
                        ]
                    )
                );
            }
        } catch (error) {
            console.error(
                "[BK COMMAND ERROR]",
                error
            );

            /*
             * Last line of defense for this command.
             */
            try {
                await safeSend(
                    message.channel,
                    makeBox(
                        "⚠ BK ERROR",
                        [
                            "",
                            "the command failed.",
                            "",
                            "BK remains online."
                        ]
                    )
                );
            } catch {}
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
        console.log(
            "======================================"
        );
        console.log(
            `             ${BOT_NAME}`
        );
        console.log(
            `          SECURITY ${VERSION}`
        );
        console.log(
            "======================================"
        );
        console.log(
            `Logged in as: ${client.user.tag}`
        );
        console.log(
            `Guilds: ${client.guilds.cache.size}`
        );
        console.log(
            "Anti-nuke: ACTIVE"
        );
        console.log(
            "ID tracking: ACTIVE"
        );
        console.log(
            "Audit verification: ACTIVE"
        );
        console.log(
            "Error recovery: ACTIVE"
        );
        console.log(
            "======================================"
        );
        console.log("");
    }
);

/* =========================================================
   LOGIN
========================================================= */

const token =
    process.env.DISCORD_TOKEN;

if (!token) {
    console.error("");
    console.error(
        "======================================"
    );
    console.error(
        "[BK LOGIN ERROR]"
    );
    console.error(
        "DISCORD_TOKEN is missing."
    );
    console.error(
        "======================================"
    );
    console.error("");
} else {
    client.login(token).catch(
        error => {
            console.error(
                "[BK LOGIN ERROR]",
                error
            );
        }
    );
}

/* =========================================================
   PROCESS SAFETY
========================================================= */

process.on(
    "unhandledRejection",
    error => {
        console.error(
            "[BK UNHANDLED REJECTION]",
            error
        );
    }
);

process.on(
    "uncaughtException",
    error => {
        console.error(
            "[BK UNCAUGHT EXCEPTION]",
            error
        );

        /*
         * Do not blindly kill the bot.
         * discord.js can recover from many runtime errors.
         */
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

        process.exitCode = 0;
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

        process.exitCode = 0;
    }
);
