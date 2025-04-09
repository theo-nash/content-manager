import {
    IMemoryManager,
    Memory,
    embed,
    UUID,
    IAgentRuntime,
    elizaLogger
} from "@elizaos/core";

import {
    MasterPlan,
    MicroPlan,
    ContentPiece,
    NewsEvent,
    TrendingTopic,
    ContentDecision,
    ProgressEvaluation
} from "../types";

export const TABLE_NAME = "content_memory";

export const ROOM_IDS = {
    MASTER_PLANS: "master-plans-room" as UUID,
    MICRO_PLANS: "micro-plans-room" as UUID,
    CONTENT_PIECES: "content-pieces-room" as UUID,
    NEWS_EVENTS: "news-events-room" as UUID,
    TRENDING_TOPICS: "trending-topics-room" as UUID,
    CONTENT_DECISIONS: "content-decisions-room" as UUID,
    PROGRESS_EVALUATIONS: "progress-evaluations-room" as UUID,
    APPROVALS: "approvals-room" as UUID
};

// Define our custom memory manager class
export class ContentAgentMemoryManager implements IMemoryManager {
    runtime: IAgentRuntime;
    tableName: string;

    constructor(runtime: IAgentRuntime) {
        // Set default table name if not provided
        this.tableName = TABLE_NAME;
        this.runtime = runtime;
    }

    async initialize(): Promise<void> {
        // Initialize the memory manager
        await this.ensureRoomsExist();
        await this.runtime.registerMemoryManager(this);
    }

    // Ensure all required rooms exist
    async ensureRoomsExist(): Promise<void> {
        for (const [_key, roomId] of Object.entries(ROOM_IDS)) {
            await this.runtime.ensureRoomExists(roomId);
        }
    }

    // Required IMemoryManager methods
    async addEmbeddingToMemory(memory: Memory): Promise<Memory> {
        // If the memory has text content, generate an embedding for it
        if (memory.content?.text && !memory.embedding) {
            const embedding = await embed(this.runtime, memory.content.text);
            return { ...memory, embedding };
        }
        return memory;
    }

    async getMemories({
        roomId,
        count = 10,
        unique = false,
        start,
        end
    }: {
        roomId: UUID;
        count?: number;
        unique?: boolean;
        start?: number;
        end?: number;
    }): Promise<Memory[]> {
        return await this.runtime.databaseAdapter.getMemories({
            roomId,
            count,
            unique,
            tableName: this.tableName,
            agentId: this.runtime.agentId,
            start,
            end
        });
    }

    async getCachedEmbeddings(content: string): Promise<{
        embedding: number[];
        levenshtein_score: number;
    }[]> {
        return [];
    }

    async searchMemoriesByEmbedding(embedding: number[], opts: {
        match_threshold?: number;
        count?: number;
        roomId: UUID;
        unique?: boolean;
    }): Promise<Memory[]> {
        return await this.runtime.databaseAdapter.searchMemoriesByEmbedding(embedding, {
            ...opts,
            tableName: this.tableName,
            agentId: this.runtime.agentId
        });
    }

    async createMemory(memory: Memory, unique: boolean = false): Promise<void> {
        const existingMessage =
            await this.getMemoryById(memory.id);

        if (existingMessage) {
            elizaLogger.debug("Memory already exists, skipping");
            return;
        }

        // Add embedding if needed
        const memoryWithEmbedding = await this.addEmbeddingToMemory(memory);

        // Add to cache
        const cacheKey = `content/${memory.id}`;
        await this.runtime.cacheManager.set(cacheKey, memoryWithEmbedding);

        await this.runtime.databaseAdapter.createMemory(
            memoryWithEmbedding,
            this.tableName,
            unique
        );
    }

    async updateMemory(memory: Memory): Promise<void> {
        const existingMemory = await this.getMemoryById(memory.id);
        if (!existingMemory) {
            elizaLogger.error(`Memory with ID ${memory.id} not found.`);
            return;
        }

        await this.runtime.databaseAdapter.removeMemory(
            memory.id,
            this.tableName
        );

        await this.createMemory(memory);
        elizaLogger.debug(`Memory with ID ${memory.id} updated.`);
    }

