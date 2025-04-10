import { IAgentRuntime, Media, cleanJsonResponse, stringToUuid, elizaLogger, extractAttributes, parseJSONObjectFromText, truncateToCompleteSentence } from "@elizaos/core";
import { ContentPiece, ContentValidationResult, FormattedContent, PerformanceMetrics, Platform, PlatformAdapter, PlatformAdapterConfig, ProcessingStatus, PublishResult, TrendingTopic } from "../../types";
import { validateTwitterConfig } from "../../environment";
import { ClientBase, TwitterProfile } from "./base";
import { TwitterPostClient } from "./post";
import { MediaData } from "./types";
import path from "path";
import fs from "fs";

export class TwitterAdapter implements PlatformAdapter {
    platformId = "twitter";
    platform = Platform.TWITTER;
    capabilities = ["formatContent", "publishContent", "getPerformanceMetrics"];
    contentFormats: string[] = ["tweet", "thread"];

    private postClient: TwitterPostClient | undefined;
    private runtime: IAgentRuntime;

    async configure(config: PlatformAdapterConfig): Promise<void> {
        // Implement Twitter-specific configuration logic
        elizaLogger.log("[TwitterAdapter] Configuring Twitter adapter with:", config);
    }

    async initialize(runtime: IAgentRuntime): Promise<void> {
        // Implement Twitter-specific initialization logic
        elizaLogger.log("[TwitterAdapter] Initializing Twitter adapter");

        this.runtime = runtime;

        const config = await validateTwitterConfig(runtime);
        const client = new ClientBase(runtime, config);
        await client.init();
        elizaLogger.log("[TwitterAdapter] Twitter client initialized");

        // Initialize posting client
        this.postClient = new TwitterPostClient(client, runtime);

        elizaLogger.log("[TwitterAdapter] Twitter post client started");
    }

    async validateContent(content: ContentPiece): Promise<ContentValidationResult> {
        if (!content.generatedContent) {
            return { isValid: false, errors: ["Content is empty"] };
        }

        return { isValid: true };
    }

    async formatContent(content: ContentPiece): Promise<FormattedContent> {
        const rawTweetContent = cleanJsonResponse(content.generatedContent);
        const maxTweetLength = this.postClient.client.twitterConfig.MAX_TWEET_LENGTH;
        let tweetTextForPosting = null;
        let mediaData = null;

        // Try parsing as JSON first
        const parsedResponse = parseJSONObjectFromText(rawTweetContent);
        if (parsedResponse?.text) {
            tweetTextForPosting = parsedResponse.text;
        } else {
            // If not JSON, use the raw text directly
            tweetTextForPosting = rawTweetContent.trim();
        }

        if (
            parsedResponse?.attachments &&
            parsedResponse?.attachments.length > 0
        ) {
            mediaData = await fetchMediaData(parsedResponse.attachments);
        }

        // Try extracting text attribute
        if (!tweetTextForPosting) {
            const parsingText = extractAttributes(rawTweetContent, [
                "text",
            ]).text;
            if (parsingText) {
                tweetTextForPosting = truncateToCompleteSentence(
                    extractAttributes(rawTweetContent, ["text"]).text,
                    maxTweetLength
                );
            }
        }

        // Use the raw text
        if (!tweetTextForPosting) {
            tweetTextForPosting = rawTweetContent;
        }

        // Truncate the content to the maximum tweet length specified in the environment settings, ensuring the truncation respects sentence boundaries.
        if (maxTweetLength) {
            tweetTextForPosting = truncateToCompleteSentence(
                tweetTextForPosting,
                maxTweetLength
            );
        }

        const removeQuotes = (str: string) =>
            str.replace(/^['"](.*)['"]$/, "$1");

        const fixNewLines = (str: string) => str.replaceAll(/\\n/g, "\n\n"); //ensures double spaces

        // Final cleaning
        tweetTextForPosting = removeQuotes(
            fixNewLines(tweetTextForPosting)
        );

        const formattedContent = { ...content, formattedContent: { tweetTextForPosting: tweetTextForPosting, mediaData: mediaData, rawTweetContent: rawTweetContent } };
        return formattedContent;
    }

    async publishContent(content: FormattedContent): Promise<PublishResult> {
        if (this.postClient.isDryRun) {
            elizaLogger.info(
                `[TwitterAdapter]: Dry run mode enabled. Skipping content publishing.`)
            elizaLogger.info(
                `[TwitterAdapter]: Content to be published: ${content.formattedContent.tweetTextForPosting}`);

            return {
                success: true,
                publishedUrl: null,
                timestamp: new Date(),
            }
        }

        const roomId = stringToUuid(
            `twitter_generate_room-${this.postClient.client.profile.username}`
        )

        elizaLogger.log("[TwitterAdapter] Publishing content to Twitter:", content.formattedContent.tweetTextForPosting);

        const publishResult = await this.postClient.postTweet(
            this.runtime,
            this.postClient.client,
            content.formattedContent.tweetTextForPosting,
            roomId,
            content.formattedContent.rawTweetContent,
            this.postClient.twitterUsername,
            content.formattedContent.mediaData
        );

        return {
            success: publishResult !== null,
            publishedUrl: publishResult?.permanentUrl || null,
            timestamp: new Date(publishResult.timestamp) || new Date(),
            platformId: publishResult?.id || null
        };
    }

    async getPerformanceMetrics(contentId: string): Promise<PerformanceMetrics> {
        // Implement Twitter-specific performance metrics retrieval logic
        return { impressions: 1000, engagements: 100 };
    }

    async getTrends(opts?: { contentId?: string; filter?: string; }): Promise<TrendingTopic[]> {
        const trends = await this.postClient.client.twitterClient.getTrends();
        if (trends) {
            return trends.map((trend: string) => ({
                id: stringToUuid(`${trend}-twitter`),
                name: trend,
                platform: Platform.TWITTER,
                discoveryDate: new Date(),
                processingStatus: ProcessingStatus.NEW
            })
            );
        }
        elizaLogger.error("[TwitterAdapter] Failed to fetch trends from Twitter");
        return [];
    }

    async checkConnection(): Promise<boolean> {
        let loggedIn: boolean = false;

        // Simple profile fetch
        try {
            loggedIn = await this.postClient.client.twitterClient.isLoggedIn();
        }
        catch (error) {
            elizaLogger.error("[TwitterAdapter] Error checking twitter status:", error);
            return false;
        }

        return loggedIn;
    }

    async getFormattingInstructions(): Promise<string> {
        // Implement Twitter-specific formatting instructions retrieval logic
        return "Twitter formatting instructions";
    }
}

export async function fetchMediaData(
    attachments: Media[]
): Promise<MediaData[]> {
    return Promise.all(
        attachments.map(async (attachment: Media) => {
            if (/^(http|https):\/\//.test(attachment.url)) {
                // Handle HTTP URLs
                const response = await fetch(attachment.url);
                if (!response.ok) {
                    throw new Error(`[TwitterAdapter] Failed to fetch file: ${attachment.url}`);
                }
                const mediaBuffer = Buffer.from(await response.arrayBuffer());
                const mediaType = attachment.contentType;
                return { data: mediaBuffer, mediaType };
            } else if (fs.existsSync(attachment.url)) {
                // Handle local file paths
                const mediaBuffer = await fs.promises.readFile(
                    path.resolve(attachment.url)
                );
                const mediaType = attachment.contentType;
                return { data: mediaBuffer, mediaType };
            } else {
                throw new Error(
                    `File not found: ${attachment.url}. Make sure the path is correct.`
                );
            }
        })
    );
}