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
    Milestone
} from "../types";
import { ContentAgentMemoryManager } from "../managers/contentMemory";

export class PlanningService {
    constructor(private runtime: IAgentRuntime, private memoryManager: ContentAgentMemoryManager) { }

    async createMasterPlan(baseInfo: Partial<MasterPlan>): Promise<MasterPlan> {
        // Generate master plan using LLM if only partial info provided
        const masterPlan = await this.generateMasterPlan(baseInfo);

        // Store master plan in database
        await this.memoryManager.createMasterPlan(masterPlan);

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

        return microPlan;
    }

    async getMasterPlan(id: UUID): Promise<MasterPlan | null> {
        return await this.memoryManager.getMasterPlanById(id);
    }

    async getActiveMasterPlans(): Promise<MasterPlan[]> {
        const plans = await this.memoryManager.getMasterPlans();
        return plans.filter(plan => plan.approvalStatus === ApprovalStatus.APPROVED);
    }

    async updateMasterPlanStatus(id: UUID, status: ApprovalStatus): Promise<boolean> {
        const masterPlan = await this.getMasterPlan(id);
        if (!masterPlan) {
            return false;
        }

        // Update status
        masterPlan.approvalStatus = status;
        masterPlan.modified = new Date();

        // Store updated plan
        await this.memoryManager.createMasterPlan(masterPlan);

        return true;
    }

    private async generateMasterPlan(baseInfo: Partial<MasterPlan>): Promise<MasterPlan> {
        // Create a prompt for the LLM
        const prompt = `Create a comprehensive content master plan based on the following information:
${JSON.stringify(baseInfo, null, 2)}

The plan should include:
1. Clear goals with KPIs and completion criteria
2. Content mix with category ratios and platform formats
3. Audience segments with characteristics and pain points
4. Brand voice guidelines
5. Timeline with milestones

Format your response as a JSON object with the following structure:
{
  "title": "string",
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
}`;

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
                id: baseInfo.id || crypto.randomUUID() as UUID,
                title: parsedPlan.title || baseInfo.title || "Content Master Plan",
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
                id: baseInfo.id || crypto.randomUUID() as UUID,
                title: baseInfo.title || "Content Master Plan",
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
]`;

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
                ? contentPieces.map(piece => ({
                    id: crypto.randomUUID() as UUID,
                    topic: piece.topic || "Untitled content",
                    format: piece.format || "post",
                    platform: piece.platform || "twitter",
                    goalAlignment: Array.isArray(piece.goalAlignment)
                        ? piece.goalAlignment
                        : [],
                    scheduledDate: piece.scheduledDate
                        ? new Date(piece.scheduledDate)
                        : new Date(),
                    keywords: Array.isArray(piece.keywords)
                        ? piece.keywords
                        : [],
                    mediaRequirements: Array.isArray(piece.mediaRequirements)
                        ? piece.mediaRequirements
                        : [],
                    brief: piece.brief || "No brief provided",
                    status: ContentStatus.PLANNED
                }))
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
}