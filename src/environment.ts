import {
    parseBooleanFromText,
    type IAgentRuntime,
    ActionTimelineType,
    elizaLogger
} from "@elizaos/core";
import { z, ZodError } from "zod";
import { Timeframe } from "./types";

// Default values
export const DEFAULT_MICRO_PLAN_TIMEFRAME = Timeframe.WEEKLY;

// Configuration schema
export const contentPlanningConfigSchema = z.object({
    MICRO_PLAN_TIMEFRAME: z.enum([
        Timeframe.DAILY,
        Timeframe.WEEKLY,
        Timeframe.MONTHLY,
        Timeframe.QUARTERLY
    ]).default(DEFAULT_MICRO_PLAN_TIMEFRAME)
});

export type ContentPlanningConfig = z.infer<typeof contentPlanningConfigSchema>;

/**
 * Validates or constructs a ContentPlanningConfig object using values
 * from the IAgentRuntime or process.env as needed.
 */
export async function validateContentPlanningConfig(
    runtime: IAgentRuntime
): Promise<ContentPlanningConfig> {
    try {
        const config = {
            MICRO_PLAN_TIMEFRAME: (
                runtime.getSetting("DEFAULT_MICRO_PLAN_TIMEFRAME") ||
                process.env.DEFAULT_MICRO_PLAN_TIMEFRAME ||
                DEFAULT_MICRO_PLAN_TIMEFRAME
            ) as Timeframe
        };

        return contentPlanningConfigSchema.parse(config);
    } catch (error) {
        elizaLogger.error("Content planning configuration validation failed:", error);
        // Return default config on error
        return {
            MICRO_PLAN_TIMEFRAME: DEFAULT_MICRO_PLAN_TIMEFRAME
        };
    }
}

/**
 * -------- APPROVAL CONFIG -----------
 * This schema defines all required/optional environment settings for approval integration.
 */
export const DEFAULT_APPROVAL_CHANNEL = "content-approvals";
export const DEFAULT_NOTIFICATION_CHANNEL = "content-notifications";

export const approvalConfigSchema = z.object({
    APPROVAL_ENABLED: z.boolean().default(true),
    APPROVAL_AUTOAPPROVE: z.boolean().default(false),
    AUTO_REJECT_DAYS: z.number().default(7),
    APPROVAL_CHECK_INTERVAL: z.number().int().default(1),
    APPROVAL_CHANNEL: z.string().default(DEFAULT_APPROVAL_CHANNEL),
    NOTIFICATION_CHANNEL: z.string().default(DEFAULT_NOTIFICATION_CHANNEL),
});

export type ApprovalConfig = z.infer<typeof approvalConfigSchema>;

/**
 * Validates or constructs a ApprovalConfig object using values
 * from the IAgentRuntime or process.env as needed.
 */
export async function validateApprovalConfig(
    runtime: IAgentRuntime
): Promise<ApprovalConfig> {
    try {
        const config = {
            APPROVAL_ENABLED:
                parseBooleanFromText(
                    runtime.getSetting("APPROVAL_ENABLED") ||
                    process.env.APPROVAL_ENABLED
                ) ?? true,

            APPROVAL_AUTOAPPROVE:
                parseBooleanFromText(
                    runtime.getSetting("APPROVAL_AUTOAPPROVE") ||
                    process.env.APPROVAL_AUTOAPPROVE
                ) ?? false,

            AUTO_REJECT_DAYS:
                safeParseInt(
                    runtime.getSetting("AUTO_REJECT_DAYS") ||
                    process.env.AUTO_REJECT_DAYS, 7
                ),

            APPROVAL_CHECK_INTERVAL:
                safeParseInt(
                    runtime.getSetting("APPROVAL_CHECK_INTERVAL") ||
                    process.env.APPROVAL_CHECK_INTERVAL,
                    1 // 1 min
                ),

            APPROVAL_CHANNEL:
                runtime.getSetting("APPROVAL_CHANNEL") ||
                process.env.APPROVAL_CHANNEL ||
                DEFAULT_APPROVAL_CHANNEL,

            NOTIFICATION_CHANNEL:
                runtime.getSetting("NOTIFICATION_CHANNEL") ||
                process.env.NOTIFICATION_CHANNEL ||
                DEFAULT_NOTIFICATION_CHANNEL,
        };

        return approvalConfigSchema.parse(config);
    } catch (error) {
        elizaLogger.error("Approval configuration validation failed:", error);
        // Return default config on error
        return {
            APPROVAL_CHANNEL: DEFAULT_APPROVAL_CHANNEL,
            NOTIFICATION_CHANNEL: DEFAULT_NOTIFICATION_CHANNEL,
        };
    }
}

