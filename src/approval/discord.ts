import { IAgentRuntime, UUID, elizaLogger, stringToUuid } from "@elizaos/core";
import { Client, GatewayIntentBits, Partials, Events, TextChannel, AttachmentBuilder } from "discord.js";
import { ApprovalProvider } from "./base";
import { ApprovalContent, ApprovalRequest, ApprovalStatus, ContentPiece, MasterPlan, MicroPlan, Platform } from "../types";

export class DiscordApprovalProvider implements ApprovalProvider {
    private discordClient: Client;
    private approvalChannelId: string;
    private runtime: IAgentRuntime;
    private isInitialized = false;
    providerName = "discord";

    async initialize(runtime: IAgentRuntime): Promise<void> {
        if (this.isInitialized) {
            elizaLogger.debug("Discord approval provider already initialized");
            return;
        }

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

            this.isInitialized = true;
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

    async submitForApproval<T extends ApprovalContent>(request: ApprovalRequest<T>): Promise<ApprovalRequest<T>> {
        if (!this.isInitialized || !this.discordClient) {
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
                description: this.formatContentPreview(request.content),
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
                        value: this.getContentLength(request.content).toString() + " characters",
                        inline: true,
                    },
                ],
                footer: {
                    text: "React with 👍 to approve or ❌ to reject. This will expire after 24 hours if no response received.",
                },
                timestamp: new Date().toISOString(),
                color: platformColors[request.platform] || 0x808080,
            };

            // Add content-type specific fields
            this.addContentTypeFields(embed, request.content);

            // Fetch the channel
            const channel = await this.discordClient.channels.fetch(this.approvalChannelId);

            if (!channel || !(channel instanceof TextChannel)) {
                throw new Error("Discord approval channel not found or is not a text channel");
            }

            // Create file attachment with full content
            const fullContentJson = JSON.stringify(request.content, null, 2);
            const attachment = new AttachmentBuilder(
                Buffer.from(fullContentJson, 'utf-8'),
                { name: `content-${request.id}.json` }
            );

            // Send the message with the embed
            const message = await channel.send({ embeds: [embed], files: [attachment] });
            request.platformId = message.id;

            // Add reaction options
            await message.react('👍');
            await message.react('❌');

            // Cache the pending approval
            await this.runtime.cacheManager.set(
                `approval/${request.platform}/${request.id}`,
                {
                    messageId: message.id,
                    provider: this.providerName,
                    content: request.content,
                    platform: request.platform,
                    contentId: request.content.id,
                    timestamp: Date.now()
                }
            );

            elizaLogger.log(`Content sent for Discord approval with message ID: ${message.id}`);

