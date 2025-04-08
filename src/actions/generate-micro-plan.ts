// src/actions/generate-micro-plan.ts
import {
    Action,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    ModelType,
    State,
    UUID
} from "@elizaos/core";
import { PlanningService } from "../services/planningService";
import * as db from "../database";
import { Timeframe } from "../types";

export const generateMicroPlanAction: Action = {
    name: "GENERATE_MICRO_PLAN",
    similes: ["CREATE_WEEKLY_PLAN", "GENERATE_CONTENT_SCHEDULE", "PLAN_CONTENT_WEEK"],
    description: "Generates a short-term content plan from a master plan.",

    validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
        const text = message.content.text?.toLowerCase() || "";
        return (
            text.includes("micro plan") ||
            text.includes("weekly plan") ||
            text.includes("content schedule") ||
            text.includes("daily content")
        );
    },

    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state?: State,
        options?: any,
        callback?: HandlerCallback
    ): Promise<boolean> => {
        // First, let the user know we're processing
        if (callback) {
            await callback({
                thought: "The user wants me to create a micro content plan. I need to check if there's an approved master plan first, then generate the micro plan based on it.",
                text: "I'll generate a detailed micro content plan for you. Let me check if we have an approved master plan to work from...",
                actions: ["GENERATE_MICRO_PLAN"]
            });
        }

        try {
            // Get active master plans
            const planningService = new PlanningService(runtime);
            const activePlans = await planningService.getActiveMasterPlans();

            if (activePlans.length === 0) {
                // No active master plan found
                if (callback) {
                    await callback({
                        thought: "There are no approved master plans to generate a micro plan from. I should inform the user and suggest creating a master plan first.",
                        text: "I don't see any approved master content plans to work from. Would you like me to create a master plan first?",
                        actions: ["REPLY"]
                    });
                }
                return false;
            }

            // Determine timeframe from message
            let timeframe = Timeframe.WEEKLY; // Default
            const text = message.content.text?.toLowerCase() || "";

            if (text.includes("daily") || text.includes("today")) {
                timeframe = Timeframe.DAILY;
            } else if (text.includes("month")) {
                timeframe = Timeframe.MONTHLY;
            } else if (text.includes("quarter")) {
                timeframe = Timeframe.QUARTERLY;
            }

            // Use the most recently created active master plan
            const masterPlan = activePlans.sort((a, b) =>
                new Date(b.created).getTime() - new Date(a.created).getTime()
            )[0];

            // Create the micro plan
            const microPlan = await planningService.createMicroPlan(
                masterPlan.id,
                timeframe,
                new Date()
            );

            // Send the micro plan to the user
            if (callback) {
                await callback({
                    thought: "I've generated a micro plan based on the approved master plan. I'll share the key details with the user.",
                    text: `I've created a ${timeframe.toLowerCase()} content plan based on the "${masterPlan.title}" master plan.
  
  This plan includes ${microPlan.contentPieces.length} content pieces scheduled from ${microPlan.period.start.toLocaleDateString()} to ${microPlan.period.end.toLocaleDateString()}.
  
  Here's a summary of the content:
  ${microPlan.contentPieces.slice(0, 5).map(piece =>
                        `- ${piece.topic} (${piece.platform}, ${new Date(piece.scheduledDate).toLocaleDateString()})`
                    ).join('\n')}
  ${microPlan.contentPieces.length > 5 ? `\n...and ${microPlan.contentPieces.length - 5} more content pieces.` : ''}
  
  The plan is currently in DRAFT status. Would you like me to provide more details or make any adjustments?`,
                    actions: ["GENERATE_MICRO_PLAN"]
                });
            }

            return true;
        } catch (error) {
            console.error("Error generating micro plan:", error);

            if (callback) {
                await callback({
                    thought: "There was an error generating the micro plan. I'll inform the user and suggest alternatives.",
                    text: "I apologize, but I encountered an error while creating your micro content plan. Would you like to try again with more specific requirements?",
                    actions: ["REPLY"]
                });
            }

            return false;
        }
    },

    examples: [
        [
            {
                name: "{{name1}}",
                content: { text: "Can you create a weekly content plan for my blog?" }
            },
            {
                name: "{{name2}}",
                content: {
                    text: "I'll generate a detailed micro content plan for you. Let me check if we have an approved master plan to work from...",
                    thought: "The user wants me to create a micro content plan. I need to check if there's an approved master plan first, then generate the micro plan based on it.",
                    actions: ["GENERATE_MICRO_PLAN"]
                }
            }
        ]
    ]
};