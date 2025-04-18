// src/services/planning-service.ts
import { UUID, IAgentRuntime, ModelClass, generateText, elizaLogger, Memory } from "@elizaos/core";
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

const PLAN_LOCK_TIMEOUT = 1000 * 60 * 5; // 5 minutes

interface lockKey {
    locked: boolean;
    timestamp: Date;
}

export class PlanningService {
    private adapterProvider: AdapterProvider | null = null;
    private platformFormats: Map<Platform, Map<string, string[]>> = new Map();
    private platformFormatting = {};
    private plansDirectory: string;
    private planCreationTimers: Map<UUID, NodeJS.Timeout> = new Map();
    private isInitialized: boolean = false;
    private contentManager: ContentManagerService | null = null;
    private approvalService: ContentApprovalService | null = null;
    private deliveryService: ContentDeliveryService | null = null;
    private memoryManager: ContentAgentMemoryManager | null = null;
    private lockRegistry = new Set<string>();


    constructor(private runtime: IAgentRuntime, private config: ContentPlanningConfig) {
        this.plansDirectory = path.join(__dirname, 'plans');
    }

    async initialize(): Promise<void> {
        try {
            if (this.isInitialized) {
                elizaLogger.debug("[PlanningService] Already initialized");
                return;
            }

            elizaLogger.debug("[PlanningService] Initializing PlanningService");

            elizaLogger.log("[PlanningService] Micro plan frequency set to:", this.config.MICRO_PLAN_TIMEFRAME);

            // Initialize requ;ired services
            await this.initializeServices()

            // Initialize directory
            await this.ensurePlanDirectoryExists();

            // Configure platform formatting
            await this.configureFormatting();

            // Load existing plans
            await this.loadExistingPlans();

            // Schedule next micro plan creation
            await this.scheduleNextMicroPlanCreations();

            // Clean up stale locks
            await this.cleanupStaleLocks();

            // Mark as initialized
            this.isInitialized = true;
            elizaLogger.log("[PlanningService] Initialization complete");
        } catch (error) {
            elizaLogger.error("[PlanningService] Initialization error:", error);
            throw new Error("Failed to initialize PlanningService");
        }
    }

    private async ensurePlanDirectoryExists(): Promise<void> {
        try {
            await fs.access(this.plansDirectory);
            elizaLogger.debug(`[PlanningService] Plans directory exists: ${this.plansDirectory}`);
        } catch (error) {
            elizaLogger.log(`[PlanningService] Creating plans directory: ${this.plansDirectory}`);
            await fs.mkdir(this.plansDirectory, { recursive: true });
        }
    }

    private async initializeServices(): Promise<void> {
        try {
            // Get content manager service
            this.contentManager = await this.runtime.getService<ContentManagerService>(ContentManagerService.serviceType);

            if (!this.contentManager) {
                throw new Error("ContentManagerService not available");
            }

            // Get approval service
            this.approvalService = await this.contentManager.getMicroService<ContentApprovalService>("content-approval");

            if (!this.approvalService) {
                elizaLogger.warn("[PlanningService] ContentApprovalService not available, approval flow will be limited");
            }

            // Get adapter provider
            this.adapterProvider = await this.contentManager.getMicroService<AdapterProvider>("adapter-provider");

            if (!this.adapterProvider) {
                elizaLogger.warn("[PlanningService] AdapterProvider not available, content features will be limited");
                return;
            }

            // Get delivery service
            this.deliveryService = await this.contentManager.getMicroService<ContentDeliveryService>("content-delivery");

            if (!this.deliveryService) {
                elizaLogger.warn("[PlanningService] ContentDeliveryService not available, content scheduling will be limited");
            }

            // Get memory manager
            this.memoryManager = await this.contentManager.getMicroService<ContentAgentMemoryManager>("content-memory");

            if (!this.memoryManager) {
                elizaLogger.warn("[PlanningService] MemoryManager not available, content features may be limited");
            }

        } catch (error) {
            elizaLogger.error("[PlanningService] Error initializing services:", error);
            throw new Error(`Service initialization failed: ${error.message}`);
        }
    }

