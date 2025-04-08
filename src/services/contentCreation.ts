// src/services/content-service.ts
import { IAgentRuntime, ModelClass, generateText, elizaLogger, ServiceType } from "@elizaos/core";
import { ApprovalStatus, ContentPiece, ContentStatus, MasterPlan, MicroPlan } from "../types";
import { ContentAgentMemoryManager } from "../managers/content-memory-manager";
import { TimestampStyles } from "discord.js";

export class ContentService {
    constructor(private runtime: IAgentRuntime, private memoryManager: ContentAgentMemoryManager) { }

    async generateContent(contentPiece: ContentPiece): Promise<ContentPiece> {
        // Fetch additional context
        const masterPlans = await this.memoryManager.getMasterPlans();
        const activeMasterPlan = masterPlans.find(plan => plan.approvalStatus === ApprovalStatus.APPROVED);

        // Generate content using LLM
        contentPiece.generatedContent = await this.generateContentWithLLM(contentPiece, activeMasterPlan);

        // Update content piece status
        contentPiece.status = ContentStatus.READY;

        // Store updated content piece
        await this.memoryManager.createContentPiece(contentPiece);

        return contentPiece;
    }

    private async generateContentWithLLM(
        contentPiece: ContentPiece,
        masterPlan: MasterPlan | undefined
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
`;

        // Generate content using LLM
        const generatedContent = await generateText({ runtime: this.runtime, context: prompt, modelClass: ModelClass.LARGE });

        return generatedContent;
    }
}