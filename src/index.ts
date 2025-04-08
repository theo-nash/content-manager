import { createMasterPlanAction } from "./actions/create-master-plan";
import { generateMicroPlanAction } from "./actions/generate-micro-plan";
import { contentStrategyProvider } from "./providers/content-strategy-provider";
import { Plugin } from "@elizaos/core";
import { ContentManagerService } from "./services/contentManager";

const contentManagerPlugin: Plugin = {
    name: "content-manager",
    description: "Plugin to manage and plan content effectively",
    actions: [
        createMasterPlanAction,
        generateMicroPlanAction,
    ],
    services: [new ContentManagerService()],
    providers: [
        contentStrategyProvider,
    ],
};

export default contentManagerPlugin;