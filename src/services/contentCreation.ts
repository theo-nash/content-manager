// src/services/content-service.ts
import { IAgentRuntime, ModelClass, generateText, elizaLogger, ServiceType } from "@elizaos/core";
import { AdapterRegistration, ApprovalStatus, ContentPiece, ContentStatus, MasterPlan, MicroPlan, Platform, PlatformAdapter } from "../types";
import { ContentAgentMemoryManager } from "../managers/contentMemory";
import { TimestampStyles } from "discord.js";

/**
 * Service responsible for generating content based on content pieces
 * from micro plans. It uses LLMs to create platform-specific content
 * following brand guidelines and strategic objectives.
 */
export class ContentCreationService {
    private adapterRegistry: Map<Platform, AdapterRegistration> = new Map();

    constructor(private runtime: IAgentRuntime, private memoryManager: ContentAgentMemoryManager) { }

    async initialize(adapters?: PlatformAdapter[]): Promise<void> {
        elizaLogger.debug("[ContentCreationService] Initializing ContentCreationService");

        for (const adapter of adapters || []) {
            this.adapterRegistry.set(adapter.platform, {
                adapter,
                platform: adapter.platform,
                enabled: true
            });
        }
    }

    async generateContent(contentPiece: ContentPiece): Promise<ContentPiece> {
        elizaLogger.log(`[ContentCreationService] Generating content for piece: ${contentPiece.id}`);

        // Fetch additional context
        const masterPlans = await this.memoryManager.getMasterPlans();
        const activeMasterPlan = masterPlans.find(plan => plan.approvalStatus === ApprovalStatus.APPROVED);

        // Get any platform-specific formatting instructions
        const registration = this.adapterRegistry.get(contentPiece.platform);
        const formattingInstructions = registration ? await registration.adapter.getFormattingInstructions() : '';

        // Generate content using LLM
        contentPiece.generatedContent = await this.generateContentWithLLM(contentPiece, activeMasterPlan, formattingInstructions);

        // Update content piece status
        contentPiece.status = ContentStatus.READY;

        return contentPiece;
    }

    private async generateContentWithLLM(
        contentPiece: ContentPiece,
        masterPlan: MasterPlan | undefined,
        formattingInstructions?: string
    ): Promise<string> {
        // Create prompt for content generation
        const prompt = `Generate content for the following piece:

Topic: ${contentPiece.topic}
Platform: ${contentPiece.platform}
Format: ${contentPiece.format}
Brief: ${contentPiece.brief}
Keywords: ${contentPiece.keywords.join(', ')}

${masterPlan ? `Brand voice: ${JSON.stringify(masterPlan.brandVoice, null, 2)}` : ''}

Create content that is engaging, well-structured, and appropriate for the specified platform.
Include any hashtags, mentions, or formatting that would be appropriate.

${formattingInstructions ? `Specific formatting instructions for ${contentPiece.platform}: ${formattingInstructions}` : ''}

Make sure to adhere to the brand guidelines and strategic objectives outlined in the master plan.
`;

        // Generate content using LLM
        const generatedContent = await generateText({ runtime: this.runtime, context: prompt, modelClass: ModelClass.LARGE });

        return generatedContent;
    }
}