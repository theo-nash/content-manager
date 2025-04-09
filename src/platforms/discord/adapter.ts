import { IAgentRuntime, Media, cleanJsonResponse, stringToUuid, elizaLogger, extractAttributes, parseJSONObjectFromText } from "@elizaos/core";
import { ContentPiece, ContentValidationResult, FormattedContent, PerformanceMetrics, Platform, PlatformAdapter, PlatformAdapterConfig, PublishResult } from "../../types";
import { Client, GatewayIntentBits, TextChannel, MessageCreateOptions, EmbedBuilder } from "discord.js";

export class DiscordAdapter implements PlatformAdapter {
    platformId = "discord";
    platform = Platform.DISCORD;
    contentFormats: ["message"];
    capabilities = ["formatContent", "publishContent", "getPerformanceMetrics"];

    private client: Client | null = null;
    private runtime: IAgentRuntime;
    private token: string;
    private channelId: string;
    private connected: boolean = false;

    async configure(config: PlatformAdapterConfig): Promise<void> {
        elizaLogger.debug("[DiscordAdapter] Configuring Discord adapter");

        this.token = config.token as string;
        this.channelId = config.channelId as string;

        if (!this.token || !this.channelId) {
            throw new Error("Discord adapter requires token and channelId configuration");
        }
    }

