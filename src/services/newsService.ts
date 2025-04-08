// src/services/news-service.ts
import { UUID, IAgentRuntime, Service } from "@elizaos/core";
import { NewsEvent, TrendingTopic, ProcessingStatus } from "../types";
import * as db from "../database";

export class NewsService {
    constructor(private runtime: IAgentRuntime) { }

    async fetchRecentNews(): Promise<NewsEvent[]> {
        try {
            // Try to get web search service if available
            const webSearchService = this.runtime.getService("web_search");

            if (webSearchService) {
                // Use web search service to fetch news
                return await this.fetchNewsViaWebSearch();
            } else {
                // Fall back to Twitter API for trends
                return await this.fetchNewsViaTwitter();
            }
        } catch (error) {
            console.error("Error fetching news:", error);
            return [];
        }
    }

    async fetchTrendingTopics(): Promise<TrendingTopic[]> {
        try {
            // Try to get Twitter service if available
            const twitterService = this.runtime.getService("twitter");

            if (twitterService) {
                // Use Twitter service to fetch trends
                return await this.fetchTrendsViaTwitter();
            } else {
                // Fall back to placeholder trends
                return this.createPlaceholderTrends();
            }
        } catch (error) {
            console.error("Error fetching trending topics:", error);
            return [];
        }
    }

    private async fetchNewsViaWebSearch(): Promise<NewsEvent[]> {
        // Example search query
        const searchQuery = "latest news events today";

        try {
            // Use the web_search tool to fetch news
            const searchResult = await this.runtime.useModel("web_search", {
                query: searchQuery
            });

            // Extract relevant news information
            const newsEvents: NewsEvent[] = [];

            if (Array.isArray(searchResult)) {
                for (const result of searchResult.slice(0, 5)) {
                    const newsEvent: NewsEvent = {
                        id: crypto.randomUUID() as UUID,
                        headline: result.title || "Untitled news",
                        source: result.source || "Unknown source",
                        publishDate: new Date(),
                        summary: result.snippet || "No summary available",
                        relevanceScore: 0.8, // Default relevance score
                        keywords: [], // Extract keywords from title/description
                        category: "General",
                        url: result.url || "",
                        processingStatus: ProcessingStatus.NEW,
                        created: new Date()
                    };

                    newsEvents.push(newsEvent);

                    // Store in database
                    await db.createNewsEvent(this.runtime, newsEvent);
                }
            }

            return newsEvents;
        } catch (error) {
            console.error("Error fetching news via web search:", error);
            return [];
        }
    }

    private async fetchNewsViaTwitter(): Promise<NewsEvent[]> {
        // TODO: Implement actual Twitter API integration
        // For now, return placeholder news
        return this.createPlaceholderNews();
    }

    private async fetchTrendsViaTwitter(): Promise<TrendingTopic[]> {
        // TODO: Implement actual Twitter API integration
        // For now, return placeholder trends
        return this.createPlaceholderTrends();
    }

    private createPlaceholderNews(): NewsEvent[] {
        const categories = ["Technology", "Business", "Politics", "Entertainment", "Health"];
        const sources = ["TechCrunch", "Wall Street Journal", "CNN", "BBC", "The Verge"];

        return Array(5).fill(0).map((_, index) => {
            const now = new Date();
            const category = categories[index % categories.length];
            const source = sources[index % sources.length];

            return {
                id: crypto.randomUUID() as UUID,
                headline: `Sample ${category} News Headline ${index + 1}`,
                source,
                publishDate: now,
                summary: `This is a sample news summary for ${category} news item ${index + 1}.`,
                relevanceScore: 0.7 + (Math.random() * 0.3), // Random score between 0.7 and 1.0
                keywords: [category.toLowerCase(), `keyword${index + 1}`],
                category,
                url: "https://example.com/news",
                processingStatus: ProcessingStatus.NEW,
                created: now
            };
        });
    }

    private createPlaceholderTrends(): TrendingTopic[] {
        const trendNames = [
            "#TechInnovation",
            "#SustainableFuture",
            "#RemoteWork",
            "#DigitalTransformation",
            "#AIEthics"
        ];

        return trendNames.map((name, index) => {
            const now = new Date();

            return {
                id: crypto.randomUUID() as UUID,
                name,
                platform: "twitter",
                discoveryDate: now,
                volume: 1000 + (index * 500), // Random volume
                growthRate: 0.05 + (Math.random() * 0.2), // Random growth rate between 5% and 25%
                relevanceScore: 0.6 + (Math.random() * 0.4), // Random score between 0.6 and 1.0
                relatedKeywords: [name.replace("#", "").toLowerCase(), `related${index + 1}`],
                processingStatus: ProcessingStatus.NEW,
                created: now
            };
        });
    }
}