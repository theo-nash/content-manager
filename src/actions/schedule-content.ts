import { Action, HandlerCallback, IAgentRuntime, Memory, State, UUID, stringToUuid, elizaLogger } from "@elizaos/core";
import { ContentPiece, ContentStatus, Platform } from "../types";
import { ContentDeliveryService, ContentManagerService } from "../services";

export const ScheduleContentAction: Action = {
    name: "SCHEDULE_CONTENT",
    similes: ["PLAN_CONTENT_POSTING", "SET_CONTENT_TIME", "PUBLISH_LATER"],
    description: "Schedules content for publication at a specific date and time.",

    validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
        const text = message.content.text?.toLowerCase() || "";
        return (
            text.includes("schedule content") ||
            text.includes("publish later") ||
            text.includes("post at") ||
            text.includes("schedule post")
        );
    },

    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state?: State,
        options?: any,
        callback?: HandlerCallback
    ): Promise<boolean> => {
        // Parse options if provided directly
        let contentId = options?.contentId as UUID;
        let scheduledTime = options?.scheduledTime as Date;
        let platform = options?.platform as Platform;

        // If options not provided, try to extract from message text
        if (!contentId || !scheduledTime) {
            // First, let the user know we're processing
            if (callback) {
                await callback({
                    thought: "I need to parse the content ID, platform, and scheduled time from the message.",
                    text: "I'll help you schedule content for publication. Let me process your request...",
                    actions: ["SCHEDULE_CONTENT"]
                });
            }

            // Extract content ID, platform, and scheduled time from message text
            const text = message.content.text?.toLowerCase() || "";

            // This is a simplified extraction - in a real implementation you would use more sophisticated NLP
            const contentIdMatch = text.match(/content[:\s]+([a-f0-9-]{36})/i);
            if (contentIdMatch) {
                contentId = contentIdMatch[1] as UUID;
            }

            // Extract platform
            if (text.includes("twitter")) {
                platform = Platform.TWITTER;
            } else if (text.includes("discord")) {
                platform = Platform.DISCORD;
            }

            // Extract date/time - this is a simplified approach
            // In a real implementation, use a date parsing library
            const dateTimeMatch = text.match(/(?:on|at)\s+([\d\/]+)\s+([\d:]+\s*(?:am|pm)?)/i);
            if (dateTimeMatch) {
                const dateStr = dateTimeMatch[1];
                const timeStr = dateTimeMatch[2];
                scheduledTime = new Date(`${dateStr} ${timeStr}`);
            }
        }

        // Validate required parameters
        if (!contentId || !scheduledTime) {
            if (callback) {
                await callback({
                    thought: "I couldn't extract all the required information from the message.",
                    text: "I need more information to schedule the content. Please provide the content ID and when you want to publish it.",
                    actions: ["REPLY"]
                });
            }
            return false;
        }

        try {
            // Get the content delivery service
            const contentManager = await runtime.getService<ContentManagerService>(ContentManagerService.serviceType);
            const contentDeliveryService = await contentManager.getMicroService<ContentDeliveryService>("content-delivery");

            if (!contentDeliveryService) {
                throw new Error("Content delivery service not available");
            }

            // Get the content piece from the memory manager
            const contentMemory = runtime.getMemoryManager("content_memory");
            const contentMemoryItem = await contentMemory.getMemoryById(contentId);

            if (!contentMemoryItem) {
                throw new Error(`Content with ID ${contentId} not found`);
            }

            // Parse the content piece
            const contentPiece = JSON.parse(contentMemoryItem.content.text) as ContentPiece;

            // Schedule the content
            const result = await contentDeliveryService.submitContent(contentPiece, {
                scheduledTime
            });

            // Inform the user
            if (callback) {
                if (result.success) {
                    await callback({
                        thought: "Successfully scheduled the content for publication.",
                        text: `I've scheduled the content for publication on ${platform} at ${scheduledTime.toLocaleString()}.`,
                        actions: ["SCHEDULE_CONTENT"]
                    });
                } else {
                    await callback({
                        thought: "There was an error scheduling the content.",
                        text: `I encountered an error while scheduling the content: ${result.error}`,
                        actions: ["REPLY"]
                    });
                }
            }

            return result.success;
        } catch (error) {
            elizaLogger.error("Error scheduling content:", error);

            if (callback) {
                await callback({
                    thought: "There was an error scheduling the content for publication.",
                    text: `I'm sorry, but I encountered an error while scheduling your content: ${error instanceof Error ? error.message : String(error)}`,
                    actions: ["REPLY"]
                });
            }

            return false;
        }
    },

    examples: [
        [
            {
                user: "{{name1}}",
                content: { text: "Can you schedule the content with ID abc123 to be published on Twitter tomorrow at 9am?" }
            },
            {
                user: "{{name2}}",
                content: {
                    text: "I'll help you schedule content for publication. Let me process your request...",
                    thought: "I need to parse the content ID, platform, and scheduled time from the message.",
                    actions: ["SCHEDULE_CONTENT"]
                }
            }
        ]
    ]
};