    async initialize(runtime: IAgentRuntime): Promise<void> {
        elizaLogger.debug("[DiscordAdapter] Initializing Discord adapter");
        this.runtime = runtime;

        // Get token from environment if not set in config
        if (!this.token) {
            this.token = this.runtime.getSetting("DISCORD_BOT_TOKEN") || process.env.DISCORD_BOT_TOKEN;
        }

        // Get channel ID from environment if not set in config
        if (!this.channelId) {
            this.channelId = this.runtime.getSetting("DISCORD_CHANNEL_ID") || process.env.DISCORD_CHANNEL_ID;
        }

        if (!this.token || !this.channelId) {
            throw new Error("Discord adapter requires DISCORD_BOT_TOKEN and DISCORD_CHANNEL_ID settings");
        }

        // Initialize Discord client
        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
            ]
        });

        try {
            // Set up ready event
            this.client.once('ready', () => {
                elizaLogger.log(`[DiscordAdapter] Discord bot logged in as ${this.client.user.tag}`);
                this.connected = true;
            });

            // Login to Discord
            await this.client.login(this.token);

            // Wait for ready event
            await new Promise<void>((resolve, reject) => {
                if (this.connected) {
                    resolve();
                    return;
                }

                const timeout = setTimeout(() => {
                    reject(new Error("Discord connection timed out"));
                }, 30000);

                this.client.once('ready', () => {
                    clearTimeout(timeout);
                    resolve();
                });
            });

            elizaLogger.log("[DiscordAdapter] Discord adapter initialized successfully");
        }
        catch (error) {
            elizaLogger.error(`[DiscordAdapter] Error initializing Discord client: ${error}`);
            this.connected = false;
            throw error;
        }
    }

    async validateContent(content: ContentPiece): Promise<ContentValidationResult> {
        elizaLogger.debug("[DiscordAdapter] Validating content");

        if (!content.generatedContent) {
            return { isValid: false, errors: ["Content is empty"] };
        }

        try {
            // Parse the generated content
            const parsedContent = parseJSONObjectFromText(content.generatedContent);

            // Basic validation rules for Discord
            const errors = [];

            if (parsedContent?.text && parsedContent.text.length > 2000) {
                errors.push("Discord message text exceeds 2000 character limit");
            }

            if (parsedContent?.embeds && parsedContent.embeds.length > 10) {
                errors.push("Discord allows a maximum of 10 embeds per message");
            }

            // Check embed fields if present
            if (parsedContent?.embeds) {
                for (const embed of parsedContent.embeds) {
                    // Title + description should be under 6000 characters
                    const titleLength = embed.title?.length || 0;
                    const descLength = embed.description?.length || 0;

                    if (titleLength + descLength > 6000) {
                        errors.push("Discord embed title + description exceeds 6000 character limit");
                    }

                    // Check fields
                    if (embed.fields && embed.fields.length > 25) {
                        errors.push("Discord embed can have a maximum of 25 fields");
                    }
                }
            }

            return {
                isValid: errors.length === 0,
                errors: errors.length > 0 ? errors : undefined,
                warnings: errors.length > 0 ? ["Some content may be truncated when posted"] : undefined
            };
        }
        catch (error) {
            elizaLogger.error(`[DiscordAdapter] Error validating content: ${error}`);
            return {
                isValid: false,
                errors: [`Error validating Discord content: ${error instanceof Error ? error.message : String(error)}`]
            };
        }
    }

    async formatContent(content: ContentPiece): Promise<FormattedContent> {
        elizaLogger.debug("[DiscordAdapter] Formatting content");

        try {
            const rawContent = cleanJsonResponse(content.generatedContent);
            let parsedContent;

            // Try parsing as JSON first
            try {
                parsedContent = parseJSONObjectFromText(rawContent);
            }
            catch (error) {
                // If not JSON, use the raw text directly
                parsedContent = { text: rawContent.trim() };
            }

            // Create the Discord message options
            const messageOptions: MessageCreateOptions = {
                content: parsedContent.text || undefined
            };

            // Add embeds if present
            if (parsedContent.embeds && Array.isArray(parsedContent.embeds)) {
                messageOptions.embeds = parsedContent.embeds.map(embed => {
                    const discordEmbed = new EmbedBuilder();

                    if (embed.title) discordEmbed.setTitle(embed.title);
                    if (embed.description) discordEmbed.setDescription(embed.description);
                    if (embed.color) discordEmbed.setColor(embed.color as any);

                    if (embed.fields && Array.isArray(embed.fields)) {
                        discordEmbed.addFields(embed.fields.map(field => ({
                            name: field.name,
                            value: field.value,
                            inline: field.inline
                        })));
                    }

                    return discordEmbed;
                });
            }

            // Add components if present
            if (parsedContent.components) {
                messageOptions.components = parsedContent.components;
            }

            const formattedContent = {
                ...content,
                formattedContent: messageOptions
            };

            return formattedContent;
        }
        catch (error) {
            elizaLogger.error(`[DiscordAdapter] Error formatting content: ${error}`);
            throw error;
        }
    }

    async publishContent(content: FormattedContent): Promise<PublishResult> {
        elizaLogger.debug("[DiscordAdapter] Publishing content");

        if (!this.client || !this.connected) {
            throw new Error("Discord client not initialized or connected");
        }

        try {
            // Get the channel
            const channel = await this.client.channels.fetch(this.channelId);

            if (!channel || !(channel instanceof TextChannel)) {
                throw new Error(`Invalid Discord channel: ${this.channelId}`);
            }

            // Send the message
            const message = await channel.send(content.formattedContent);

            return {
                success: true,
                publishedUrl: message.url,
                publishedId: message.id,
                timestamp: new Date(message.createdTimestamp),
                platformId: message.id
            };
        }
        catch (error) {
            elizaLogger.error(`[DiscordAdapter] Error publishing content: ${error}`);
            return {
                success: false,
                timestamp: new Date(),
                error: `Error publishing to Discord: ${error instanceof Error ? error.message : String(error)}`
            };
        }
    }

    async getPerformanceMetrics(contentId: string): Promise<PerformanceMetrics> {
        elizaLogger.debug("[DiscordAdapter] Getting performance metrics");

        if (!this.client || !this.connected) {
            throw new Error("Discord client not initialized or connected");
        }

        try {
            // Get the channel
            const channel = await this.client.channels.fetch(this.channelId);

            if (!channel || !(channel instanceof TextChannel)) {
                throw new Error(`Invalid Discord channel: ${this.channelId}`);
            }

            // Get the message
            const message = await channel.messages.fetch(contentId);

            if (!message) {
                throw new Error(`Message not found: ${contentId}`);
            }

            // Basic metrics for Discord
            const metrics: PerformanceMetrics = {
                reactions: message.reactions.cache.reduce((total, reaction) => total + reaction.count, 0),
                // Discord doesn't have built-in view counts
                engagements: message.reactions.cache.reduce((total, reaction) => total + reaction.count, 0),
            };

            return metrics;
        }
        catch (error) {
            elizaLogger.error(`[DiscordAdapter] Error getting metrics: ${error}`);
            throw error;
        }
    }

    async checkConnection(): Promise<boolean> {
        return this.connected && !!this.client;
    }
}