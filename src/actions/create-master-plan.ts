// src/actions/create-master-plan.ts
import {
    Action,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    ModelType,
    State
} from "@elizaos/core";
import { PlanningService } from "../services/planningService";

export const createMasterPlanAction: Action = {
    name: "CREATE_MASTER_PLAN",
    similes: ["GENERATE_CONTENT_STRATEGY", "PLAN_CONTENT", "CREATE_CONTENT_PLAN"],
    description: "Creates a comprehensive master content plan.",

    validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
        const text = message.content.text?.toLowerCase() || "";
        return (
            text.includes("create master plan") ||
            text.includes("content strategy") ||
            text.includes("content plan") ||
            text.includes("master plan")
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
                thought: "The user wants me to create a content master plan. I'll use the planning service to generate a comprehensive plan based on their request.",
                text: "I'll create a comprehensive content master plan for you. This may take a moment...",
                actions: ["CREATE_MASTER_PLAN"]
            });
        }

        try {
            // Extract basic info from the message
            const planningService = new PlanningService(runtime);

            // Generate a plan title from the message
            const titlePrompt = `Based on the following request, generate a concise, descriptive title for a content master plan:
        
  Request: ${message.content.text}
  
  Reply with just the title text, no quotes or additional formatting.`;

            const generatedTitle = await runtime.useModel(ModelType.TEXT_SMALL, {
                prompt: titlePrompt,
                temperature: 0.5,
                maxTokens: 50
            });

            // Create the master plan
            const masterPlan = await planningService.createMasterPlan({
                title: generatedTitle.trim()
            });

            // Send the master plan to the user
            if (callback) {
                await callback({
                    thought: "I've generated a comprehensive master plan based on the user's request. I'll share the key details of the plan with them.",
                    text: `I've created a master content plan titled: **${masterPlan.title}**
  
  The plan includes:
  - ${masterPlan.goals.length} strategic goals with measurable KPIs
  - Content mix across ${masterPlan.contentMix.length} categories and platforms
  - Brand voice guidelines and audience segmentation
  - Timeline from ${masterPlan.timeline.startDate.toLocaleDateString()} to ${masterPlan.timeline.endDate.toLocaleDateString()}
  
  The plan is currently in DRAFT status. Would you like me to provide more details about any specific aspect of the plan?`,
                    actions: ["CREATE_MASTER_PLAN"]
                });
            }

            return true;
        } catch (error) {
            console.error("Error creating master plan:", error);

            if (callback) {
                await callback({
                    thought: "There was an error generating the master plan. I'll inform the user and suggest alternatives.",
                    text: "I apologize, but I encountered an error while creating your content master plan. Would you like to try again with more specific requirements?",
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
                content: { text: "Can you create a content master plan for my tech startup?" }
            },
            {
                name: "{{name2}}",
                content: {
                    text: "I'll create a comprehensive content master plan for you. This may take a moment...",
                    thought: "The user wants me to create a content master plan. I'll use the planning service to generate a comprehensive plan based on their request.",
                    actions: ["CREATE_MASTER_PLAN"]
                }
            }
        ]
    ]
};