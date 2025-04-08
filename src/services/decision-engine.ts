// src/services/decision-engine.ts
import { UUID, IAgentRuntime, generateText, ModelClass, elizaLogger } from "@elizaos/core";
import {
    ContentDecision,
    ContentDecisionItem,
    NewsEvent,
    TrendingTopic,
    MasterPlan,
    MicroPlan,
    DecisionContext,
    ApprovalStatus
} from "../types";
import { ContentAgentMemoryManager } from "../managers/content-memory-manager";

export class DecisionEngine {
    constructor(private runtime: IAgentRuntime, private memoryManager: ContentAgentMemoryManager) { }

    async makeContentDecision(): Promise<ContentDecision> {
        // 1. Gather all relevant context
        const masterPlans = await this.memoryManager.getMasterPlans();
        const activeMasterPlan = masterPlans.find(p => p.approvalStatus === ApprovalStatus.APPROVED) || null;

        const newsEvents = await this.memoryManager.getRecentNewsEvents();
        const trendingTopics = await this.memoryManager.getRecentTrendingTopics();

        let microPlans: MicroPlan[] = [];
        if (activeMasterPlan) {
            microPlans = await this.memoryManager.getMicroPlansForMasterPlan(activeMasterPlan.id);
        }

        // 2. Generate decision using LLM
        const decision = await this.generateDecision(activeMasterPlan, microPlans, newsEvents, trendingTopics);

        // 3. Store decision for future reference
        await this.storeDecision(decision);

        return decision;
    }

    private async generateDecision(
        masterPlan: MasterPlan | null,
        microPlans: MicroPlan[],
        newsEvents: NewsEvent[],
        trendingTopics: TrendingTopic[]
    ): Promise<ContentDecision> {
        // Create prompt for the LLM
        const prompt = this.createDecisionPrompt(masterPlan, microPlans, newsEvents, trendingTopics);

        // Generate decision using the LLM
        const llmResponse = await generateText({
            runtime: this.runtime,
            context: prompt,
            modelClass: ModelClass.LARGE
        });

        // Parse the LLM response
        return this.parseDecisionResponse(llmResponse, {
            evaluatedNews: newsEvents.map(n => n.id),
            evaluatedTrends: trendingTopics.map(t => t.id),
            evaluatedPlans: microPlans.map(p => p.id),
        });
    }

    private createDecisionPrompt(
        masterPlan: MasterPlan | null,
        microPlans: MicroPlan[],
        newsEvents: NewsEvent[],
        trendingTopics: TrendingTopic[]
    ): string {
        return `You are making content creation decisions for a brand. Based on the following information, decide what content should be created next.

## Master Plan
${masterPlan ? JSON.stringify(masterPlan, null, 2) : "No active master plan"}

## Recent News Events
${newsEvents.map(news => `- ${news.headline} (Relevance: ${news.relevanceScore})`).join('\n')}

## Trending Topics
${trendingTopics.map(topic => `- ${topic.name} (Volume: ${topic.volume}, Growth: ${topic.growthRate})`).join('\n')}

## Scheduled Content
${microPlans.flatMap(plan => plan.contentPieces).map(piece => `- ${piece.topic} (${piece.platform}, ${new Date(piece.scheduledDate).toISOString()})`).join('\n')}

Please provide:
1. A list of content pieces to create
2. For each piece, specify: content type, topic, platform, timing, priority (1-10), whether it was in the original plan
3. A rationale for each content piece
4. Any relevant news events or trending topics that influenced the decision
5. Which master plan goals each piece addresses

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

    private parseDecisionResponse(
        response: string,
        context: DecisionContext
    ): ContentDecision {
        try {
            // Attempt to parse JSON response
            const parsedResponse = JSON.parse(response);

            // Create a properly formatted ContentDecision
            const decision: ContentDecision = {
                id: crypto.randomUUID() as UUID,
                timestamp: new Date(),
                contentToCreate: Array.isArray(parsedResponse.contentToCreate)
                    ? parsedResponse.contentToCreate.map(this.formatContentDecisionItem)
                    : [],
                context,
                decisionRationale: parsedResponse.decisionRationale || "No rationale provided"
            };

            return decision;
        } catch (error) {
            elizaLogger.error("Failed to parse decision response:", error);

            // Fallback to a default empty decision
            return {
                id: crypto.randomUUID() as UUID,
                timestamp: new Date(),
                contentToCreate: [],
                context,
                decisionRationale: "Failed to generate a valid content decision"
            };
        }
    }

    private formatContentDecisionItem(item: any): ContentDecisionItem {
        return {
            contentType: item.contentType || "post",
            topic: item.topic || "Untitled content",
            platform: item.platform || "twitter",
            timing: item.timing || "immediate",
            priority: typeof item.priority === 'number' ? item.priority : 5,
            isPlanned: Boolean(item.isPlanned),
            reasonForSelection: item.reasonForSelection || "",
            relevantNews: Array.isArray(item.relevantNews) ? item.relevantNews : [],
            relevantTrends: Array.isArray(item.relevantTrends) ? item.relevantTrends : [],
            relevantGoals: Array.isArray(item.relevantGoals) ? item.relevantGoals : []
        };
    }

    private async storeDecision(decision: ContentDecision): Promise<void> {
        // Store the decision
        await this.memoryManager.createContentDecision(decision);
    }
}