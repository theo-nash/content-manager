import type { Tweet } from "agent-twitter-client";
import {
    getEmbeddingZeroVector,
    type IAgentRuntime,
    stringToUuid,
    type UUID,
    truncateToCompleteSentence
} from "@elizaos/core";
import { elizaLogger } from "@elizaos/core";
import type { ClientBase } from "./base.ts";
import { DEFAULT_MAX_TWEET_LENGTH } from "../../environment.ts";
import {
    Client,
    Events,
    GatewayIntentBits,
    TextChannel,
    Partials,
} from "discord.js";
import { MediaData, TweetThreadItem } from "./types.ts";
import { v4 as uuidv4 } from 'uuid';
import type { Memory } from "@elizaos/core";

const MAX_TIMELINES_TO_FETCH = 15;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface PendingTweet {
    tweetTextForPosting: string;
    roomId: UUID;
    rawTweetContent: string;
    taskId: string;
    timestamp: number;
}

type PendingTweetApprovalStatus = "PENDING" | "APPROVED" | "REJECTED";

export class TwitterPostClient {
    client: ClientBase;
    runtime: IAgentRuntime;
    twitterUsername: string;
    isDryRun: boolean;
    private discordClientForApproval: Client;
    approvalRequired = false;
    private discordApprovalChannelId: string;
    private approvalCheckInterval: number;
    approvalProvider: string;

    constructor(client: ClientBase, runtime: IAgentRuntime) {
        elizaLogger.debug("🔍 TwitterPostClient constructor start");
        this.client = client;
        this.runtime = runtime;
        this.twitterUsername = this.client.twitterConfig.TWITTER_USERNAME;
        this.isDryRun = this.client.twitterConfig.TWITTER_DRY_RUN;

        // Log configuration on initialization
        elizaLogger.log("Twitter Client Configuration:");
        elizaLogger.log(`- Username: ${this.twitterUsername}`);
        elizaLogger.log(`- Dry Run Mode: ${this.isDryRun ? "enabled" : "disabled"}`);

        if (this.isDryRun) {
            elizaLogger.log("Twitter client initialized in dry run mode - no actual tweets will be posted");
        }

        elizaLogger.debug(`🔍 TwitterPostClient constructor complete. Final approval provider: "${this.approvalProvider}", approval required: ${this.approvalRequired}`);
    }

    createTweetObject(
        tweetResult: any,
        client: any,
        twitterUsername: string
    ): Tweet {
        return {
            id: tweetResult.rest_id,
            name: client.profile.screenName,
            username: client.profile.username,
            text: tweetResult.legacy.full_text,
            conversationId: tweetResult.legacy.conversation_id_str,
            createdAt: tweetResult.legacy.created_at,
            timestamp: new Date(tweetResult.legacy.created_at).getTime(),
            userId: client.profile.id,
            inReplyToStatusId: tweetResult.legacy.in_reply_to_status_id_str,
            permanentUrl: `https://twitter.com/${twitterUsername}/status/${tweetResult.rest_id}`,
            hashtags: [],
            mentions: [],
            photos: [],
            thread: [],
            urls: [],
            videos: [],
        } as Tweet;
    }

    async processAndCacheTweet(
        runtime: IAgentRuntime,
        client: ClientBase,
        tweet: Tweet,
        roomId: UUID,
        rawTweetContent: string
    ) {
        // Cache the last post details
        await runtime.cacheManager.set(
            `twitter/${client.profile.username}/lastPost`,
            {
                id: tweet.id,
                timestamp: Date.now(),
            }
        );

        // Cache the tweet
        await client.cacheTweet(tweet);

        // Log the posted tweet
        elizaLogger.log(`Tweet posted:\n ${tweet.permanentUrl}`);

        // Ensure the room and participant exist
        await runtime.ensureRoomExists(roomId);
        await runtime.ensureParticipantInRoom(runtime.agentId, roomId);

        // Create a memory for the tweet
        await runtime.messageManager.createMemory({
            id: stringToUuid(tweet.id + "-" + runtime.agentId),
            userId: runtime.agentId,
            agentId: runtime.agentId,
            roomId,
            content: {
                text: rawTweetContent.trim(),
                url: tweet.permanentUrl,
                source: "twitter",
            },
            embedding: getEmbeddingZeroVector(),
            createdAt: tweet.timestamp,
        });
    }

