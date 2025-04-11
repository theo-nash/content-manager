// src/services/decision-engine.ts
import { UUID, IAgentRuntime, generateText, generateObject, ModelClass, elizaLogger } from "@elizaos/core";
import {
    ContentDecision,
    ContentDecisionItem,
    NewsEvent,
    TrendingTopic,
    MasterPlan,
    MicroPlan,
    DecisionContext,
    ApprovalStatus,
    ContentPiece,
    DecisionTracking
} from "../types";
import { ContentAgentMemoryManager } from "../managers/contentMemory";
import { z } from "zod";
import { ContentManagerService } from "./contentManager";

export class DecisionEngine {
    private isInitialized: boolean = false;
    private memoryManager: ContentAgentMemoryManager | null = null;
    private contentManager: ContentManagerService | null = null;

    constructor(private runtime: IAgentRuntime) { }

    async initialize(): Promise<void> {
        if (this.isInitialized) {
            elizaLogger.debug("[DecisionEngine] DecisionEngine is already initialized");
            return;
        }

        // Initialize the service
        elizaLogger.debug("[DecisionEngine] Initializing DecisionEngine");

        // Initialize required services
        await this.initializeServices();

        this.isInitialized = true;
    }

    private async initializeServices(): Promise<void> {
        try {
            this.contentManager = await this.runtime.getService<ContentManagerService>(ContentManagerService.serviceType);
            if (!this.contentManager) {
                throw new Error("[DecisionEngine] ContentManagerService not available");
            }

            // Get delivery service
            this.memoryManager = await this.contentManager.getMicroService<ContentAgentMemoryManager>("content-memory");

            if (!this.memoryManager) {
                elizaLogger.warn("[DecisionEngine] MemoryManagerService not available, content features will be limited");
                return;
            }

            elizaLogger.debug("[DecisionEngine] AdapterProvider initialized successfully");

        } catch (error) {
            elizaLogger.error("[DecisionEngine] Error initializing services:", error);
            throw new Error(`Service initialization failed: ${error.message}`);
        }
    }

    /**
     * Makes a content creation decision based on master plans, current context, and external factors
     */
    async makeContentDecision(): Promise<ContentDecision> {
        elizaLogger.log("Decision Engine: Making content decision");

        // 1. Gather all relevant context
        const masterPlans = await this.memoryManager.getMasterPlans();
        const activeMasterPlan = masterPlans.find(p => p.approvalStatus === ApprovalStatus.APPROVED) || null;

        const newsEvents = await this.memoryManager.getRecentNewsEvents();
        const trendingTopics = await this.memoryManager.getRecentTrendingTopics();
        const upcomingEvents = this.getUpcomingEvents(activeMasterPlan);

        let microPlans: MicroPlan[] = [];
        let recentContentPieces = [];

        if (activeMasterPlan) {
            microPlans = await this.memoryManager.getMicroPlansForMasterPlan(activeMasterPlan.id);
            // Get most recent content for context
            recentContentPieces = await this.memoryManager.getRecentContentPieces(5);
        }

        // 2. Generate decision using LLM
        const decision = await this.generateDecision(
            activeMasterPlan,
            microPlans,
            newsEvents,
            trendingTopics,
            recentContentPieces,
            upcomingEvents
        );

        // 3. Store decision for future reference
        await this.memoryManager.createContentDecision(decision);
        elizaLogger.log(`Decision Engine: Created decision with ${decision.contentToCreate.length} content items`);

        return decision;
    }