    async getMemoriesByRoomIds(params: {
        roomIds: UUID[];
        limit?: number;
    }): Promise<Memory[]> {
        // Check cache
        const cacheKey = `content/${params.roomIds.join(",")}/memories/${params.limit}`;
        const cachedMemories = await this.runtime.cacheManager.get<Memory[]>(cacheKey);
        if (cachedMemories) {
            return cachedMemories;
        }

        const _m = await this.runtime.databaseAdapter.getMemoriesByRoomIds({
            ...params,
            tableName: this.tableName,
            agentId: this.runtime.agentId
        });

        await this.runtime.cacheManager.set(cacheKey, _m);
        return _m;
    }

    async getMemoryById(id: UUID): Promise<Memory | null> {
        // Check cache
        const cacheKey = `content/${id}`;
        const cachedMemory = await this.runtime.cacheManager.get<Memory>(cacheKey);

        if (cachedMemory) {
            return cachedMemory;
        }

        const _m = await this.runtime.databaseAdapter.getMemoryById(id);

        await this.runtime.cacheManager.set(cacheKey, _m);
        return _m;
    }

    async removeMemory(memoryId: UUID): Promise<void> {
        await this.runtime.databaseAdapter.removeMemory(memoryId, this.tableName);
    }

    async removeAllMemories(roomId: UUID): Promise<void> {
        await this.runtime.databaseAdapter.removeAllMemories(roomId, this.tableName);
    }

    async countMemories(roomId: UUID, unique?: boolean): Promise<number> {
        return await this.runtime.databaseAdapter.countMemories(roomId, unique, this.tableName);
    }

    // Generic function to create an entity
    async createEntity<T>(
        entity: T,
        roomId: UUID,
        id?: UUID
    ): Promise<UUID> {
        const memory: Memory = {
            id: id || crypto.randomUUID(),
            userId: this.runtime.agentId,
            agentId: this.runtime.agentId,
            roomId,
            content: {
                text: JSON.stringify(entity)
            }
        };

        await this.createMemory(memory);
        return memory.id as UUID;
    }

    // Generic function to get an entity by ID
    async getEntityById<T>(id: UUID): Promise<T | null> {
        try {
            const memory = await this.getMemoryById(id);
            if (!memory) return null;

            // Parse the content and return
            if (!memory.content?.text) {
                elizaLogger.error(`Memory content is empty for ID: ${id}`);
                return null;
            }

            // Parse the content and return
            return JSON.parse(memory.content.text || "{}") as T;
        } catch (error) {
            elizaLogger.error(`Error getting entity:`, error);
            return null;
        }
    }

    // Generic function to get entities by room ID
    async getEntitiesByRoom<T>(
        roomId: UUID,
        count: number = 10
    ): Promise<T[]> {
        try {
            const memories = await this.getMemories({
                roomId,
                count
            });

            return memories
                .map(memory => {
                    try {
                        return JSON.parse(memory.content.text || "{}") as T;
                    } catch {
                        return null;
                    }
                })
                .filter(Boolean) as T[];
        } catch (error) {
            elizaLogger.error(`Error getting entities:`, error);
            return [];
        }
    }

    // Master Plan operations
    async createMasterPlan(masterPlan: MasterPlan): Promise<UUID> {
        return await this.createEntity(
            masterPlan,
            ROOM_IDS.MASTER_PLANS,
            masterPlan.id
        );
    }

    async getMasterPlanById(id: UUID): Promise<MasterPlan | null> {
        return await this.getEntityById<MasterPlan>(id);
    }

    async getMasterPlans(count: number = 10): Promise<MasterPlan[]> {
        return await this.getEntitiesByRoom<MasterPlan>(
            ROOM_IDS.MASTER_PLANS,
            count
        );
    }

    // Micro Plan operations
    async createMicroPlan(microPlan: MicroPlan): Promise<UUID> {
        return await this.createEntity(
            microPlan,
            ROOM_IDS.MICRO_PLANS,
            microPlan.id
        );
    }