/**
 * -------- TWITTER CONFIG -----------
 * This schema defines all required/optional environment settings for twitter integration.
 */
export const DEFAULT_MAX_TWEET_LENGTH = 280;

const twitterUsernameSchema = z
    .string()
    .min(1, "An X/Twitter Username must be at least 1 character long")
    .max(15, "An X/Twitter Username cannot exceed 15 characters")
    .refine((username) => {
        // Allow wildcard '*' as a special case
        if (username === "*") return true;

        // Twitter usernames can:
        // - Start with digits now
        // - Contain letters, numbers, underscores
        // - Must not be empty
        return /^[A-Za-z0-9_]+$/.test(username);
    }, "An X Username can only contain letters, numbers, and underscores");

/**
 * This schema defines all required/optional environment settings,
 * including new fields like TWITTER_SPACES_ENABLE.
 */
export const twitterEnvSchema = z.object({
    TWITTER_DRY_RUN: z.boolean(),
    TWITTER_USERNAME: z.string().min(1, "X/Twitter username is required"),
    TWITTER_PASSWORD: z.string().min(1, "X/Twitter password is required"),
    TWITTER_EMAIL: z.string().email("Valid X/Twitter email is required"),
    MAX_TWEET_LENGTH: z.number().int().default(DEFAULT_MAX_TWEET_LENGTH),
    TWITTER_SEARCH_ENABLE: z.boolean().default(false),
    TWITTER_2FA_SECRET: z.string(),
    TWITTER_RETRY_LIMIT: z.number().int(),
    TWITTER_POLL_INTERVAL: z.number().int(),
    TWITTER_TARGET_USERS: z.array(twitterUsernameSchema).default([]),
    ENABLE_TWITTER_POST_GENERATION: z.boolean(),
    POST_INTERVAL_MIN: z.number().int(),
    POST_INTERVAL_MAX: z.number().int(),
    ENABLE_ACTION_PROCESSING: z.boolean(),
    ACTION_INTERVAL: z.number().int(),
    POST_IMMEDIATELY: z.boolean(),
    TWITTER_SPACES_ENABLE: z.boolean().default(false),
    MAX_ACTIONS_PROCESSING: z.number().int(),
    ACTION_TIMELINE_TYPE: z
        .nativeEnum(ActionTimelineType)
        .default(ActionTimelineType.ForYou),
});

export type TwitterConfig = z.infer<typeof twitterEnvSchema>;

/**
 * Helper to parse a comma-separated list of Twitter usernames
 * (already present in your code).
 */
function parseTargetUsers(targetUsersStr?: string | null): string[] {
    if (!targetUsersStr?.trim()) {
        return [];
    }
    return targetUsersStr
        .split(",")
        .map((user) => user.trim())
        .filter(Boolean);
}

function safeParseInt(
    value: string | undefined | null,
    defaultValue: number
): number {
    if (!value) return defaultValue;
    const parsed = Number.parseInt(value, 10);
    return isNaN(parsed) ? defaultValue : Math.max(1, parsed);
}

/**
 * Validates or constructs a TwitterConfig object using zod,
 * taking values from the IAgentRuntime or process.env as needed.
 */
// This also is organized to serve as a point of documentation for the client
// most of the inputs from the framework (env/character)