    /**
     * Generate a content decision using LLM
     */
    private async generateDecision(
        masterPlan: MasterPlan | null,
        microPlans: MicroPlan[],
        newsEvents: NewsEvent[],
        trendingTopics: TrendingTopic[],
        recentContentPieces: any[],
        upcomingEvents: string[] = []
    ): Promise<ContentDecision> {
        const prompt = this.createDecisionPrompt(masterPlan, microPlans, newsEvents, trendingTopics, recentContentPieces, upcomingEvents);

        // Define schema for content decision validation
        const contentDecisionItemSchema = z.object({
            contentType: z.string(),
            topic: z.string(),
            platform: z.string(),
            timing: z.string(),
            priority: z.number().int().min(1).max(10),
            isPlanned: z.boolean(),
            reasonForSelection: z.string(),
            relevantNews: z.array(z.string()).optional(),
            relevantTrends: z.array(z.string()).optional(),
            relevantGoals: z.array(z.string()).optional()
        });

        const decisionSchema = z.object({
            contentToCreate: z.array(contentDecisionItemSchema),
            decisionRationale: z.string()
        });

        try {
            // Generate decision using LLM with schema validation
            const llmResponse: any = await generateObject({
                runtime: this.runtime,
                context: prompt,
                modelClass: ModelClass.LARGE,
                schema: decisionSchema,
                schemaName: "ContentDecision"
            });

            // Create final ContentDecision object
            const decision: ContentDecision = {
                id: crypto.randomUUID() as UUID,
                timestamp: new Date(),
                contentToCreate: llmResponse.contentToCreate.map(item => ({
                    contentType: item.contentType,
                    topic: item.topic,
                    platform: item.platform,
                    timing: item.timing,
                    priority: item.priority,
                    isPlanned: item.isPlanned,
                    reasonForSelection: item.reasonForSelection,
                    relevantNews: item.relevantNews || [],
                    relevantTrends: item.relevantTrends || [],
                    relevantGoals: item.relevantGoals || []
                })),
                evaluatedContext: this.createDecisionContextTracker(masterPlan, microPlans, newsEvents, trendingTopics, recentContentPieces),
                decisionRationale: llmResponse.decisionRationale
            };

            return decision;
        } catch (error) {
            elizaLogger.error("Decision Engine: Error generating decision:", error);

            // Return a fallback empty decision
            return {
                id: crypto.randomUUID() as UUID,
                timestamp: new Date(),
                contentToCreate: [],
                evaluatedContext: this.createDecisionContextTracker(masterPlan, microPlans, newsEvents, trendingTopics, recentContentPieces),
                decisionRationale: "Error generating content decision: " + (error instanceof Error ? error.message : String(error))
            };
        }
    }

    /**
     * Creates a decision context id tracking from all relevant inputs
     */
    private createDecisionContextTracker(
        masterPlan: MasterPlan | null,
        microPlans: MicroPlan[],
        newsEvents: NewsEvent[],
        trendingTopics: TrendingTopic[],
        recentContentPieces: any[],
        upcomingEvents: string[] = []
    ): DecisionTracking {
        // Extract relevant IDs for context
        return {
            masterPlan: masterPlan ? masterPlan.id : null,
            evaluatedNews: newsEvents.map(n => n.id),
            evaluatedTrends: trendingTopics.map(t => t.id),
            evaluatedPlans: microPlans.map(p => p.id),
            recentContent: recentContentPieces.map(c => c.id),
            upcomingEvents: upcomingEvents,
            temporalContext: {
                dayOfWeek: new Date().toLocaleDateString('en-US', { weekday: 'long' }),
                timeOfDay: this.getTimeOfDay(),
                upcomingEvents: this.getUpcomingEvents(masterPlan)
            }
        };
    }