    async getMicroPlanById(id: UUID): Promise<MicroPlan | null> {
        return await this.getEntityById<MicroPlan>(id);
    }

    async getMicroPlansForMasterPlan(
        masterPlanId: UUID,
        count: number = 10
    ): Promise<MicroPlan[]> {
        const allPlans = await this.getEntitiesByRoom<MicroPlan>(
            ROOM_IDS.MICRO_PLANS,
            count
        );

        return allPlans.filter(plan => plan.masterPlanId === masterPlanId);
    }

    // Content operations
    async createContentPiece(contentPiece: ContentPiece): Promise<UUID> {
        return await this.createEntity(
            contentPiece,
            ROOM_IDS.CONTENT_PIECES,
            contentPiece.id
        );
    }

    async getContentPieceById(id: UUID): Promise<ContentPiece | null> {
        return await this.getEntityById<ContentPiece>(id);
    }

    async getContentPiecesForMicroPlan(
        microPlanId: UUID,
        count: number = 100
    ): Promise<ContentPiece[]> {
        const microPlan = await this.getMicroPlanById(microPlanId);

        if (!microPlan) {
            elizaLogger.error(`MicroPlan with ID ${microPlanId} not found.`);
            return [];
        }

        const microPlanPieceIds = microPlan?.contentPieces.map(piece => piece.id) || [];

        const piecePromises = microPlanPieceIds.map(async pieceId => {
            const piece = await this.getContentPieceById(pieceId);
            if (!piece) {
                elizaLogger.error(`ContentPiece with ID ${pieceId} not found.`);
                return null;
            }
            return piece;
        });

        const pieces = await Promise.all(piecePromises);
        const filteredPieces = pieces.filter(piece => piece !== null) as ContentPiece[];

        if (filteredPieces.length > 0) {
            return filteredPieces;
        }
        elizaLogger.error(`No ContentPieces found for MicroPlan with ID ${microPlanId}.`);
        return [];
    }

    // News and trends operations
    async createNewsEvent(newsEvent: NewsEvent): Promise<UUID> {
        return await this.createEntity(
            newsEvent,
            ROOM_IDS.NEWS_EVENTS,
            newsEvent.id
        );
    }

    async createTrendingTopic(trendingTopic: TrendingTopic): Promise<UUID> {
        return await this.createEntity(
            trendingTopic,
            ROOM_IDS.TRENDING_TOPICS,
            trendingTopic.id
        );
    }

    async getRecentNewsEvents(count: number = 10): Promise<NewsEvent[]> {
        return await this.getEntitiesByRoom<NewsEvent>(
            ROOM_IDS.NEWS_EVENTS,
            count
        );
    }

    async getRecentTrendingTopics(count: number = 10): Promise<TrendingTopic[]> {
        return await this.getEntitiesByRoom<TrendingTopic>(
            ROOM_IDS.TRENDING_TOPICS,
            count
        );
    }

    // Decision engine operations
    async createContentDecision(decision: ContentDecision): Promise<UUID> {
        return await this.createEntity(
            decision,
            ROOM_IDS.CONTENT_DECISIONS,
            decision.id
        );
    }

    async createProgressEvaluation(evaluation: ProgressEvaluation): Promise<UUID> {
        return await this.createEntity(
            evaluation,
            ROOM_IDS.PROGRESS_EVALUATIONS,
            evaluation.id
        );
    }

    async getRecentContentDecisions(count: number = 10): Promise<ContentDecision[]> {
        return await this.getEntitiesByRoom<ContentDecision>(
            ROOM_IDS.CONTENT_DECISIONS,
            count
        );
    }

    async getRecentProgressEvaluations(count: number = 10): Promise<ProgressEvaluation[]> {
        return await this.getEntitiesByRoom<ProgressEvaluation>(
            ROOM_IDS.PROGRESS_EVALUATIONS,
            count
        );
    }

    async getRecentContentPieces(count: number = 10): Promise<ContentPiece[]> {
        return await this.getEntitiesByRoom<ContentPiece>(
            ROOM_IDS.CONTENT_PIECES,
            count
        );
    }
}
