import { UUID, Service, IAgentRuntime, elizaLogger, ServiceType } from "@elizaos/core";

import { validateApprovalConfig, validateContentPlanningConfig, validateTwitterConfig } from "../environment";
import { ContentDeliveryService } from "./contentDelivery";
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
    private static serviceInstance: ContentManagerService | null = null;
    private static serviceMap: Map<string, any> = new Map();

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

        // Initialize adapters
        const twitterAdapter = new TwitterAdapter();
        await twitterAdapter.initialize(runtime);

        // Initialize configuration
        const TwitterConfig = await validateTwitterConfig(runtime);
        const planningConfig = await validateContentPlanningConfig(runtime);
        const approvalConfig = await validateApprovalConfig(runtime);

        // Initialize adapter provider
        const adapterProvider = new AdapterProvider();
        adapterProvider.registerAdapter(twitterAdapter, TwitterConfig);

        // Initialize memory manager
        const contentMemory = new ContentAgentMemoryManager(runtime);

        // Initialize approval service
        const approvalService = new ContentApprovalService(runtime, [], approvalConfig);

        // Initialize the content delivery service
        const contentDeliveryService = new ContentDeliveryService(runtime);

        //Initialize content creation service
        const contentCreationService = new ContentCreationService(runtime);

        // Initialize decision engine
        const decisionEngine = new DecisionEngine(runtime);

        // Initialize evaluation service
        const evaluationService = new EvaluationService(runtime, contentMemory);

        // Initialize planning service
        const planningService = new PlanningService(runtime, planningConfig);

        // Initialize news service
        const newsService = new NewsService(runtime);

        // Register services in service map
        ContentManagerService.serviceMap.set("content-delivery", contentDeliveryService);
        ContentManagerService.serviceMap.set("content-creation", contentCreationService);
        ContentManagerService.serviceMap.set("content-approval", approvalService);
        ContentManagerService.serviceMap.set("content-memory", contentMemory);
        ContentManagerService.serviceMap.set("adapter-provider", adapterProvider);
        ContentManagerService.serviceMap.set("decision-engine", decisionEngine);
        ContentManagerService.serviceMap.set("evaluation-service", evaluationService);
        ContentManagerService.serviceMap.set("planning-service", planningService);
        ContentManagerService.serviceMap.set("news-service", newsService);
        ContentManagerService.serviceMap.set("twitter-adapter", twitterAdapter);
        ContentManagerService.serviceMap.set("content-manager", this);
        ContentManagerService.serviceMap.set("adapter-provider", adapterProvider);

        await this.initializeServices(runtime);
        elizaLogger.debug("[ContentManagerService] ContentManagerService initialized");
    }

    async getMicroService<T>(serviceName: string): Promise<T | null> {
        if (ContentManagerService.serviceMap.has(serviceName)) {
            return ContentManagerService.serviceMap.get(serviceName) as T;
        }
        return null;
    }

    async initializeServices(runtime): Promise<void> {
        elizaLogger.debug("[ContentManagerService] Initializing services");

        try {
            const contentMemory = ContentManagerService.serviceMap.get("content-memory") as ContentAgentMemoryManager;
            const adapterProvider = ContentManagerService.serviceMap.get("adapter-provider") as AdapterProvider;
            const contentDeliveryService = ContentManagerService.serviceMap.get("content-delivery") as ContentDeliveryService;
            const contentCreationService = ContentManagerService.serviceMap.get("content-creation") as ContentCreationService;
            const contentApprovalService = ContentManagerService.serviceMap.get("content-approval") as ContentApprovalService;
            const planningService = ContentManagerService.serviceMap.get("planning-service") as PlanningService;
            const newsService = ContentManagerService.serviceMap.get("news-service") as NewsService;
            const evaluationService = ContentManagerService.serviceMap.get("evaluation-service") as EvaluationService;
            const decisionEngine = ContentManagerService.serviceMap.get("decision-engine") as DecisionEngine;

            if (contentMemory) {
                await contentMemory.initialize();
            } else {
                elizaLogger.warn("[ContentManagerService] ContentAgentMemoryManager not available, content features may be limited");
            }

            if (adapterProvider) {
                await adapterProvider.initialize();
            } else {
                elizaLogger.warn("[ContentManagerService] AdapterProvider not available, content features may be limited");
            }

            if (contentDeliveryService) {
                await contentDeliveryService.initialize();
            } else {
                elizaLogger.warn("[ContentManagerService] ContentDeliveryService not available, content features may be limited");
            }

            if (contentCreationService) {
                await contentCreationService.initialize();
            } else {
                elizaLogger.warn("[ContentManagerService] ContentCreationService not available, content features may be limited");
            }

            if (contentApprovalService) {
                await contentApprovalService.initialize();
            } else {
                elizaLogger.warn("[ContentManagerService] ContentApprovalService not available, content features may be limited");
            }

            if (planningService) {
                await planningService.initialize();
            } else {
                elizaLogger.warn("[ContentManagerService] PlanningService not available, content features may be limited");
            }

            if (newsService) {
                await newsService.initialize();
            } else {
                elizaLogger.warn("[ContentManagerService] NewsService not available, content features may be limited");
            }

            if (evaluationService) {
                await evaluationService.initialize();
            } else {
                elizaLogger.warn("[ContentManagerService] EvaluationService not available, content features may be limited");
            }

            if (decisionEngine) {
                await decisionEngine.initialize();
            } else {
                elizaLogger.warn("[ContentManagerService] DecisionEngine not available, content features may be limited");
            }

            elizaLogger.debug("[ContentManagerService] Services initialized");
        } catch (error) {
            elizaLogger.error("[ContentManagerService] Error initializing services:", error.message);
            throw new Error(`Service initialization failed: ${error.message}`);
        }
    }
}