    private async configureFormatting(): Promise<void> {
        try {
            // Configure adapters
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
        } catch (error) {
            elizaLogger.error("[PlanningService] Error configuring platform formatting:", error);
            throw new Error("Failed to configure platform formatting");
        }
    }

    async createNextMicroPlan(masterPlanId: UUID): Promise<MicroPlan | null> {
        if (!this.isInitialized) {
            throw new Error("[PlanningService] Service not initialized");
        }

        // Create a lock key for this master plan
        const lockKey = `microplan_creation_lock:${masterPlanId}`;

        // Try to acquire a lock
        const lock = await this.runtime.cacheManager.get(lockKey);
        this.lockRegistry.add(lockKey);

        if (lock) {
            elizaLogger.warn(`[PlanningService] Microplan creation already in progress for master plan ${masterPlanId}`);
            return null;
        }
        // Set a lock with a timeout
        await this.runtime.cacheManager.set(
            lockKey,
            { locked: true, timestamp: new Date() },
            {
                expires: Date.now() + PLAN_LOCK_TIMEOUT,
            }
        );

        try {
            // Validate master plan exists
            const masterPlan = await this.memoryManager.getMasterPlanById(masterPlanId);
            if (!masterPlan) {
                elizaLogger.error(`[PlanningService] Cannot create micro plan: Master plan ${masterPlanId} not found`);
                return null;
            }

            // Get all micro plans for this master plan
            const microplans = await this.memoryManager.getMicroPlansForMasterPlan(masterPlanId);

            // Determine next start date
            const startDate = this.determineNextStartDate(microplans);
            const endDate = this.calculateEndDate(startDate, this.config.MICRO_PLAN_TIMEFRAME);

            // Check for overlapping plans
            const overlappingPlan = this.findOverlappingPlan(microplans, startDate, endDate);
            if (overlappingPlan) {
                elizaLogger.warn(`[PlanningService] Microplan already exists for period ${startDate.toISOString()} to ${endDate.toISOString()}`);
                return overlappingPlan;
            }

            // Create new micro plan
            const microPlan = await this.createMicroPlan(
                masterPlanId,
                this.config.MICRO_PLAN_TIMEFRAME,
                startDate
            );

            // Submit for approval
            if (this.approvalService && !this.config.AUTO_APPROVE_PLANS) {
                await this.submitPlanForApproval(microPlan);
            } else {
                // Auto-approve if configured or approval service not available
                const memory = await this.memoryManager.getMemoryById(microPlan.id);
                if (memory) {
                    const plan = JSON.parse(memory.content.text || "{}");
                    plan.approvalStatus = ApprovalStatus.APPROVED;
                    plan.modified = new Date();

                    const newMemory: Memory = {
                        ...memory,
                        content: {
                            ...memory.content,
                            text: JSON.stringify(plan)
                        }
                    };

                    await this.memoryManager.updateMemory(newMemory);
                    await this.savePlanToFile(plan);

                    // Schedule content
                    await this.scheduleContentFromMicroPlan(plan);
                }
            }

            // Schedule next micro plan creation
            await this.scheduleNextMicroPlanCreation(masterPlanId);

            return microPlan;
        } finally {
            // Release the lock
            await this.runtime.cacheManager.delete(lockKey);
            this.lockRegistry.delete(lockKey);
        }
    }

    private determineNextStartDate(microplans: MicroPlan[]): Date {
        let startDate = new Date();

        // Find the latest end date
        if (microplans && microplans.length > 0) {
            for (const plan of microplans) {
                if (plan.period.end > startDate) {
                    startDate = new Date(plan.period.end);
                }
            }
        }

        // If start date is in the past, use current date
        if (startDate < new Date()) {
            startDate = new Date();
        }

        return startDate;
    }

