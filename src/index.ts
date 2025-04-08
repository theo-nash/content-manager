import { elizaLogger, IAgentRuntime, Plugin } from "@elizaos/core";
import { validateContentPlanningConfig } from "./environment";
import { createMasterPlanAction } from "./actions/create-master-plan";
import { generateMicroPlanAction } from "./actions/generate-micro-plan";
import { contentStrategyProvider } from "./providers/content-strategy-provider";
import { DecisionEngine } from "./services/decision-engine";
import { PlanningService } from "./services/planning-service";
import { NewsService } from "./services/news-service";
import { ContentService } from "./services/content-service";
import { EvaluationService } from "./services/evaluation-service";
import * as db from "./database";

const contentPlannerPlugin: Plugin = {
    name: "content-planner",
    description: "Plugin to manage and plan content effectively",

    init: async (config: Record<string, string>, runtime: IAgentRuntime) => {
        try {
            elizaLogger.info("Initializing content planner plugin");

            // Validate configuration
            const validatedConfig = await validateContentPlanningConfig(runtime);
            elizaLogger.info("Content planner configuration:", validatedConfig);

            // Initialize database
            await db.ensureRoomsExist(runtime);

            // Initialize services
            const newsService = new NewsService(runtime);
            const planningService = new PlanningService(runtime);
            const contentService = new ContentService(runtime);
            const evaluationService = new EvaluationService(runtime);
            const decisionEngine = new DecisionEngine(runtime);

            // Fetch initial data
            try {
                const newsEvents = await newsService.fetchRecentNews();
                elizaLogger.info(`Fetched ${newsEvents.length} news events`);

                const trendingTopics = await newsService.fetchTrendingTopics();
                elizaLogger.info(`Fetched ${trendingTopics.length} trending topics`);
            } catch (error) {
                elizaLogger.error("Error fetching initial news data:", error);
            }

            elizaLogger.info("Content planner plugin initialized successfully");
        } catch (error) {
            elizaLogger.error("Error initializing content planner plugin:", error);
        }
    },

    actions: [
        createMasterPlanAction,
        generateMicroPlanAction,
        // Add more actions as implemented
    ],

    providers: [
        contentStrategyProvider,
        // Add more providers as implemented
    ],

    // Register evaluators, models, routes, etc. as needed
};

export default contentPlannerPlugin;