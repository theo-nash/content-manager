import { createMasterPlanAction } from "./actions/create-master-plan";
import { generateMicroPlanAction } from "./actions/generate-micro-plan";
import { contentStrategyProvider } from "./providers/content-strategy-provider";
import { Plugin } from "@elizaos/core";
import { ContentManagerService } from "./services/contentManager";
import { ScheduleContentAction } from "./actions/schedule-content";
import { GenerateContentAction } from "./actions/generate-content";

const contentManagerPlugin: Plugin = {
    name: "content-manager",
    description: "Plugin to manage and plan content effectively",
    actions: [
        createMasterPlanAction,
        generateMicroPlanAction,
        ScheduleContentAction,
        GenerateContentAction
    ],
    services: [new ContentManagerService()],
    providers: [
        contentStrategyProvider,
    ],
};

export default contentManagerPlugin;