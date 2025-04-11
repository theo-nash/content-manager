// src/services/content-service.ts
import { IAgentRuntime, ModelClass, generateText, elizaLogger, ServiceType } from "@elizaos/core";
import { AdapterRegistration, ApprovalStatus, ContentPiece, ContentStatus, MasterPlan, MicroPlan, Platform, PlatformAdapter } from "../types";
import { ContentAgentMemoryManager } from "../managers/contentMemory";
import { TimestampStyles } from "discord.js";
import { AdapterProvider } from "./adapterService";
import { ContentManagerService } from "./contentManager";

/**
 * Service responsible for generating content based on content pieces
 * from micro plans. It uses LLMs to create platform-specific content
 * following brand guidelines and strategic objectives.
 */
export class ContentCreationService {
    private adapterProvider: AdapterProvider | null = null;
    private isInitialized: boolean = false;
    private contentManager: ContentManagerService | null = null;
    private memoryManager: ContentAgentMemoryManager | null = null;

    constructor(private runtime: IAgentRuntime) { }

    async initialize(): Promise<void> {
        if (this.isInitialized) {
            elizaLogger.debug("[ContentCreationService] ContentCreationService is already initialized");
            return;
        }

        elizaLogger.debug("[ContentCreationService] Initializing ContentCreationService");

        // Initialize required services
        await this.initializeServices();

        this.isInitialized = true;
    }

    async initializeServices(): Promise<void> {
        try {
            // Get content manager service
            this.contentManager = await this.runtime.getService<ContentManagerService>(ContentManagerService.serviceType);

            if (!this.contentManager) {
                throw new Error("[ContentCreationService] ContentManagerService not available");
            }

            this.adapterProvider = await this.contentManager.getMicroService<AdapterProvider>("adapter-provider");

            if (!this.adapterProvider) {
                elizaLogger.warn("[ContentCreationService] AdapterProvider not available, content features will be limited");
                return;
            }

            this.memoryManager = await this.contentManager.getMicroService<ContentAgentMemoryManager>("content-memory");

            if (!this.memoryManager) {
                elizaLogger.warn("[ContentCreationService] MemoryManager not available, content features may be limited");
            }

        } catch (error) {
            elizaLogger.error("[ContentCreationService] Error initializing services:", error);
            throw new Error(`Service initialization failed: ${error.message}`);
        }
    }

    async generateContent(contentPiece: ContentPiece): Promise<ContentPiece> {
        elizaLogger.log(`[ContentCreationService] Generating content for piece: ${contentPiece.id}`);

        // Fetch additional context
        const masterPlans = await this.memoryManager.getMasterPlans();
        const activeMasterPlan = masterPlans.find(plan => plan.approvalStatus === ApprovalStatus.APPROVED);

        // Get any platform-specific formatting instructions
        const adapter = this.adapterProvider.getAdapter(contentPiece.platform);
        const formattingInstructions = adapter ? await adapter.getFormattingInstructions() : '';

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