import { Action, HandlerCallback, IAgentRuntime, Memory, ModelClass, State, UUID, elizaLogger, generateText, stringToUuid } from "@elizaos/core";
import { ContentPiece, ContentStatus, MicroPlan, Platform } from "../types";
import { ContentCreationService, ContentManagerService } from "../services";

export const GenerateContentAction: Action = {
    name: "GENERATE_CONTENT",
    similes: ["CREATE_CONTENT", "MAKE_POST", "WRITE_CONTENT"],
    description: "Generates content based on a content piece or topic.",

    validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
        const text = message.content.text?.toLowerCase() || "";
        return (
            text.includes("generate content") ||
            text.includes("create content") ||
            text.includes("write content") ||
            text.includes("make post")
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
        let topic = options?.topic as string;
        let platform = options?.platform as Platform;

        // If options not provided, try to extract from message text
        if (!contentId && !topic) {
            // First, let the user know we're processing
            if (callback) {
                await callback({
                    thought: "I need to extract the content details from the message.",
                    text: "I'll help you generate content. Let me process your request...",
                    actions: ["GENERATE_CONTENT"]
                });
            }

            // Extract content ID or topic from message text
            const text = message.content.text || "";

            // Try to extract content ID
            const contentIdMatch = text.match(/content[:\s]+([a-f0-9-]{36})/i);
            if (contentIdMatch) {
                contentId = contentIdMatch[1] as UUID;
            } else {
                // If no content ID, extract topic
                const topicMatch = text.match(/topic[:\s]+([^\n]+)/i);
                if (topicMatch) {
                    topic = topicMatch[1].trim();
                } else {
                    // If no explicit topic, use the whole message as input
                    topic = text;
                }
            }

            // Extract platform
            if (text.toLowerCase().includes("twitter")) {
                platform = Platform.TWITTER;
            } else if (text.toLowerCase().includes("discord")) {
                platform = Platform.DISCORD;
            }
        }

        try {
            // Get the content manager service
            const contentManager = await runtime.getService<ContentManagerService>(ContentManagerService.serviceType);
            const contentCreationService = await contentManager.getMicroService<ContentCreationService>("content-creation");
            if (!contentCreationService) {
                throw new Error("Content creation service not available");
            }

            let contentPiece: ContentPiece;

            // If content ID is provided, get the existing content piece
            if (contentId) {
                const contentMemory = runtime.getMemoryManager("content_memory");
                const contentMemoryItem = await contentMemory.getMemoryById(contentId);

                if (!contentMemoryItem) {
                    throw new Error(`Content with ID ${contentId} not found`);
                }

                // Parse the content piece
                contentPiece = JSON.parse(contentMemoryItem.content.text) as ContentPiece;
            } else if (topic) {
                // If topic is provided, create a new content piece
                // Generate a brief for the content piece
                const briefPrompt = `Generate a brief content description for the following topic:
                
Topic: ${topic}
Platform: ${platform || "social media"}

Write a concise but descriptive brief that outlines:
1. The main point or message
2. Key aspects to cover
3. Tone and style guidance
4. Any specific calls to action

Keep your response under 150 words.`;

                const brief = await generateText({
                    runtime,
                    context: briefPrompt,
                    modelClass: ModelClass.MEDIUM
                });

                // Generate keywords for the content piece
                const keywordsPrompt = `Extract 3-5 relevant keywords or hashtags for the following topic:
                
Topic: ${topic}
Brief: ${brief}

Reply with only the keywords/hashtags as a comma-separated list:`;

                const keywordsResponse = await generateText({
                    runtime,
                    context: keywordsPrompt,
                    modelClass: ModelClass.SMALL
                });

                const keywords = keywordsResponse
                    .split(',')
                    .map(k => k.trim())
                    .filter(k => k.length > 0);

                // Create the content piece
                contentPiece = {
                    id: crypto.randomUUID() as UUID,
                    topic,
                    format: platform === Platform.TWITTER ? "tweet" : "post",
                    platform: platform || Platform.TWITTER,
                    goalAlignment: [],
                    scheduledDate: new Date(),
                    keywords,
                    mediaRequirements: [],
                    brief,
                    status: ContentStatus.DRAFT
                };

                // Store the new content piece
                await runtime.getMemoryManager("content_memory").createMemory({
                    id: contentPiece.id,
                    userId: runtime.agentId,
                    agentId: runtime.agentId,
                    roomId: stringToUuid("content-pieces-room"),
                    content: {
                        text: JSON.stringify(contentPiece)
                    }
                });
            } else {
                throw new Error("Either content ID or topic must be provided");
            }

            // Generate the content
            const result = await contentCreationService.generateContent(contentPiece);

            // Inform the user
            if (callback) {
                await callback({
                    thought: "Successfully generated content for the requested topic or content piece.",
                    text: `I've generated content for "${result.topic}":\n\n${result.generatedContent}\n\nThe content ID is: ${result.id}`,
                    actions: ["GENERATE_CONTENT"]
                });
            }

            return true;
        } catch (error) {
            elizaLogger.error("Error generating content:", error);

            if (callback) {
                await callback({
                    thought: "There was an error generating the content.",
                    text: `I'm sorry, but I encountered an error while generating content: ${error instanceof Error ? error.message : String(error)}`,
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
                content: { text: "Can you generate a Twitter post about AI content creation?" }
            },
            {
                user: "{{name2}}",
                content: {
                    text: "I'll help you generate content. Let me process your request...",
                    thought: "I need to extract the content details from the message.",
                    actions: ["GENERATE_CONTENT"]
                }
            }
        ]
    ]
};