// we also do a lot of typing/parsing here
// so we can do it once and only once per character
export async function validateTwitterConfig(
    runtime: IAgentRuntime
): Promise<TwitterConfig> {
    try {
        const twitterConfig = {
            TWITTER_DRY_RUN:
                parseBooleanFromText(
                    runtime.getSetting("TWITTER_DRY_RUN") ||
                    process.env.TWITTER_DRY_RUN
                ) ?? false, // parseBooleanFromText return null if "", map "" to false

            TWITTER_USERNAME:
                runtime.getSetting("TWITTER_USERNAME") ||
                process.env.TWITTER_USERNAME,

            TWITTER_PASSWORD:
                runtime.getSetting("TWITTER_PASSWORD") ||
                process.env.TWITTER_PASSWORD,

            TWITTER_EMAIL:
                runtime.getSetting("TWITTER_EMAIL") ||
                process.env.TWITTER_EMAIL,

            // number as string?
            MAX_TWEET_LENGTH: safeParseInt(
                runtime.getSetting("MAX_TWEET_LENGTH") ||
                process.env.MAX_TWEET_LENGTH,
                DEFAULT_MAX_TWEET_LENGTH
            ),

            TWITTER_SEARCH_ENABLE:
                parseBooleanFromText(
                    runtime.getSetting("TWITTER_SEARCH_ENABLE") ||
                    process.env.TWITTER_SEARCH_ENABLE
                ) ?? false,

            TWITTER_ENABLE_INTELLIGENT_POST:
                parseBooleanFromText(
                    runtime.getSetting("TWITTER_ENABLE_INTELLIGENT_POST") ||
                    process.env.TWITTER_ENABLE_INTELLIGENT_POST
                ) ?? false,

            TWITTER_INTELLIGENT_POST_ENGAGEMENT_UPDATE_INTERVAL:
                safeParseInt(
                    runtime.getSetting("TWITTER_INTELLIGENT_POST_ENGAGEMENT_UPDATE_INTERVAL") ||
                    process.env.TWITTER_INTELLIGENT_POST_ENGAGEMENT_UPDATE_INTERVAL,
                    30 // 1 hour
                ),

            TWITTER_NEWS_ENABLE:
                parseBooleanFromText(
                    runtime.getSetting("TWITTER_NEWS_ENABLE") ||
                    process.env.TWITTER_NEWS_ENABLE
                ) ?? false,

            TWITTER_NEWS_INTERVAL: safeParseInt(
                runtime.getSetting("TWITTER_NEWS_INTERVAL") ||
                process.env.TWITTER_NEWS_INTERVAL,
                60 // 1 hour
            ),

            TWITTER_NEWS_MAX_COUNT: safeParseInt(
                runtime.getSetting("TWITTER_NEWS_MAX_COUNT") ||
                process.env.TWITTER_NEWS_MAX_COUNT,
                5 // 5 news items
            ),

            // string passthru
            TWITTER_2FA_SECRET:
                runtime.getSetting("TWITTER_2FA_SECRET") ||
                process.env.TWITTER_2FA_SECRET ||
                "",

            // int
            TWITTER_RETRY_LIMIT: safeParseInt(
                runtime.getSetting("TWITTER_RETRY_LIMIT") ||
                process.env.TWITTER_RETRY_LIMIT,
                5
            ),

            // int in seconds
            TWITTER_POLL_INTERVAL: safeParseInt(
                runtime.getSetting("TWITTER_POLL_INTERVAL") ||
                process.env.TWITTER_POLL_INTERVAL,
                120 // 2m
            ),

            // comma separated string
            TWITTER_TARGET_USERS: parseTargetUsers(
                runtime.getSetting("TWITTER_TARGET_USERS") ||
                process.env.TWITTER_TARGET_USERS
            ),

            // bool
            ENABLE_TWITTER_POST_GENERATION:
                parseBooleanFromText(
                    runtime.getSetting("ENABLE_TWITTER_POST_GENERATION") ||
                    process.env.ENABLE_TWITTER_POST_GENERATION
                ) ?? true,


            // int in minutes
            POST_INTERVAL_MIN: safeParseInt(
                runtime.getSetting("POST_INTERVAL_MIN") ||
                process.env.POST_INTERVAL_MIN,
                90 // 1.5 hours
            ),

            // int in minutes
            POST_INTERVAL_MAX: safeParseInt(
                runtime.getSetting("POST_INTERVAL_MAX") ||
                process.env.POST_INTERVAL_MAX,
                180 // 3 hours
            ),

            // bool
            ENABLE_ACTION_PROCESSING:
                parseBooleanFromText(
                    runtime.getSetting("ENABLE_ACTION_PROCESSING") ||
                    process.env.ENABLE_ACTION_PROCESSING
                ) ?? false,

            // init in minutes (min 1m)
            ACTION_INTERVAL: safeParseInt(
                runtime.getSetting("ACTION_INTERVAL") ||
                process.env.ACTION_INTERVAL,
                5 // 5 minutes
            ),

            // bool
            POST_IMMEDIATELY:
                parseBooleanFromText(
                    runtime.getSetting("POST_IMMEDIATELY") ||
                    process.env.POST_IMMEDIATELY
                ) ?? false,

            TWITTER_SPACES_ENABLE:
                parseBooleanFromText(
                    runtime.getSetting("TWITTER_SPACES_ENABLE") ||
                    process.env.TWITTER_SPACES_ENABLE
                ) ?? false,

            MAX_ACTIONS_PROCESSING: safeParseInt(
                runtime.getSetting("MAX_ACTIONS_PROCESSING") ||
                process.env.MAX_ACTIONS_PROCESSING,
                1
            ),

            ACTION_TIMELINE_TYPE:
                runtime.getSetting("ACTION_TIMELINE_TYPE") ||
                process.env.ACTION_TIMELINE_TYPE,
        };

        return twitterEnvSchema.parse(twitterConfig);
    } catch (error) {
        if (error instanceof ZodError) {
            const errorMessages = error.errors
                .map((err) => `${err.path.join(".")}: ${err.message}`)
                .join("\n");
            throw new Error(
                `X/Twitter configuration validation failed:\n${errorMessages}`
            );
        }
        throw error;
    }
}