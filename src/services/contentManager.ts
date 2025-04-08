import { UUID, Service, IAgentRuntime, elizaLogger, ServiceType } from "@elizaos/core";

import {
    ContentPiece,
    Platform,
    PlatformAdapter,
    PlatformAdapterConfig,
    PublishResult,
    ContentStatus,
    AdapterRegistration
} from "../types";
import { validateContentPlanningConfig, validateTwitterConfig } from "../environment";
import { ContentDeliveryOptions, ContentDeliveryService } from "./contentDelivery";
import { ContentApprovalService } from "./contentApproval";
import { ContentAgentMemoryManager } from "../managers/contentMemory";
import { ContentCreationService } from "./contentCreation";
import { DecisionEngine } from "./decisionEngine";
import { EvaluationService } from "./evaluationService";
import { PlanningService } from "./planningService";
import { TwitterAdapter } from "../platforms/twitter/adapter";
import { AdapterProvider } from "./adapterService";
import { NewsService } from "./newsService";

export class ContentManagerService extends Service {
    capabilityDescription = "Provides a platform-specific adapter for content management";
    private runtime: IAgentRuntime;
    private static serviceInstance: ContentManagerService | null = null;
    private adapterRegistry: Map<Platform, AdapterRegistration> = new Map();
    private defaultOptions: ContentDeliveryOptions = {
        retry: true,
        maxRetries: 3,
        validateBeforePublish: true
    };

    static get serviceType(): ServiceType {
        return "content-manager" as ServiceType;
    }

    get serviceType(): ServiceType {
        return ContentManagerService.serviceType;
    }

    getInstance(): ContentManagerService {
        if (ContentManagerService.serviceInstance) {
            return ContentManagerService.serviceInstance;
        }
        ContentManagerService.serviceInstance = new ContentManagerService();
        return ContentManagerService.serviceInstance;
    }

    async initialize(runtime: IAgentRuntime): Promise<void> {
        elizaLogger.debug("[ContentManagerService] Initializing ContentManagerService");
        this.runtime = runtime;

        // Initialize adapters
        const twitterAdapter = new TwitterAdapter();
        await twitterAdapter.initialize(runtime);

        // Initialize configuration
        const TwitterConfig = await validateTwitterConfig(runtime);
        const planningConfig = await validateContentPlanningConfig(runtime);

        // Initialize adapter provider
        const adapterProvider = new AdapterProvider();
        adapterProvider.registerAdapter(twitterAdapter, TwitterConfig);

        // Initialize memory manager
        const contentMemory = new ContentAgentMemoryManager(runtime);
        await contentMemory.initialize();

        // Initialize approval service
        const approvalService = new ContentApprovalService(runtime, []);
        await approvalService.initialize();

        // Initialize the content delivery service
        const contentDeliveryService = new ContentDeliveryService();
        await contentDeliveryService.initialize(runtime, contentMemory, approvalService, adapterProvider);

        //Initialize content creation service
        const contentCreationService = new ContentCreationService(runtime, contentMemory);
        await contentCreationService.initialize(adapterProvider);

        // Initialize decision engine
        const decisionEngine = new DecisionEngine(runtime, contentMemory);

        // Initialize evaluation service
        const evaluationService = new EvaluationService(runtime, contentMemory);

        // Initialize planning service
        const planningService = new PlanningService(runtime, contentMemory);

        // Initialize news service
        const newsService = new NewsService(runtime, contentMemory);
        await newsService.initialize(adapterProvider);
    }
}