    async handleNoteTweet(
        client: ClientBase,
        content: string,
        tweetId?: string,
        mediaData?: MediaData[]
    ) {
        try {
            const noteTweetResult = await client.requestQueue.add(
                async () =>
                    await client.twitterClient.sendNoteTweet(
                        content,
                        tweetId,
                        mediaData
                    )
            );

            if (noteTweetResult.errors && noteTweetResult.errors.length > 0) {
                // Note Tweet failed due to authorization. Falling back to standard Tweet.
                const truncateContent = truncateToCompleteSentence(
                    content,
                    this.client.twitterConfig.MAX_TWEET_LENGTH
                );
                return await this.sendStandardTweet(
                    client,
                    truncateContent,
                    tweetId
                );
            } else {
                return noteTweetResult.data.notetweet_create.tweet_results
                    .result;
            }
        } catch (error) {
            throw new Error(`Note Tweet failed: ${error}`);
        }
    }

    async sendTweetThread(
        runtime: IAgentRuntime,
        client: ClientBase,
        tweets: TweetThreadItem[],
        roomId: UUID,
        twitterUsername: string,
        delayMs: number = 2000
    ): Promise<Tweet[] | string[]> {
        const tweetResults: Tweet[] = [];
        let previousTweetId: string | null = null;

        elizaLogger.debug(
            `Sending tweet thread with ${tweets.length} tweets`
        );
        if (this.isDryRun) {
            elizaLogger.log(
                `Dry run mode enabled - no tweets will be sent. Tweets:\n`,
                tweets.map((tweet) => tweet.text)
            );
            return [];
        }

        for (const tweet of tweets) {
            try {
                const tweetResult = await this.postTweet(
                    runtime,
                    client,
                    tweet.text,
                    roomId,
                    tweet.text,
                    twitterUsername,
                    tweet.mediaData,
                    previousTweetId);

                if (!tweetResult || !tweetResult.id) {
                    elizaLogger.error(
                        `Error sending tweet: ${tweet.text}`
                    );
                }

                tweetResults.push(tweetResult);
                previousTweetId = tweetResult.id;
                elizaLogger.log(
                    `Tweet sent successfully: ${tweetResult.permanentUrl}`
                );

                await delay(delayMs);

            } catch (error) {
                elizaLogger.error("Error sending Tweet thread:", error);
                throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        return tweetResults;
    }

    async sendStandardTweet(
        client: ClientBase,
        content: string,
        tweetId?: string,
        mediaData?: MediaData[]
    ) {
        try {
            const standardTweetResult = await client.requestQueue.add(
                async () =>
                    await client.twitterClient.sendTweet(
                        content,
                        tweetId,
                        mediaData
                    )
            );
            const body = await standardTweetResult.json();
            if (!body?.data?.create_tweet?.tweet_results?.result) {
                elizaLogger.error("Error sending tweet; Bad response:", body);
                return;
            }
            return body.data.create_tweet.tweet_results.result;
        } catch (error) {
            elizaLogger.error("Error sending standard Tweet:", error);
            throw error;
        }
    }

    async postTweet(
        runtime: IAgentRuntime,
        client: ClientBase,
        tweetTextForPosting: string,
        roomId: UUID,
        rawTweetContent: string,
        twitterUsername: string,
        mediaData?: MediaData[],
        inReplyToTweetId?: string
    ): Promise<Tweet | null> {
        try {
            elizaLogger.log(`Posting new tweet:\n`);

            let result;

            if (tweetTextForPosting.length > DEFAULT_MAX_TWEET_LENGTH) {
                result = await this.handleNoteTweet(
                    client,
                    tweetTextForPosting,
                    inReplyToTweetId,
                    mediaData
                );
            } else {
                result = await this.sendStandardTweet(
                    client,
                    tweetTextForPosting,
                    inReplyToTweetId,
                    mediaData
                );
            }

            const tweet = this.createTweetObject(
                result,
                client,
                twitterUsername
            );

            await this.processAndCacheTweet(
                runtime,
                client,
                tweet,
                roomId,
                rawTweetContent
            );
            return tweet;
        } catch (error) {
            elizaLogger.error("Error sending tweet:", error);
            return null;
        }
    }
}
