// src/services/news-service.ts
import { UUID, IAgentRuntime, elizaLogger } from "@elizaos/core";
import { NewsEvent, TrendingTopic, ProcessingStatus } from "../types";
import { AdapterProvider } from "./adapterService";
import { ContentAgentMemoryManager } from "../managers/contentMemory";
import { ContentManagerService } from "./contentManager";

export class NewsService {
    private adapterProvider: AdapterProvider;
    private isInitialized: boolean = false;
    private memoryManager: ContentAgentMemoryManager | null = null;
    private contentManager: ContentManagerService | null = null;

    constructor(private runtime: IAgentRuntime) { }

    async initialize() {
        if (this.isInitialized) {
            elizaLogger.debug("[NewsService] NewsService is already initialized");
            return;
        }

        // Initialize the service
        elizaLogger.info("[NewsService] Initializing NewsService");

        // Initialize required services
        await this.initializeServices();

        // Fetch recent news events
        const recentNews = await this.fetchRecentNews();
        if (recentNews.length > 0) {
            elizaLogger.info("[NewsService] Fetched recent news events:", recentNews);
        }

        // Fetch trending topics
        await this.fetchTrendingTopics();

        // Start monitoring for news events
        this.startNewsMonitoring();
        this.isInitialized = true;
    }

    private async initializeServices(): Promise<void> {
        try {
            this.contentManager = await this.runtime.getService<ContentManagerService>(ContentManagerService.serviceType);
            if (!this.contentManager) {
                throw new Error("[NewsService] ContentManagerService not available");
            }

            // Get delivery service
            this.memoryManager = await this.contentManager.getMicroService<ContentAgentMemoryManager>("content-memory");

            if (!this.memoryManager) {
                elizaLogger.warn("[NewsService] MemoryManagerService not available, content features will be limited");
                return;
            }

            this.adapterProvider = await this.contentManager.getMicroService<AdapterProvider>("adapter-provider");

            if (!this.adapterProvider) {
                elizaLogger.warn("[NewsService] AdapterProvider not available, content features will be limited");
                return;
            }

            elizaLogger.debug("[NewsService] AdapterProvider initialized successfully");

        } catch (error) {
            elizaLogger.error("[NewsService] Error initializing services:", error);
            throw new Error(`Service initialization failed: ${error.message}`);
        }
    }

    async fetchRecentNews(): Promise<NewsEvent[]> {
        return [];
    }

    async fetchTrendingTopics(): Promise<TrendingTopic[]> {
        try {
            elizaLogger.debug("[NewsService] Fetching trending topics");

            let trendingTopics: TrendingTopic[] = [];

            for (const adapter of this.adapterProvider.getAllAdapters()) {
                try {
                    const trends = await adapter.getTrends();
                    if (trends) {
                        trendingTopics = [...trendingTopics, ...trends];
                    }
                } catch (error) {
                    elizaLogger.error("[NewsService] Error fetching trends from adapter:", error);
                }
            }

            // Save trends as memories
            await Promise.all(
                trendingTopics.map(trend =>
                    this.memoryManager.createTrendingTopic(trend)
                )
            );

            elizaLogger.debug("[NewsService] Fetched trending topics:", trendingTopics.map(t => t.name).join(", "));

            return trendingTopics;
        } catch (error) {
            elizaLogger.error("[NewsService] Error fetching trending topics:", error);
            return [];
        }
    }

    private startNewsMonitoring(): void {
        // Start monitoring for news events
        elizaLogger.log("[NewsService] Starting news monitoring");

        setInterval(async () => {
            try {
                elizaLogger.debug("[NewsService] Fetching recent news events");
                await this.fetchRecentNews();
                await this.fetchTrendingTopics();
            } catch (error) {
                elizaLogger.error("[NewsService] Error fetching news events:", error);
            }
        }, 15 * 60 * 1000); // Check every 15 minutes
    }

}