    private findOverlappingPlan(plans: MicroPlan[], startDate: Date, endDate: Date): MicroPlan | null {
        if (!plans || plans.length === 0) {
            return null;
        }

        return plans.find(plan => {
            // Check if date ranges overlap
            return (
                (plan.period.start <= startDate && plan.period.end >= startDate) ||
                (plan.period.start <= endDate && plan.period.end >= endDate) ||
                (plan.period.start >= startDate && plan.period.end <= endDate)
            );
        }) || null;
    }

    async submitPlanForApproval<T extends MasterPlan | MicroPlan>(plan: T): Promise<ApprovalRequest<T>> {
        if (!this.isInitialized) {
            throw new Error("[PlanningService] Service not initialized");
        }

        try {
            if (!this.approvalService) {
                throw new Error("Approval service not available");
            }

            // Binding the callback to maintain context
            const boundHandleStatusUpdate = this.handleStatusUpdate.bind(this);

            // Send for approval
            const approvalRequest = await this.approvalService.sendForApproval<T>(
                plan,
                boundHandleStatusUpdate
            );

            elizaLogger.log(`[PlanningService] Submitted plan ${plan.id} for approval (request ID: ${approvalRequest.id})`);
            return approvalRequest;
        } catch (error) {
            elizaLogger.error(`[PlanningService] Error submitting plan for approval:`, error);

            // If auto-approve is enabled, approve the plan directly
            if (this.config.AUTO_APPROVE_PLANS) {
                elizaLogger.log(`[PlanningService] Auto-approving plan ${plan.id} due to approval service error`);

                // Create an auto-approval request
                const autoApprovalRequest: ApprovalRequest<T> = {
                    id: crypto.randomUUID() as UUID,
                    content: plan,
                    platform: "auto",
                    requesterId: this.runtime.agentId,
                    timestamp: new Date(),
                    status: ApprovalStatus.APPROVED,
                    comments: "Auto-approved due to approval service error",
                    callback: this.handleStatusUpdate.bind(this)
                };

                // Handle the auto-approval
                await this.handleStatusUpdate(autoApprovalRequest);
                return autoApprovalRequest;
            }

            throw new Error(`Failed to submit plan for approval: ${error.message}`);
        }
    }

    async handleStatusUpdate<T extends MasterPlan | MicroPlan>(approvalRequest: ApprovalRequest<T>): Promise<void> {
        try {
            await this.updatePlanStatus(approvalRequest.content.id, approvalRequest.status);

            // Handle approved plan
            if (approvalRequest.status === ApprovalStatus.APPROVED) {
                await this.handleApprovedPlan(approvalRequest.content);
            } else if (approvalRequest.status === ApprovalStatus.REJECTED) {
                // Handle rejected plan
                elizaLogger.log(`[PlanningService] Plan ${approvalRequest.content.id} rejected`);
            }

        } catch (error) {
            elizaLogger.error(`[PlanningService] Error handling status update:`, error);
        }
    }

