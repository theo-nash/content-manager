// src/services/news-service.ts
import { UUID, IAgentRuntime, elizaLogger } from "@elizaos/core";
import { NewsEvent, TrendingTopic, ProcessingStatus } from "../types";
import { AdapterProvider } from "./adapterService";
import { ContentAgentMemoryManager } from "../managers/contentMemory";

export class NewsService {
    private adapterProvider: AdapterProvider;

    constructor(private runtime: IAgentRuntime, private memoryManager: ContentAgentMemoryManager) { }

    async initialize(adapterProvider?: AdapterProvider) {
        // Initialize the service
        elizaLogger.info("[NewsService] Initializing NewsService");

        this.adapterProvider = adapterProvider;

        // Fetch recent news events
        const recentNews = await this.fetchRecentNews();
        if (recentNews.length > 0) {
            elizaLogger.info("[NewsService] Fetched recent news events:", recentNews);
        }

        // Fetch trending topics
        const trendingTopics = await this.fetchTrendingTopics();
        if (trendingTopics.length > 0) {
            elizaLogger.info("[NewsService] Fetched trending topics:", trendingTopics);
        }

        // Start monitoring for news events
        this.startNewsMonitoring();
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

            elizaLogger.debug("[NewsService] Fetched trending topics:", trendingTopics);

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