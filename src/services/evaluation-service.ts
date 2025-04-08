// src/services/evaluation-service.ts
import { UUID, IAgentRuntime, ModelClass, generateText } from "@elizaos/core";
import {
    ProgressEvaluation,
    GoalProgress,
    GoalStatus,
    MasterPlan,
    ContentPiece,
    ContentStatus
} from "../types";
import { ContentAgentMemoryManager } from "../managers/content-memory-manager";

export class EvaluationService {
    constructor(private runtime: IAgentRuntime, private memoryManager: ContentAgentMemoryManager) { }

    async evaluateProgress(masterPlanId: UUID): Promise<ProgressEvaluation> {
        // Fetch master plan
        const masterPlan = await this.memoryManager.getMasterPlanById(masterPlanId);
        if (!masterPlan) {
            throw new Error(`Master plan with ID ${masterPlanId} not found`);
        }

        // Fetch all micro plans for this master plan
        const microPlans = await this.memoryManager.getMicroPlansForMasterPlan(masterPlanId);

        // Get all content pieces from micro plans
        const allContentPieces = microPlans.flatMap(plan => plan.contentPieces);

        // Evaluate progress for each goal
        const goalProgress: GoalProgress[] = await Promise.all(
            masterPlan.goals.map(goal => this.evaluateGoalProgress(goal.id, masterPlan, allContentPieces))
        );

        // Calculate overall progress
        const overallProgress = goalProgress.reduce(
            (sum, progress) => sum + progress.completionPercentage,
            0
        ) / masterPlan.goals.length;

        // Create progress evaluation
        const progressEvaluation: ProgressEvaluation = {
            id: crypto.randomUUID() as UUID,
            masterPlanId,
            evaluationDate: new Date(),
            goals: goalProgress,
            overallProgress,
            nextEvaluationDate: this.calculateNextEvaluationDate()
        };

        // Store evaluation
        await this.memoryManager.createProgressEvaluation(
            progressEvaluation
        );

        return progressEvaluation;
    }

    private async evaluateGoalProgress(
        goalId: UUID,
        masterPlan: MasterPlan,
        contentPieces: ContentPiece[]
    ): Promise<GoalProgress> {
        // Find the goal in the master plan
        const goal = masterPlan.goals.find(g => g.id === goalId);
        if (!goal) {
            throw new Error(`Goal with ID ${goalId} not found in master plan`);
        }

        // Filter content pieces that contribute to this goal
        const contributingPieces = contentPieces.filter(piece =>
            piece.goalAlignment.includes(goalId) &&
            piece.status === ContentStatus.PUBLISHED
        );

        // Generate goal progress analysis using LLM
        const prompt = `Evaluate progress on the following content goal:

Goal: ${goal.description}
KPIs: ${goal.kpis.map(kpi => `${kpi.metric}: ${kpi.target}`).join(', ')}
Completion criteria: ${goal.completionCriteria}

Published content pieces aligned with this goal:
${contributingPieces.map(piece => `- ${piece.topic} (${piece.platform})`).join('\n')}

Please evaluate:
1. Current completion percentage (0-100)
2. Current status (PENDING, IN_PROGRESS, or COMPLETE)
3. A list of recommended actions to improve progress

Format your response as a JSON object:
{
  "completionPercentage": number,
  "status": "PENDING" | "IN_PROGRESS" | "COMPLETE",
  "recommendedActions": ["string"]
}`;

        // Run LLM evaluation
        const llmResponse = await generateText({
            runtime: this.runtime,
            context: prompt,
            modelClass: ModelClass.LARGE
        });

        try {
            // Parse LLM response
            const parsedResponse = JSON.parse(llmResponse);

            // Create goal progress
            return {
                goalId,
                status: parsedResponse.status || GoalStatus.PENDING,
                completionPercentage: typeof parsedResponse.completionPercentage === 'number'
                    ? Math.max(0, Math.min(100, parsedResponse.completionPercentage))
                    : 0,
                contentContributing: contributingPieces.map(piece => piece.id),
                recommendedActions: Array.isArray(parsedResponse.recommendedActions)
                    ? parsedResponse.recommendedActions
                    : []
            };
        } catch (error) {
            console.error("Failed to parse goal progress evaluation:", error);

            // Return default goal progress
            return {
                goalId,
                status: contributingPieces.length > 0 ? GoalStatus.IN_PROGRESS : GoalStatus.PENDING,
                completionPercentage: Math.min(100, contributingPieces.length * 10), // Simple heuristic
                contentContributing: contributingPieces.map(piece => piece.id),
                recommendedActions: ["Recommended action not available due to evaluation error"]
            };
        }
    }

    private calculateNextEvaluationDate(): Date {
        // Default to one week from now
        const nextDate = new Date();
        nextDate.setDate(nextDate.getDate() + 7);
        return nextDate;
    }
}