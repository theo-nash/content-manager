import { IAgentRuntime, UUID, elizaLogger, stringToUuid } from "@elizaos/core";
import { Client, GatewayIntentBits, Partials, Events } from "discord.js";
import { ApprovalProvider } from "./base";
import { ApprovalRequest, ApprovalStatus, Platform } from "../types";

export class DiscordApprovalProvider implements ApprovalProvider {
    private discordClient: Client;
    private approvalChannelId: string;
    private runtime: IAgentRuntime;
    private initialized = false;
    providerName = "discord";

    async initialize(runtime: IAgentRuntime): Promise<void> {
        this.runtime = runtime;

        // Get Discord configuration
        const token = this.runtime.getSetting("CONTENT_APPROVAL_DISCORD_BOT_TOKEN");
        this.approvalChannelId = this.runtime.getSetting("CONTENT_APPROVAL_DISCORD_CHANNEL_ID");

        if (!token || !this.approvalChannelId) {
            throw new Error("Discord approval provider requires CONTENT_APPROVAL_DISCORD_BOT_TOKEN and CONTENT_APPROVAL_DISCORD_CHANNEL_ID settings");
        }

        // Create Discord client
        this.discordClient = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.GuildMessageReactions,
            ],
            partials: [Partials.Channel, Partials.Message, Partials.Reaction],
        });

        // Event handlers
        this.discordClient.once(Events.ClientReady, (readyClient) => {
            elizaLogger.log(`Discord approval bot ready! Logged in as ${readyClient.user.tag}`);

            // Generate invite link with required permissions
            const invite = `https://discord.com/api/oauth2/authorize?client_id=${readyClient.user.id}&permissions=274877991936&scope=bot`;
            // 274877991936 includes permissions for:
            // - Send Messages
            // - Read Messages/View Channels
            // - Read Message History

            elizaLogger.log(
                `Use this link to properly invite the Twitter Post Approval Discord bot: ${invite}`
            );

            this.initialized = true;
        });

        // Login to Discord
        try {
            await this.discordClient.login(token);
        }
        catch (error) {
            elizaLogger.error(`Failed to login to Discord: ${error}`);
            await this.discordClient.destroy();
            this.discordClient = null;
        }

    }

    async submitForApproval(request: ApprovalRequest): Promise<void> {
        if (!this.initialized || !this.discordClient) {
            elizaLogger.error("Discord approval provider not initialized");
            return;
        }

        try {
            // Create platform-specific embed colors
            const platformColors = {
                [Platform.TWITTER]: 0x1DA1F2,
                // Add other platforms as needed
            };

            // Create embed for Discord message
            const embed = {
                title: `New ${request.platform} Content Pending Approval`,
                description: request.content,
                fields: [
                    {
                        name: "Platform",
                        value: request.platform,
                        inline: true,
                    },
                    {
                        name: "Content ID",
                        value: request.content.id.toString(),
                        inline: true,
                    },
                    {
                        name: "Length",
                        value: request.content.formattedContent.toString(),
                        inline: true,
                    },
                ],
                footer: {
                    text: "React with 👍 to approve or ❌ to reject. This will expire after 24 hours if no response received.",
                },
                timestamp: new Date().toISOString(),
                color: platformColors[request.platform] || 0x808080,
            };

            // Fetch the channel
            const channel = await this.discordClient.channels.fetch(this.approvalChannelId);
            if (!channel || !channel.isTextBased()) {
                throw new Error("Discord approval channel not found or is not a text channel");
            }

            // Send the message with the embed
            const message = await channel.send({ embeds: [embed] });

            // Add reaction options
            await message.react('👍');
            await message.react('❌');

            // Cache the pending approval
            await this.runtime.cacheManager.set(
                `approval/${request.platform}/${request.contentId}`,
                {
                    messageId: message.id,
                    provider: this.getName(),
                    content: request.content,
                    rawContent: request.rawContent,
                    platform: request.platform,
                    contentId: request.contentId,
                    timestamp: Date.now(),
                    metadata: request.metadata,
                }
            );

            elizaLogger.log(`Content sent for Discord approval with message ID: ${message.id}`);
            ;
        } catch (error) {
            elizaLogger.error(`Error in Discord approval process: ${error}`);
        }
    }

    async checkApprovalStatus(messageId: string): Promise<ApprovalStatus> {
        if (!this.initialized || !this.discordClient) {
            throw new Error("Discord approval provider not initialized");
        }

        try {
            // Fetch the channel
            const channel = await this.discordClient.channels.fetch(this.approvalChannelId);
            if (!channel || !channel.isTextBased()) {
                throw new Error("Discord approval channel not found or is not a text channel");
            }

            // Fetch the message
            const message = await channel.messages.fetch(messageId);
            if (!message) {
                elizaLogger.warn(`Approval message ${messageId} not found, considering REJECTED`);
                return ApprovalStatus.REJECTED;
            }

            // Get reactions
            const approveReaction = message.reactions.cache.find(r => r.emoji.name === '👍');
            const rejectReaction = message.reactions.cache.find(r => r.emoji.name === '❌');

            const approveCount = approveReaction?.count || 0;
            const rejectCount = rejectReaction?.count || 0;

            // Check if bot is the only one who reacted
            const effectiveApproveCount = approveCount > 1 ? approveCount - 1 : 0;
            const effectiveRejectCount = rejectCount > 1 ? rejectCount - 1 : 0;

            // Determine status based on reactions
            if (effectiveRejectCount > 0) {
                return ApprovalStatus.REJECTED;
            } else if (effectiveApproveCount > 0) {
                return ApprovalStatus.APPROVED;
            } else {
                return ApprovalStatus.PENDING;
            }
        } catch (error) {
            elizaLogger.error(`Error checking Discord approval status: ${error}`);
            return ApprovalStatus.PENDING;
        }
    }

    async cleanupRequest(requestId: string): Promise<void> {
        try {
            if (this.initialized && this.discordClient) {
                const channel = await this.discordClient.channels.fetch(this.approvalChannelId);
                if (channel && channel.isTextBased()) {
                    try {
                        const message = await channel.messages.fetch(requestId);
                        if (message) {
                            await message.delete();
                        }
                    } catch (err) {
                        // Message may have been deleted already, ignore
                    }
                }
            }
        } catch (error) {
            elizaLogger.warn(`Failed to clean up Discord approval message: ${error}`);
        }
    }

    async stop(): Promise<void> {
        if (this.discordClient) {
            this.discordClient.destroy();
        }
    }
}