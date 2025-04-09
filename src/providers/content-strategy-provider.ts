// src/providers/content-strategy-provider.ts
import { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import { TABLE_NAME, ROOM_IDS } from "../managers/contentMemory";
import { ApprovalStatus, MasterPlan, MicroPlan } from "../types";

export const contentStrategyProvider: Provider = {
    get: async (runtime: IAgentRuntime, message: Memory, state: State): Promise<any> => {
        // Get contet memory manager
        const memoryManager = await runtime.getMemoryManager(TABLE_NAME);

        // Get active master plans
        const _m = await memoryManager.getMemoriesByRoomIds({ roomIds: [ROOM_IDS.MASTER_PLANS] });

        const masterPlans = _m.map(memory => {
            try {
                return JSON.parse(memory.content.text || "{}") as MasterPlan;
            } catch {
                return null;
            }
        })
            .filter(Boolean) as MasterPlan[];

        const activePlans = masterPlans.filter(plan => plan.approvalStatus === ApprovalStatus.APPROVED);

        if (activePlans.length === 0) {
            return {
                text: "There are no active content strategies at this time.",
                values: {
                    hasActiveStrategy: false
                },
                data: {
                    masterPlans: [],
                    microPlans: []
                }
            };
        }

        // Use the most recent active plan
        const activePlan = activePlans.sort((a, b) =>
            new Date(b.created).getTime() - new Date(a.created).getTime()
        )[0];

        // Get micro plans for this master plan
        const _mp = await memoryManager.getMemoriesByRoomIds({ roomIds: [ROOM_IDS.MICRO_PLANS] });

        const allMicroPlans = _mp.map(memory => {
            try {
                return JSON.parse(memory.content.text || "{}") as MicroPlan;
            } catch {
                return null;
            }
        })
            .filter(Boolean) as MicroPlan[];

        const microPlans = allMicroPlans.filter(plan => plan.masterPlanId === activePlan.id);

        // Format goals for text display
        const goalsText = activePlan.goals
            .sort((a, b) => a.priority - b.priority)
            .map(goal => `- ${goal.description} (Priority: ${goal.priority})`)
            .join('\n');

        return {
            text: `Active Content Strategy: ${activePlan.title}

Top Goals:
${goalsText}

Brand Voice: ${activePlan.brandVoice.tone}

Timeline: ${activePlan.timeline.startDate.toLocaleDateString()} to ${activePlan.timeline.endDate.toLocaleDateString()}

There are currently ${microPlans.length} micro plans derived from this strategy.`,
            values: {
                hasActiveStrategy: true,
                activeStrategyTitle: activePlan.title,
                activeStrategyGoals: activePlan.goals.map(g => g.description).join(', '),
                brandVoice: activePlan.brandVoice.tone,
                microPlanCount: microPlans.length
            },
            data: {
                masterPlans: activePlans,
                microPlans
            }
        };
    }
};