    /**
    * Creates a detailed prompt for the LLM to make content decisions
    */
    private createDecisionPrompt(masterPlan: MasterPlan | null,
        microPlans: MicroPlan[],
        newsEvents: NewsEvent[],
        trendingTopics: TrendingTopic[],
        recentContentPieces: any[],
        upcomingEvents: string[]): string {
        return `You are making content creation decisions for a brand. Based on the following information, decide what content should be created next.

## Master Plan
${masterPlan ? this.formatMasterPlan(masterPlan) : "No active master plan"}

## Recent News Events (Last 24 Hours)
${newsEvents.length > 0
                ? newsEvents.map(news => this.formatNewsEvent(news)).join('\n')
                : "No recent news events"
            }

## Trending Topics
${trendingTopics.length > 0
                ? trendingTopics.map(topic => this.formatTrendingTopic(topic)).join('\n')
                : "No trending topics"
            }

## Scheduled Content
${recentContentPieces.length > 0
                ? recentContentPieces.map(content => this.formatScheduledContent(content)).join('\n')
                : "No scheduled content"
            }

## Recent Published Content
${recentContentPieces.length > 0
                ? recentContentPieces.map(content => this.formatRecentContent(content)).join('\n')
                : "No recent published content"
            }

## Current Temporal Context
- Date: ${new Date().toLocaleDateString()}
- Day of Week: ${new Date().toLocaleDateString('en-US', { weekday: 'long' })}
- Time of Day: ${this.getTimeOfDay()}
${upcomingEvents && upcomingEvents.length > 0
                ? "- Upcoming Events: " + upcomingEvents.join(', ')
                : "- No upcoming events"
            }

Please make content decisions based on:
1. Strategic alignment with master plan goals
2. Relevance to current news and trends
3. Avoiding content repetition or overlap
4. Optimal timing for audience engagement
5. Appropriate platform selection

Provide a list of content pieces to create with:
- Content type and topic
- Platform recommendation
- Timing (immediate or scheduled date/time)
- Priority level (1-10)
- Whether it was in the original plan or opportunistic
- Rationale for each recommendation
- Relevant news, trends, or goals that influenced the decision

Format your response as a JSON object with the following structure:
{
  "contentToCreate": [
    {
      "contentType": "string",
      "topic": "string",
      "platform": "string",
      "timing": "string",
      "priority": number,
      "isPlanned": boolean,
      "reasonForSelection": "string",
      "relevantNews": ["newsId1", "newsId2"],
      "relevantTrends": ["trendId1", "trendId2"],
      "relevantGoals": ["goalId1", "goalId2"]
    }
  ],
  "decisionRationale": "string explaining the overall decision making process"
}`;
    }

    /**
     * Gets the current time of day (morning, afternoon, evening)
     */
    private getTimeOfDay(): string {
        const hour = new Date().getHours();
        if (hour < 12) return "morning";
        if (hour < 18) return "afternoon";
        return "evening";
    }

    /**
     * Extracts upcoming events from the master plan
     */
    private getUpcomingEvents(masterPlan: MasterPlan | null): string[] {
        if (!masterPlan) return [];

        const upcomingEvents = [];
        const now = new Date();

        // Look for upcoming milestones in the next 7 days
        for (const milestone of masterPlan.timeline.milestones) {
            const milestoneDate = new Date(milestone.date);
            const daysDiff = Math.floor((milestoneDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

            if (daysDiff >= 0 && daysDiff <= 7) {
                upcomingEvents.push(milestone.description);
            }
        }

        return upcomingEvents;
    }

    /**
     * Format master plan for prompt
     */
    private formatMasterPlan(masterPlan: MasterPlan): string {
        return `Title: ${masterPlan.title}
Goals: ${masterPlan.goals.map(g => `${g.description} (Priority: ${g.priority})`).join(', ')}
Brand Voice: ${masterPlan.brandVoice.tone}
Timeline: ${new Date(masterPlan.timeline.startDate).toLocaleDateString()} to ${new Date(masterPlan.timeline.endDate).toLocaleDateString()}`;
    }

    /**
     * Format news event for prompt
     */
    private formatNewsEvent(news: NewsEvent): string {
        return `- ${news.headline} (Source: ${news.source}, Relevance: ${news.relevanceScore.toFixed(2)})`;
    }

    /**
     * Format trending topic for prompt
     */
    private formatTrendingTopic(topic: TrendingTopic): string {
        return `- ${topic.name} (Platform: ${topic.platform}, Volume: ${topic.volume || 'Unknown'}, Growth: ${topic.growthRate || 'Unknown'})`;
    }

    /**
     * Format scheduled content for prompt
     */
    private formatScheduledContent(content: any): string {
        return `- ${content.topic} (${content.platform}, ${new Date(content.scheduledDate).toLocaleDateString()})`;
    }

    /**
     * Format recent content for prompt
     */
    private formatRecentContent(content: any): string {
        return `- ${content.topic} (${content.platform}, ${new Date(content.created).toLocaleDateString()})`;
    }
}