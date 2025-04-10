// src/services/planning-service.ts
import { UUID, IAgentRuntime, ModelClass, generateText, elizaLogger } from "@elizaos/core";
import {
    MasterPlan,
    MicroPlan,
    ApprovalStatus,
    Timeframe,
    ContentPiece,
    ContentStatus,
    Goal,
    ContentMixItem,
    AudienceSegment,
    BrandVoice,
    Timeline,
    Milestone,
    Platform,
    ApprovalRequest
} from "../types";
import { ContentAgentMemoryManager } from "../managers/contentMemory";
import { AdapterProvider } from "./adapterService";
import * as fs from 'fs/promises';
import * as path from 'path';
import { ContentManagerService } from "./contentManager";
import { ContentApprovalService } from "./contentApproval";
import { ContentPlanningConfig } from "../environment";
import { fileURLToPath } from 'url';
import { ContentDeliveryService } from "./contentDelivery";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class PlanningService {
    private adapterProvider: AdapterProvider;
    private platformFormats: Map<Platform, Map<string, string[]>> = new Map();
    private platformFormatting = {};
    private plansDirectory: string;
    private config: ContentPlanningConfig;

    constructor(private runtime: IAgentRuntime, private memoryManager: ContentAgentMemoryManager) {
        this.plansDirectory = path.join(__dirname, 'plans');
    }

    async initialize(adapterProvider: AdapterProvider, config: ContentPlanningConfig): Promise<void> {
        elizaLogger.debug("[PlanningService] Initializing PlanningService");
        this.adapterProvider = adapterProvider;
        this.config = config;

        elizaLogger.log("[PlanningService] Micro plan frequency set to:", this.config.MICRO_PLAN_TIMEFRAME);

        const adapters = await this.adapterProvider.getAllAdapters();
        this.platformFormats = new Map();

        for (const adapter of adapters) {
            const formatMap = new Map<string, string[]>();
            formatMap.set("possibleFormats", adapter.contentFormats);
            this.platformFormats.set(adapter.platform, formatMap);
        }

        this.platformFormats.forEach((formatMap, platform) => {
            this.platformFormatting[platform] = {};
            formatMap.forEach((formats, key) => {
                this.platformFormatting[platform][key] = formats;
            });
        });

        elizaLogger.debug("[PlanningService] Available platforms and formats:", this.platformFormats);

        await this.loadExistingPlans();

        this.startPlanCreationLoop();
    }

    private async loadExistingPlans(): Promise<void> {
        elizaLogger.debug(`[PlanningService] Checking for existing plans in: ${this.plansDirectory}`);

        try {
            // Check if directory exists
            await fs.access(this.plansDirectory);

            // Read all files in the directory
            const files = await fs.readdir(this.plansDirectory);

            // Process each JSON file
            const jsonFiles = files.filter(file => file.endsWith('.json'));
            elizaLogger.debug(`[PlanningService] Found ${jsonFiles.length} JSON plan files`);

            for (const file of jsonFiles) {
                try {
                    const filePath = path.join(this.plansDirectory, file);
                    const fileContent = await fs.readFile(filePath, 'utf8');
                    const planData = JSON.parse(fileContent);

                    // Process the plan data
                    if (planData.title?.toLowerCase().includes("master") || file.toLowerCase().includes("master")) {
                        await this.processExistingMaster(planData);
                    } else if (file.toLowerCase().includes("micro")) {
                        await this.processExistingMicroPlan(planData);
                    } else {
                        elizaLogger.debug(`[PlanningService] Skipping plan: ${planData.title}`);
                    }

                } catch (error) {
                    elizaLogger.error(`[PlanningService] Error processing plan file ${file}:`, error);
                }
            }
        } catch (error) {
            elizaLogger.debug(`[PlanningService] No plans directory found or error accessing it`);
        }
    }

    private async processExistingMaster(planData: any): Promise<void> {
        try {
            // Skip if master not in title
            if (!planData.title?.toLowerCase().includes("master")) {
                elizaLogger.debug(`[PlanningService] Skipping non-master plan: ${planData.title}`);
                return;
            }

            // Skip if plan with this ID already exists
            if (planData.id) {
                const existingPlan = await this.memoryManager.getMasterPlanById(planData.id);
                if (existingPlan) {
                    elizaLogger.debug(`[PlanningService] Plan with ID ${planData.id} already exists, skipping import`);
                    return;
                }
            }

            // Basic validation
            if (!planData.title) {
                throw new Error('Invalid plan data: missing title');
            }

            const now = new Date();

            // Process dates
            const startDate = planData.timeline?.startDate
                ? new Date(planData.timeline.startDate)
                : now;

            const endDate = planData.timeline?.endDate
                ? new Date(planData.timeline.endDate)
                : new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);

            // Process milestones
            const milestones: Milestone[] = Array.isArray(planData.timeline?.milestones)
                ? planData.timeline.milestones.map(m => ({
                    date: new Date(m.date || now),
                    description: m.description || "Milestone"
                }))
                : [];

            // Create the master plan
            const masterPlan: MasterPlan = {
                id: planData.id || crypto.randomUUID() as UUID,
                title: planData.title,
                goals: this.processGoals(planData.goals || []),
                contentMix: this.processContentMix(planData.contentMix || []),
                audience: this.processAudience(planData.audience || []),
                brandVoice: this.processBrandVoice(planData.brandVoice || {}),
                timeline: {
                    startDate,
                    endDate,
                    milestones
                },
                version: planData.version || 1,
                approvalStatus: planData.approvalStatus || ApprovalStatus.DRAFT,
                created: planData.created ? new Date(planData.created) : now,
                modified: now
            };

            // Store the plan in memory manager
            await this.memoryManager.createMasterPlan(masterPlan);
            elizaLogger.debug(`[PlanningService] Imported plan: ${masterPlan.title} with ID: ${masterPlan.id}`);
        } catch (error) {
            elizaLogger.error(`[PlanningService] Failed to process plan:`, error);
        }
    }

    private async processExistingMicroPlan(planData: any): Promise<void> {
        try {
            // Skip if plan with this ID already exists
            if (planData.id) {
                const existingPlan = await this.memoryManager.getMicroPlanById(planData.id);
                if (existingPlan) {
                    elizaLogger.debug(`[PlanningService] Micro plan with ID ${planData.id} already exists, skipping import`);
                    return;
                }
            }

            // Basic validation
            if (!planData.masterPlanId) {
                throw new Error('Invalid micro plan data: missing master plan ID');
            }

            const now = new Date();

            // Create the micro plan
            const microPlan: MicroPlan = {
                id: planData.id || crypto.randomUUID() as UUID,
                masterPlanId: planData.masterPlanId,
                period: {
                    start: new Date(planData.period?.start || now),
                    end: new Date(planData.period?.end || now)
                },
                contentPieces: Array.isArray(planData.contentPieces)
                    ? planData.contentPieces.map(piece => ({
                        ...piece,
                        id: piece.id || crypto.randomUUID() as UUID,
                        scheduledDate: new Date(piece.scheduledDate || now),
                        status: piece.status || ContentStatus.PLANNED
                    }))
                    : [],
                approvalStatus: planData.approvalStatus || ApprovalStatus.DRAFT,
                version: planData.version || 1,
                created: now,
                modified: now
            };

            // Store the micro plan in memory manager
            await this.memoryManager.createMicroPlan(microPlan);
            elizaLogger.debug(`[PlanningService] Imported micro plan with ID: ${microPlan.id}`);
        } catch (error) {
            elizaLogger.error(`[PlanningService] Failed to process existing micro plans:`, error);
        }
    }

    async createMasterPlan(baseInfo: string): Promise<MasterPlan> {
        // Generate master plan using LLM if only partial info provided
        const masterPlan = await this.generateMasterPlan(baseInfo);

        // Store master plan in database
        await this.memoryManager.createMasterPlan(masterPlan);
        await this.savePlanToFile(masterPlan);

        return masterPlan;
    }

    async createMicroPlan(
        masterPlanId: UUID,
        timeframe: Timeframe = Timeframe.WEEKLY,
        startDate: Date = new Date()
    ): Promise<MicroPlan> {
        // Fetch the master plan
        const masterPlan = await this.memoryManager.getMasterPlanById(masterPlanId);
        if (!masterPlan) {
            throw new Error(`Master plan with ID ${masterPlanId} not found`);
        }

        // Generate micro plan
        const microPlan = await this.generateMicroPlan(masterPlan, timeframe, startDate);

        // Store micro plan in database
        await this.memoryManager.createMicroPlan(microPlan);
        await this.savePlanToFile(microPlan);

        return microPlan;
    }

    async getActiveMasterPlans(): Promise<MasterPlan[]> {
        const plans = await this.memoryManager.getMasterPlans();
        return plans.filter(plan => plan.approvalStatus === ApprovalStatus.APPROVED);
    }

    private async generateMasterPlan(baseInfo: string): Promise<MasterPlan> {
        // Create a prompt for the LLM
        const prompt = `Create a comprehensive content master plan based on the following information:
${baseInfo}

The plan should include:
1. Clear goals with KPIs and completion criteria
2. Content mix with category ratios and platform formats
3. Audience segments with characteristics and pain points
4. Brand voice guidelines
5. Timeline with milestones

Available platforms and associated formats are: ${JSON.stringify(this.platformFormatting)}.

Format your response as a JSON object with the following structure:
{
  "title": "string",
  "id": "string",
  "goals": [
    {
      "type": "string",
      "description": "string",
      "priority": number,
      "kpis": [{ "metric": "string", "target": number }],
      "completionCriteria": "string"
    }
  ],
  "contentMix": [
    {
      "category": "string",
      "ratio": number,
      "platforms": [{ "name": "string", "format": "string" }]
    }
  ],
  "audience": [
    {
      "segment": "string",
      "characteristics": ["string"],
      "painPoints": ["string"]
    }
  ],
  "brandVoice": {
    "tone": "string",
    "vocabulary": ["string"],
    "prohibitedTerms": ["string"]
  },
  "timeline": {
    "startDate": "ISO date string",
    "endDate": "ISO date string",
    "milestones": [{ "date": "ISO date string", "description": "string" }]
  }
}
  
  Respond with the JSON object only.  No explanations or other text.`;

        // Generate the plan using LLM
        const llmResponse = await generateText({
            runtime: this.runtime,
            context: prompt,
            modelClass: ModelClass.LARGE
        });

        // Create a valid MasterPlan structure
        try {
            const parsedPlan = JSON.parse(llmResponse);
            const now = new Date();

            // Process dates
            const startDate = parsedPlan.timeline?.startDate
                ? new Date(parsedPlan.timeline.startDate)
                : now;

            const endDate = parsedPlan.timeline?.endDate
                ? new Date(parsedPlan.timeline.endDate)
                : new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000); // 90 days later

            // Process milestones
            const milestones: Milestone[] = Array.isArray(parsedPlan.timeline?.milestones)
                ? parsedPlan.timeline.milestones.map(m => ({
                    date: new Date(m.date || now),
                    description: m.description || "Milestone"
                }))
                : [];

            // Create the master plan
            const masterPlan: MasterPlan = {
                id: crypto.randomUUID() as UUID,
                title: parsedPlan.title || "Content Master Plan",
                goals: this.processGoals(parsedPlan.goals || []),
                contentMix: this.processContentMix(parsedPlan.contentMix || []),
                audience: this.processAudience(parsedPlan.audience || []),
                brandVoice: this.processBrandVoice(parsedPlan.brandVoice || {}),
                timeline: {
                    startDate,
                    endDate,
                    milestones
                },
                version: 1,
                approvalStatus: ApprovalStatus.DRAFT,
                created: now,
                modified: now
            };

            return masterPlan;
        } catch (error) {
            console.error("Failed to parse master plan:", error);

            // Create a minimal master plan with defaults
            const now = new Date();
            return {
                id: crypto.randomUUID() as UUID,
                title: "Content Master Plan",
                goals: [],
                contentMix: [],
                audience: [],
                brandVoice: { tone: "neutral", vocabulary: [], prohibitedTerms: [] },
                timeline: {
                    startDate: now,
                    endDate: new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000), // 90 days later
                    milestones: []
                },
                version: 1,
                approvalStatus: ApprovalStatus.DRAFT,
                created: now,
                modified: now
            };
        }
    }

    // src/services/planning-service.ts (continued)
    // Helper methods for processing master plan components
    private processGoals(rawGoals: any[]): Goal[] {
        return rawGoals.map((goal, index) => ({
            id: crypto.randomUUID() as UUID,
            type: goal.type || "generic",
            description: goal.description || `Goal ${index + 1}`,
            priority: typeof goal.priority === 'number' ? goal.priority : 5,
            kpis: Array.isArray(goal.kpis)
                ? goal.kpis.map(kpi => ({
                    metric: kpi.metric || "engagement",
                    target: typeof kpi.target === 'number' ? kpi.target : 100
                }))
                : [],
            completionCriteria: goal.completionCriteria || "Completion criteria not specified"
        }));
    }

    private processContentMix(rawContentMix: any[]): ContentMixItem[] {
        return rawContentMix.map(item => ({
            category: item.category || "general",
            ratio: typeof item.ratio === 'number' ? item.ratio : 25,
            platforms: Array.isArray(item.platforms)
                ? item.platforms.map(p => ({
                    name: p.name || "twitter",
                    format: p.format || "post"
                }))
                : [{ name: "twitter", format: "post" }]
        }));
    }

    private processAudience(rawAudience: any[]): AudienceSegment[] {
        return rawAudience.map(segment => ({
            segment: segment.segment || "general audience",
            characteristics: Array.isArray(segment.characteristics)
                ? segment.characteristics
                : [],
            painPoints: Array.isArray(segment.painPoints)
                ? segment.painPoints
                : []
        }));
    }

    private processBrandVoice(rawBrandVoice: any): BrandVoice {
        return {
            tone: rawBrandVoice.tone || "professional",
            vocabulary: Array.isArray(rawBrandVoice.vocabulary)
                ? rawBrandVoice.vocabulary
                : [],
            prohibitedTerms: Array.isArray(rawBrandVoice.prohibitedTerms)
                ? rawBrandVoice.prohibitedTerms
                : []
        };
    }

    private processContentPiece(rawContentPiece: any): ContentPiece {
        return {
            id: rawContentPiece.id || crypto.randomUUID() as UUID,
            topic: rawContentPiece.topic || "Untitled content",
            format: rawContentPiece.format || "post",
            platform: rawContentPiece.platform || "twitter",
            goalAlignment: Array.isArray(rawContentPiece.goalAlignment)
                ? rawContentPiece.goalAlignment
                : [],
            scheduledDate: new Date(rawContentPiece.scheduledDate || new Date()),
            keywords: Array.isArray(rawContentPiece.keywords)
                ? rawContentPiece.keywords
                : [],
            mediaRequirements: Array.isArray(rawContentPiece.mediaRequirements)
                ? rawContentPiece.mediaRequirements
                : [],
            brief: rawContentPiece.brief || "No brief provided",
            status: ContentStatus.DRAFT
        };
    }

    private async generateMicroPlan(
        masterPlan: MasterPlan,
        timeframe: Timeframe,
        startDate: Date
    ): Promise<MicroPlan> {
        // Calculate end date based on timeframe
        const endDate = this.calculateEndDate(startDate, timeframe);

        // Create prompt for LLM to generate content pieces
        const prompt = `Generate a micro content plan for the period from ${startDate.toISOString()} to ${endDate.toISOString()}.
This plan should align with the following master plan:
${JSON.stringify(masterPlan, null, 2)}

Please create a list of content pieces that would be appropriate for this timeframe. For each piece, include:
1. Topic
2. Format
3. Platform
4. Relevant goal IDs from the master plan
5. Scheduled date (within the timeframe)
6. Keywords
7. Media requirements
8. Brief description of content

Available platforms and associated formats are: ${JSON.stringify(this.platformFormatting)}.

Format your response as a JSON array of content pieces with this structure:
[
  {
    "topic": "string",
    "format": "string",
    "platform": "string",
    "goalAlignment": ["goalId1", "goalId2"],
    "scheduledDate": "ISO date string",
    "keywords": ["string"],
    "mediaRequirements": ["string"],
    "brief": "string"
  }
]
  
Respond with the JSON array only. No explanations or other text.`;

        // Generate content pieces using LLM
        const llmResponse = await generateText({
            runtime: this.runtime,
            context: prompt,
            modelClass: ModelClass.LARGE
        });

        // Parse LLM response and create a valid MicroPlan
        try {
            const contentPieces = JSON.parse(llmResponse);

            // Process content pieces
            const processedContentPieces: ContentPiece[] = Array.isArray(contentPieces)
                ? contentPieces.map(piece => (this.processContentPiece(piece)))
                : [];

            // Create the micro plan
            const now = new Date();
            const microPlan: MicroPlan = {
                id: crypto.randomUUID() as UUID,
                masterPlanId: masterPlan.id,
                period: {
                    start: startDate,
                    end: endDate
                },
                contentPieces: processedContentPieces,
                approvalStatus: ApprovalStatus.DRAFT,
                version: 1,
                created: now,
                modified: now
            };

            return microPlan;
        } catch (error) {
            console.error("Failed to parse micro plan:", error);

            // Create a minimal micro plan with empty content
            const now = new Date();
            return {
                id: crypto.randomUUID() as UUID,
                masterPlanId: masterPlan.id,
                period: {
                    start: startDate,
                    end: endDate
                },
                contentPieces: [],
                approvalStatus: ApprovalStatus.DRAFT,
                version: 1,
                created: now,
                modified: now
            };
        }
    }

    private async createNextMicroPlan(
        masterPlanId: UUID,
    ): Promise<MicroPlan> {
        // Get all micro plans
        const microplans = await this.memoryManager.getMicroPlansForMasterPlan(masterPlanId);

        if (!microplans) {
            elizaLogger.log("[PlanningService] No micro plans found for this master plan. Creating first micro plan.");
            return this.createMicroPlan(masterPlanId, this.config.MICRO_PLAN_TIMEFRAME);
        }

        let startDate = new Date();
        let lastMicroPlan: MicroPlan | null = null;

        // Get the last micro plan
        for (const microplan of microplans) {
            if (microplan.period.end > startDate) {
                lastMicroPlan = microplan;
                startDate = new Date(microplan.period.end);
            }
        }

        return this.createMicroPlan(masterPlanId, this.config.MICRO_PLAN_TIMEFRAME, startDate);
    }

    async submitPlanForApproval<T extends MasterPlan | MicroPlan>(plan: T): Promise<ApprovalRequest<T>> {
        // Get approval microservice
        const _c = await this.runtime.getService<ContentManagerService>(ContentManagerService.serviceType);
        const approvalService = await _c.getMicroService<ContentApprovalService>("content-approval");

        const approvalRequest = await approvalService.sendForApproval<T>(plan, (request) => this.handleStatusUpdate(request));
        return approvalRequest;
    }

    async handleStatusUpdate<T extends MasterPlan | MicroPlan>(approvalRequest: ApprovalRequest<T>): Promise<void> {
        const memory = await this.memoryManager.getMemoryById(approvalRequest.content.id);

        if (!memory) {
            elizaLogger.error(`[PlanningService] Plan memory with ID ${approvalRequest.content.id} not found`);
            return;
        }

        const plan = JSON.parse(memory.content.text || "{}");

        // Update status
        plan.approvalStatus = approvalRequest.status;
        plan.modified = new Date();

        const newMemory = {
            ...memory,
            content: {
                ...memory.content,
                text: JSON.stringify(plan)
            }
        };

        // Handle approved plan
        if (approvalRequest.status === ApprovalStatus.APPROVED) {
            await this.handleApprovedPlan(plan);
        } else if (approvalRequest.status === ApprovalStatus.REJECTED) {
            // Handle rejected plan
            elizaLogger.log(`[PlanningService] Plan ${plan.id} rejected`);
        }

        // Store updated plan
        await this.memoryManager.updateMemory(newMemory);
        await this.savePlanToFile(plan);
    }

    private async handleApprovedPlan(plan: MasterPlan | MicroPlan): Promise<void> {
        // If microplan, schedule content pieces in delivery service
        if (plan.approvalStatus === ApprovalStatus.APPROVED && "contentPieces" in plan) {
            const contentManager = await this.runtime.getService<ContentManagerService>(ContentManagerService.serviceType);
            const deliveryService = await contentManager.getMicroService<ContentDeliveryService>("content-delivery");

            for (const piece of plan.contentPieces) {
                // Ensure schedule date is in the future
                if (piece.scheduledDate < new Date()) {
                    piece.scheduledDate = new Date();
                }

                await deliveryService.submitContent(piece, { scheduledTime: piece.scheduledDate });
            }
        }
    }

    private startPlanCreationLoop(): void {
        // Start plan creation loop
        elizaLogger.log("[PlanningService] Starting plan creation loop");

        setInterval(async () => {
            try {
                const activeMasterPlans = await this.getActiveMasterPlans();
                if (activeMasterPlans.length === 0) {
                    elizaLogger.log("[PlanningService] No active master plans found");
                    return;
                }
                for (const masterPlan of activeMasterPlans) {
                    const plan = await this.createNextMicroPlan(masterPlan.id);
                    elizaLogger.log(`[PlanningService] Created micro plan: ${plan.id}`);

                    // Submit the micro plan for approval
                    const approvalRequest = await this.submitPlanForApproval(plan);
                    elizaLogger.log(`[PlanningService] Submitted micro plan for approval: ${approvalRequest.id}`);
                }
            } catch (error) {
                elizaLogger.error("[PlanningService] Error creating micro plans:", error);
            }
        }, timeframeToMilliseconds[this.config.MICRO_PLAN_TIMEFRAME]);
    }

    private calculateEndDate(startDate: Date, timeframe: Timeframe): Date {
        const endDate = new Date(startDate);

        switch (timeframe) {
            case Timeframe.DAILY:
                endDate.setDate(endDate.getDate() + 1);
                break;
            case Timeframe.WEEKLY:
                endDate.setDate(endDate.getDate() + 7);
                break;
            case Timeframe.MONTHLY:
                endDate.setMonth(endDate.getMonth() + 1);
                break;
            case Timeframe.QUARTERLY:
                endDate.setMonth(endDate.getMonth() + 3);
                break;
            default:
                endDate.setDate(endDate.getDate() + 7); // Default to weekly
        }

        return endDate;
    }

    private async savePlanToFile(plan: MasterPlan | MicroPlan): Promise<void> {
        const fileName = `${plan.id}.json`;
        const filePath = path.join(this.plansDirectory, fileName);

        try {
            await fs.writeFile(filePath, JSON.stringify(plan, null, 2));
            elizaLogger.debug(`[PlanningService] Saved plan to file: ${filePath}`);
        } catch (error) {
            elizaLogger.error(`[PlanningService] Error saving plan to file:`, error);
        }
    }
}

const timeframeToMilliseconds = {
    [Timeframe.DAILY]: 24 * 60 * 60 * 1000,
    [Timeframe.WEEKLY]: 7 * 24 * 60 * 60 * 1000,
    [Timeframe.MONTHLY]: 30 * 24 * 60 * 60 * 1000,
    [Timeframe.QUARTERLY]: 90 * 24 * 60 * 60 * 1000
};