            return request;
        } catch (error) {
            elizaLogger.error(`Error in Discord approval process: ${error}`);
            request.status = ApprovalStatus.FAILED;
            return request;
        }
    }

    async checkApprovalStatus<T extends ApprovalContent>(request: ApprovalRequest<T>): Promise<ApprovalRequest<T>> {
        if (!this.isInitialized || !this.discordClient) {
            throw new Error("Discord approval provider not initialized");
        }

        try {
            // Fetch the channel
            const channel = await this.discordClient.channels.fetch(this.approvalChannelId);
            if (!channel || !channel.isTextBased()) {
                throw new Error("Discord approval channel not found or is not a text channel");
            }

            // Fetch the message
            const message = await channel.messages.fetch(request.platformId);
            if (!message) {
                elizaLogger.warn(`Approval message ${request.platformId} not found, considering REJECTED`);
                request.status = ApprovalStatus.REJECTED;
                return request;
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
                request.status = ApprovalStatus.REJECTED;

                // Get the first user who rejected
                const users = await rejectReaction?.users.fetch();
                const rejecter = users?.find(user => !user.bot);
                if (rejecter) {
                    request.approverId = rejecter.id;
                }
            } else if (effectiveApproveCount > 0) {
                request.status = ApprovalStatus.APPROVED;

                // Get the first user who approved
                const users = await approveReaction?.users.fetch();
                const approver = users?.find(user => !user.bot);
                if (approver) {
                    request.approverId = approver.id;
                }
            } else {
                request.status = ApprovalStatus.PENDING;
            }

            return request;

        } catch (error) {
            elizaLogger.error(`Error checking Discord approval status: ${error}`);
            request.status = ApprovalStatus.FAILED;
            return request;
        }
    }

    async cleanupRequest(requestId: string): Promise<void> {
        try {
            if (this.isInitialized && this.discordClient) {
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

    private formatContentPreview(content: any): string {
        // Handle different content types
        if ('topic' in content && 'format' in content) {
            // This is a ContentPiece
            let preview = `**${content.topic}**\n\n`;

            // Add formatted content if available (truncated if needed)
            if (content.formattedContent) {
                const formattedText = typeof content.formattedContent === 'string'
                    ? content.formattedContent
                    : JSON.stringify(content.formattedContent);

                // Truncate if too long (Discord has 4000 char limit for embed description)
                preview += formattedText.length > 3800
                    ? `${formattedText.substring(0, 3800)}...\n[Content truncated]`
                    : formattedText;
            } else if (content.brief) {
                preview += content.brief;
            } else {
                preview += "No content available";
            }

            // Add scheduled date if available
            if (content.scheduledDate) {
                preview += `\n\nScheduled for: ${content.scheduledDate.toLocaleString()}`;
            }

            return preview;
        } else if ("masterPlanId" in content) {
            // This is a MicroPlan
            let preview = `**Micro Plan**\n\n`;
            preview += `Period: ${content.period.start.toLocaleDateString()} - ${content.period.end.toLocaleDateString()}\n`;
            preview += `Content Pieces: ${content.contentPieces?.length || 0}\n\n`;

            // List first few content pieces
            if (content.contentPieces?.length > 0) {
                preview += "**Content Pieces:**\n";
                const maxPieces = Math.min(5, content.contentPieces.length);
                for (let i = 0; i < maxPieces; i++) {
                    const piece = content.contentPieces[i];
                    preview += `- ${piece.topic} (${piece.platform}, ${piece.scheduledDate?.toLocaleDateString() || "unscheduled"})\n`;
                }

                if (content.contentPieces.length > maxPieces) {
                    preview += `...and ${content.contentPieces.length - maxPieces} more pieces`;
                }
            }

            return preview;
        } else if ("title" in content) {
            // This is a MasterPlan
            let preview = `**Master Plan: ${content.title}**\n\n`;
            preview += `Timeline: ${content.timeline?.startDate?.toLocaleDateString() || "?"} - ${content.timeline?.endDate?.toLocaleDateString() || "?"}\n`;
            preview += `Goals: ${content.goals?.length || 0}\n\n`;

            // List goals
            if (content.goals?.length > 0) {
                preview += "**Goals:**\n";
                const maxGoals = Math.min(3, content.goals.length);
                for (let i = 0; i < maxGoals; i++) {
                    const goal = content.goals[i];
                    preview += `- ${goal.type}: ${goal.description.substring(0, 100)}${goal.description.length > 100 ? "..." : ""}\n`;
                }

                if (content.goals.length > maxGoals) {
                    preview += `...and ${content.goals.length - maxGoals} more goals`;
                }
            }

            return preview;
        }

        // Default fallback
        return JSON.stringify(content, null, 2).substring(0, 1900) + "...";
    }

    private addContentTypeFields(embed: any, content: any): void {
        if ('topic' in content && 'format' in content) {
            // This is a ContentPiece
            const contentPiece = content as ContentPiece;

            embed.fields.push(
                {
                    name: "Scheduled For",
                    value: contentPiece.scheduledDate?.toLocaleDateString() || "Not scheduled",
                    inline: true,
                },
                {
                    name: "Format",
                    value: contentPiece.format || "Not specified",
                    inline: true,
                },
                {
                    name: "Content Status",
                    value: contentPiece.status || "Not specified",
                    inline: true,
                }
            );

            if (contentPiece.keywords?.length > 0) {
                embed.fields.push({
                    name: "Keywords",
                    value: contentPiece.keywords.join(", "),
                    inline: false,
                });
            }

            if (contentPiece.mediaRequirements?.length > 0) {
                embed.fields.push({
                    name: "Media Requirements",
                    value: contentPiece.mediaRequirements.join(", "),
                    inline: false,
                });
            }
        }
        else if ("masterPlanId" in content) {
            // This is a MicroPlan
            const microPlan = content as MicroPlan;

            embed.fields.push(
                {
                    name: "Master Plan Reference",
                    value: microPlan.masterPlanId?.toString() || "Unknown",
                    inline: true,
                },
                {
                    name: "Content Pieces",
                    value: `${microPlan.contentPieces?.length || 0} pieces`,
                    inline: true,
                },
                {
                    name: "Period",
                    value: `${microPlan.period?.start?.toLocaleDateString() || "?"} - ${microPlan.period?.end?.toLocaleDateString() || "?"}`,
                    inline: true,
                }
            );
        }
        else if ("title" in content) {
            // This is a MasterPlan
            const masterPlan = content as MasterPlan;

            embed.fields.push(
                {
                    name: "Title",
                    value: masterPlan.title || "Untitled",
                    inline: true,
                },
                {
                    name: "Goals",
                    value: `${masterPlan.goals?.length || 0} goals`,
                    inline: true,
                },
                {
                    name: "Version",
                    value: masterPlan.version?.toString() || "1",
                    inline: true,
                }
            );

            if (masterPlan.audience?.length > 0) {
                embed.fields.push({
                    name: "Audience",
                    value: masterPlan.audience.map(a => a.segment).join(", "),
                    inline: false,
                });
            }

            if (masterPlan.brandVoice) {
                embed.fields.push({
                    name: "Brand Voice",
                    value: masterPlan.brandVoice.tone || "Not specified",
                    inline: false,
                });
            }

            if (masterPlan.timeline) {
                embed.fields.push({
                    name: "Timeline",
                    value: `${masterPlan.timeline.startDate?.toLocaleDateString() || "?"} - ${masterPlan.timeline.endDate?.toLocaleDateString() || "?"}`,
                    inline: false,
                });
            }
        }
    }

    private getContentLength(content: any): number {
        if (content.formattedContent) {
            return content.formattedContent.toString().length;
        } else if (content.brief) {
            return content.brief.length;
        } else if ('topic' in content) {
            return content.topic.length;
        } else if ('title' in content) {
            return content.title.length;
        }

        // Default
        return JSON.stringify(content).length;
    }

    async stop(): Promise<void> {
        if (this.discordClient) {
            this.discordClient.destroy();
        }
    }
}