    private async updatePlanStatus(planId: UUID, newStatus: ApprovalStatus): Promise<void> {
        const memory = await this.memoryManager.getMemoryById(planId);
        if (!memory) return;

        const plan = JSON.parse(memory.content.text || "{}");
        const oldStatus = plan.approvalStatus;

        if (oldStatus === newStatus) return;

        plan.approvalStatus = newStatus;
        plan.modified = new Date();

        elizaLogger.log(`[PlanningService] Plan ${planId} status changed: ${oldStatus} → ${newStatus}`);

        await this.memoryManager.updateMemory({
            ...memory,
            content: {
                ...memory.content,
                text: JSON.stringify(plan)
            }
        });

        await this.savePlanToFile(plan);
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
            elizaLogger.error("[PlanningService] Failed to parse master plan:", error);

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
            elizaLogger.error("[PlanningService] Failed to parse micro plan:", error);

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

    private async handleApprovedPlan(plan: MasterPlan | MicroPlan): Promise<void> {
        try {
            // Handle master plan approval - create an initial micro plan
            if (plan.approvalStatus === ApprovalStatus.APPROVED && !("contentPieces" in plan)) {
                elizaLogger.log(`[PlanningService] Master plan ${plan.id} approved, creating initial micro plan`);
                await this.ensureMasterPlanHasMicroPlan(plan.id as UUID);
            }

            // Handle micro plan approval - schedule content pieces
            if (plan.approvalStatus === ApprovalStatus.APPROVED && "contentPieces" in plan) {
                await this.scheduleContentFromMicroPlan(plan as MicroPlan);
            }
        } catch (error) {
            elizaLogger.error(`[PlanningService] Error handling approved plan:`, error);
        }
    }

    private async scheduleContentFromMicroPlan(microPlan: MicroPlan): Promise<void> {
        if (!this.deliveryService) {
            elizaLogger.warn(`[PlanningService] Content delivery service not available, cannot schedule content`);
            return;
        }

        elizaLogger.log(`[PlanningService] Scheduling ${microPlan.contentPieces.length} content pieces from micro plan ${microPlan.id}`);

        let scheduled = 0;

        for (const piece of microPlan.contentPieces) {
            try {
                // Ensure schedule date is in the future
                if (piece.scheduledDate <= new Date()) {
                    const now = new Date();
                    // Add 1 hour to current time
                    piece.scheduledDate = new Date(now.getTime() + 60 * 60 * 1000);
                }

                // Submit content for scheduling
                await this.deliveryService.submitContent(piece, {
                    scheduledTime: piece.scheduledDate,
                    skipApproval: false
                });

                scheduled++;
            } catch (error) {
                elizaLogger.error(`[PlanningService] Error scheduling content piece ${piece.id}:`, error);
            }
        }

        elizaLogger.log(`[PlanningService] Scheduled ${scheduled} of ${microPlan.contentPieces.length} content pieces from micro plan ${microPlan.id}`);
    }

    private async ensureMasterPlanHasMicroPlan(masterPlanId: UUID): Promise<void> {
        try {
            // Check if master plan already has micro plans
            const microplans = await this.memoryManager.getMicroPlansForMasterPlan(masterPlanId);

            if (!microplans || microplans.length === 0) {
                elizaLogger.log(`[PlanningService] Creating initial micro plan for master plan ${masterPlanId}`);
                await this.createNextMicroPlan(masterPlanId);
            } else {
                elizaLogger.log(`[PlanningService] Master plan ${masterPlanId} already has ${microplans.length} micro plans`);

                // Schedule next micro plan creation
                await this.scheduleNextMicroPlanCreation(masterPlanId);
            }
        } catch (error) {
            elizaLogger.error(`[PlanningService] Error ensuring master plan has micro plan:`, error);
        }
    }

    private async scheduleNextMicroPlanCreation(masterPlanId: UUID): Promise<void> {
        try {
            // Clear any existing timer for this master plan
            if (this.planCreationTimers.has(masterPlanId)) {
                clearTimeout(this.planCreationTimers.get(masterPlanId));
                this.planCreationTimers.delete(masterPlanId);
            }

            // Get all micro plans for this master plan
            const microplans = await this.memoryManager.getMicroPlansForMasterPlan(masterPlanId);

            // Find the latest end date
            let latestEndDate = new Date();
            for (const plan of microplans || []) {
                if (plan.period.end > latestEndDate) {
                    latestEndDate = new Date(plan.period.end);
                }
            }

            // Calculate when to create the next plan
            const halfTimeframeMs = timeframeToMilliseconds[this.config.MICRO_PLAN_TIMEFRAME] / 2;
            const createDate = new Date(latestEndDate.getTime() - halfTimeframeMs);

            // If creation date is in the past, create immediately
            if (createDate <= new Date()) {
                elizaLogger.log(`[PlanningService] Creating new micro plan immediately for master plan ${masterPlanId}`);
                await this.createNextMicroPlan(masterPlanId);
            } else {
                // Schedule creation at the appropriate time
                const delay = createDate.getTime() - Date.now();

                // Create a bound function to maintain context
                const boundCreateFunction = async () => {
                    try {
                        elizaLogger.log(`[PlanningService] Scheduled creation of micro plan for master plan ${masterPlanId}`);
                        await this.createNextMicroPlan(masterPlanId);
                    } catch (error) {
                        elizaLogger.error(`[PlanningService] Error in scheduled micro plan creation:`, error);

                        // Retry after a delay
                        setTimeout(() => {
                            this.scheduleNextMicroPlanCreation(masterPlanId);
                        }, 30 * 60 * 1000); // 30 minutes
                    }
                };

                const timeout = setTimeout(boundCreateFunction, delay);
                this.planCreationTimers.set(masterPlanId, timeout);

                elizaLogger.log(`[PlanningService] Scheduled micro plan creation for master plan ${masterPlanId} at ${createDate.toISOString()} (in ${Math.round(delay / (1000 * 60 * 60))} hours)`);
            }
        } catch (error) {
            elizaLogger.error(`[PlanningService] Error scheduling next micro plan creation:`, error);
        }
    }


    private async scheduleNextMicroPlanCreations(): Promise<void> {
        try {
            // Get all active master plans
            const masterPlans = await this.getActiveMasterPlans();

            for (const masterPlan of masterPlans) {
                await this.scheduleNextMicroPlanCreation(masterPlan.id);
            }
        } catch (error) {
            elizaLogger.error(`[PlanningService] Error scheduling next micro plan creations:`, error);
        }
    }

    private async cleanupStaleLocks(): Promise<void> {
        try {
            // Get all keys for microplan creation locks
            const masterPlans = await this.memoryManager.getMasterPlans();

            const allKeys = masterPlans.map(plan => `microplan_creation_lock:${plan.id}`);
            allKeys.push(...this.lockRegistry.keys());

            const now = Date.now();

            for (const key of allKeys) {
                const lock = await this.runtime.cacheManager.get<lockKey>(key);

                if (lock && lock.timestamp) {
                    const lockTime = new Date(lock.timestamp).getTime();
                    const lockAgeMinutes = (now - lockTime) / (60 * 1000);

                    // If lock is older than the timeout, delete it
                    if (lockAgeMinutes > PLAN_LOCK_TIMEOUT) {
                        elizaLogger.warn(`[PlanningService] Cleaning up stale lock: ${lock}, age: ${Math.round(lockAgeMinutes)} minutes`);
                        await this.runtime.cacheManager.delete(key);
                        if (this.lockRegistry.has(key)) {
                            this.lockRegistry.delete(key);
                        }
                    }
                } else {
                    if (this.lockRegistry.has(key)) {
                        this.lockRegistry.delete(key);
                    }
                }
            }

        } catch (error) {
            elizaLogger.error(`[PlanningService] Error cleaning up stale locks:`, error);
        }
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

    async shutdown(): Promise<void> {
        elizaLogger.debug("[PlanningService] Shutting down PlanningService");

        // Clear all timers
        for (const [masterPlanId, timer] of this.planCreationTimers.entries()) {
            clearTimeout(timer);
        }

        this.planCreationTimers.clear();
    }
}

const timeframeToMilliseconds = {
    [Timeframe.DAILY]: 24 * 60 * 60 * 1000,
    [Timeframe.WEEKLY]: 7 * 24 * 60 * 60 * 1000,
    [Timeframe.MONTHLY]: 30 * 24 * 60 * 60 * 1000,
    [Timeframe.QUARTERLY]: 90 * 24 * 60 * 60 * 1000
};