import { UUID, IAgentRuntime, elizaLogger, ServiceType, stringToUuid } from "@elizaos/core";
import {
    ContentPiece,
    Platform,
    PlatformAdapter,
    PlatformAdapterConfig,
    PublishResult,
    ContentStatus,
    AdapterRegistration,
    ApprovalStatus,
    ApprovalRequest
} from "../types";
import { ContentApprovalService } from "./contentApproval";
import { ContentAgentMemoryManager } from "../managers/contentMemory";

export interface ContentDeliveryOptions {
    retry?: boolean;
    maxRetries?: number;
    validateBeforePublish?: boolean;
    formatOptions?: Record<string, any>;
    scheduledTime?: Date;
    skipApproval?: boolean;
}

export interface ContentDeliveryResult extends PublishResult {
    contentId: UUID;
    platform: Platform;
    attempts?: number;
    validationErrors?: string[];
}

interface ScheduledCacheEntry {
    contentPiece: ContentPiece;
    options: ContentDeliveryOptions;
    createdAt: Date;
}

export class ContentDeliveryService {
    capabilityDescription = "Provides a platform-specific adapter for content management";
    private approvalService: ContentApprovalService | undefined;
    private scheduledDeliveries: Map<string, NodeJS.Timeout> = new Map();
    private runtime: IAgentRuntime;
    private adapterRegistry: Map<Platform, AdapterRegistration> = new Map();
    private memoryManager: ContentAgentMemoryManager;

    static get serviceType(): ServiceType {
        return "content-delivery" as ServiceType;
    }

    get serviceType(): ServiceType {
        return ContentDeliveryService.serviceType;
    }

    private defaultOptions: ContentDeliveryOptions = {
        retry: true,
        maxRetries: 3,
        validateBeforePublish: true,
        skipApproval: false,
    };

    async initialize(runtime: IAgentRuntime, memoryManager: ContentAgentMemoryManager, approvalService?: ContentApprovalService, adapters?: PlatformAdapter[]): Promise<void> {
        elizaLogger.debug("[ContentDeliveryService] Initializing ContentDeliveryService");
        this.runtime = runtime;
        this.memoryManager = memoryManager;

        for (const adapter of adapters || []) {
            await this.registerAdapter(adapter);
        }

        this.approvalService = approvalService;

        // Check platform connections
        const statuses = await this.checkPlatformConnections();
        for (const [platform, status] of Object.entries(statuses)) {
            if (status) {
                elizaLogger.debug(`[ContentDeliveryService] Connection to ${platform} is healthy`);
            } else {
                elizaLogger.error(`[ContentDeliveryService] Connection to ${platform} is unhealthy`);
            }
        }

        // Initialize content approval service
        this.approvalService = new ContentApprovalService(this.runtime, []);

        // Load any scheduled deliveries from cache
        await this.loadScheduledDeliveries();

        // Start the delivery monitor
        this.startDeliveryMonitor();
    }

    /**
     * Register a platform adapter
     */
    registerAdapter(adapter: PlatformAdapter, config?: PlatformAdapterConfig): void {
        elizaLogger.debug(`[ContentDeliveryService] Registering adapter for platform: ${adapter.platform}`);

        if (config) {
            adapter.configure(config);
        }

        this.adapterRegistry.set(adapter.platform, {
            adapter,
            platform: adapter.platform,
            enabled: true
        });
    }

    /**
     * Unregister a platform adapter
     */
    unregisterAdapter(platform: Platform): boolean {
        return this.adapterRegistry.delete(platform);
    }

    /**
     * Enable or disable a specific adapter
     */
    setAdapterEnabled(platform: Platform, enabled: boolean): boolean {
        const registration = this.adapterRegistry.get(platform);
        if (registration) {
            registration.enabled = enabled;
            return true;
        }
        return false;
    }

    /**
     * Get registered adapter for a specific platform
     */
    getAdapter(platform: Platform): PlatformAdapter | undefined {
        const registration = this.adapterRegistry.get(platform);
        return registration?.enabled ? registration.adapter : undefined;
    }

    /**
     * Posts content to the appropriate platform
     */
    async postContent(
        contentPiece: ContentPiece,
        options: ContentDeliveryOptions = {}
    ): Promise<ContentDeliveryResult> {
        // Ensure piece hasn't been posted already
        const contentMemory = this.memoryManager.getContentPieceById(contentPiece.id);

        if (contentPiece.status === ContentStatus.PUBLISHED || contentMemory) {
            elizaLogger.warn(`[ContentDeliveryService] Content already published: ${contentPiece.id}`);
            return {
                contentId: contentPiece.id,
                platform: contentPiece.platform,
                success: false,
                timestamp: new Date(),
                error: "Content already published"
            };
        }

        const mergedOptions = { ...this.defaultOptions, ...options };
        const registration = this.adapterRegistry.get(contentPiece.platform);

        elizaLogger.debug(`[ContentDeliveryService] Posting content: ${contentPiece.id} to ${contentPiece.platform}`);

        if (!registration || !registration.enabled) {
            elizaLogger.error(`[ContentDeliveryService] No enabled adapter for platform: ${contentPiece.platform}`);

            return {
                contentId: contentPiece.id,
                platform: contentPiece.platform,
                success: false,
                timestamp: new Date(),
                error: `No enabled adapter registered for platform: ${contentPiece.platform}`
            };
        }

        const adapter = registration.adapter;
        let validationErrors: string[] = [];

        try {
            // Check if this should be scheduled for later
            if (mergedOptions.scheduledTime && mergedOptions.scheduledTime > new Date()) {
                return await this.scheduleContentDelivery(contentPiece, mergedOptions);
            }


            // Validate content if option is enabled
            if (mergedOptions.validateBeforePublish) {
                const validationResult = await adapter.validateContent(contentPiece);
                if (!validationResult.isValid) {
                    validationErrors = validationResult.errors || [];
                    elizaLogger.error(`[ContentDeliveryService] Content validation failed: ${validationErrors.join(", ")}`);
                    return {
                        contentId: contentPiece.id,
                        platform: contentPiece.platform,
                        success: false,
                        timestamp: new Date(),
                        error: `Content validation failed: ${validationErrors.join(", ")}`,
                        validationErrors
                    };
                }
            }

            // Format content for the platform
            elizaLogger.debug(`[ContentDeliveryService] Formatting content: ${contentPiece.id}`);
            const formattedContent = await adapter.formatContent(contentPiece);

            // Get approval if required and not skipped
            if (this.approvalService && !mergedOptions.skipApproval) {
                elizaLogger.debug(`[ContentDeliveryService] Sending content for approval: ${contentPiece.id}`);

                await this.approvalService.sendForApproval(formattedContent, this.publishContent)

                return {
                    contentId: contentPiece.id,
                    platform: contentPiece.platform,
                    success: true,
                    timestamp: new Date(),
                    publishedUrl: null,
                    publishedId: null,
                    error: "Content sent for approval"
                };

            } else {
                const approvalResult: ApprovalRequest = {
                    id: stringToUuid(`${contentPiece.id}-approval`),
                    content: formattedContent,
                    platform: contentPiece.platform,
                    requesterId: this.runtime.agentId,
                    timestamp: new Date(),
                    status: ApprovalStatus.APPROVED,
                    comments: "Content approved automatically",
                    callback: this.publishContent
                }
                return await this.publishContent(approvalResult);
            }
        } catch (error) {
            return null
        }
    }

    async publishContent(approvalResult: ApprovalRequest): Promise<ContentDeliveryResult> {
        const contentPiece = approvalResult.content;
        let attempts = 0;

        elizaLogger.debug(`[ContentDeliveryService] Publishing approved content: ${approvalResult.id}`);

        // Verify content is approved
        if (approvalResult.status !== ApprovalStatus.APPROVED) {
            elizaLogger.error(`[ContentDeliveryService] Content not approved for publishing: ${approvalResult.id}`);
            return {
                contentId: contentPiece.id,
                platform: contentPiece.platform,
                success: false,
                timestamp: new Date(),
                error: `Content not approved for publishing`,
                attempts
            };
        }

        try {
            const registration = this.adapterRegistry.get(approvalResult.content.platform);
            if (!registration || !registration.enabled) {
                throw new Error(`No enabled adapter for platform: ${contentPiece.platform}`);
            }

            const adapter = registration.adapter;

            // Publish with retry logic if enabled
            let publishResult: PublishResult = { success: false, timestamp: new Date() };
            let lastError: any;

            do {
                attempts++;
                try {
                    elizaLogger.debug(`[ContentDeliveryService] Publishing attempt ${attempts}: ${contentPiece.id}`);
                    publishResult = await adapter.publishContent(contentPiece.formattedContent);

                    if (publishResult.success) {
                        // Update content status if published successfully
                        contentPiece.status = ContentStatus.PUBLISHED;

                        // Store the updated content piece
                        this.memoryManager.createContentPiece(contentPiece);

                        return {
                            ...publishResult,
                            contentId: contentPiece.id,
                            platform: contentPiece.platform,
                            attempts
                        };
                    }

                    lastError = publishResult.error;
                } catch (error) {
                    lastError = error instanceof Error ? error.message : String(error);
                }
            } while (this.defaultOptions.retry && attempts < (this.defaultOptions.maxRetries || 1) && !publishResult?.success);

            return {
                contentId: contentPiece.id,
                platform: contentPiece.platform,
                success: false,
                timestamp: new Date(),
                error: `Failed to publish after ${attempts} attempts: ${lastError}`,
                attempts
            };

        } catch (error) {
            elizaLogger.error(`[ContentDeliveryService] Error in publish workflow: ${error}`);
            return {
                contentId: contentPiece.id,
                platform: contentPiece.platform,
                success: false,
                timestamp: new Date(),
                error: `Error: ${error instanceof Error ? error.message : String(error)}`,
                attempts
            };
        }
    }

    /**
     * Schedule content for delivery at a later time
     */
    private async scheduleContentDelivery(
        contentPiece: ContentPiece,
        options: ContentDeliveryOptions
    ): Promise<ContentDeliveryResult> {
        if (!options.scheduledTime) {
            throw new Error("Scheduled time is required for scheduling content delivery");
        }

        const scheduledTime = options.scheduledTime;
        const now = new Date();
        const delay = scheduledTime.getTime() - now.getTime();

        if (delay <= 0) {
            elizaLogger.warn(`[ContentDeliveryService] Scheduled time is in the past, posting immediately: ${contentPiece.id}`);
            return this.postContent(contentPiece, { ...options, scheduledTime: undefined });
        }

        // Create a unique ID for this scheduled delivery
        const scheduledId = `${contentPiece.id}-${scheduledTime.getTime()}`;

        elizaLogger.log(`[ContentDeliveryService] Scheduling content for delivery at ${scheduledTime.toISOString()}: ${contentPiece.id}`);

        // Store in cache for persistence across restarts
        const cacheKey = `contentDelivery/scheduled/${scheduledId}`;
        await this.runtime.cacheManager.set(
            cacheKey,
            {
                contentPiece,
                options: { ...options, scheduledTime: scheduledTime.toISOString() },
                createdAt: now.toISOString()
            },
            { expires: scheduledTime.getTime() + (24 * 60 * 60 * 1000) } // 24 hour grace period
        );

        // Add to cacheKey list
        const cacheKeys = await this.runtime.cacheManager.get<string[]>("contentDelivery/scheduledKeys") || [];
        if (!cacheKeys.includes(cacheKey)) {
            cacheKeys.push(cacheKey);

            // Get latest scheduled delivery
            let latest = new Date();
            for (const key of cacheKeys) {
                const scheduledDelivery = await this.runtime.cacheManager.get<ScheduledCacheEntry>(key);
                if (scheduledDelivery && new Date(scheduledDelivery.options.scheduledTime) > latest) {
                    latest = new Date(scheduledDelivery.options.scheduledTime);
                }
            }
            await this.runtime.cacheManager.set("contentDelivery/scheduledKeys", cacheKeys, { expires: latest.getTime() + (24 * 60 * 60 * 1000) });
        }

        // Set up the timeout for delivery
        const timeout = setTimeout(async () => {
            elizaLogger.log(`[ContentDeliveryService] Executing scheduled delivery: ${contentPiece.id}`);
            try {
                // Remove scheduled time to trigger immediate delivery
                const deliveryOptions = { ...options, scheduledTime: undefined };
                await this.postContent(contentPiece, deliveryOptions);

                // Clean up cache
                await this.runtime.cacheManager.delete(cacheKey);
                this.scheduledDeliveries.delete(scheduledId);
            } catch (error) {
                elizaLogger.error(`[ContentDeliveryService] Error executing scheduled delivery: ${error}`);
            }
        }, delay);

        // Store the timeout reference
        this.scheduledDeliveries.set(scheduledId, timeout);

        return {
            contentId: contentPiece.id,
            platform: contentPiece.platform,
            success: true,
            timestamp: now,
            publishedUrl: null,
            publishedId: null,
            error: `Content scheduled for delivery at ${scheduledTime.toISOString()}`
        };
    }

    /**
    * Cancel a scheduled content delivery
    */
    async cancelScheduledDelivery(scheduledId: string): Promise<boolean> {
        if (this.scheduledDeliveries.has(scheduledId)) {
            // Clear the timeout
            clearTimeout(this.scheduledDeliveries.get(scheduledId));
            this.scheduledDeliveries.delete(scheduledId);

            // Remove from cache
            await this.runtime.cacheManager.delete(`contentDelivery/scheduled/${scheduledId}`);
            elizaLogger.log(`[ContentDeliveryService] Scheduled delivery cancelled: ${scheduledId}`);
            return true;
        }
        return false;
    }

    /**
     * Load scheduled deliveries from cache and set up timeouts
     */
    private async loadScheduledDeliveries(): Promise<void> {
        try {
            const cacheKeys = await this.runtime.cacheManager.get<string[]>("contentDelivery/scheduledKeys");

            if (!cacheKeys || cacheKeys.length === 0) {
                elizaLogger.debug("[ContentDeliveryService] No scheduled deliveries found in cache");
                return;
            }

            let activeScheduledKeys: string[] = [];
            let latest = new Date();

            for (const key of cacheKeys) {
                const scheduledDelivery = await this.runtime.cacheManager.get<ScheduledCacheEntry>(`contentDelivery/scheduled/${key}`);

                if (scheduledDelivery) {
                    const { contentPiece, options } = scheduledDelivery;
                    const scheduledTime = new Date(options.scheduledTime);
                    const now = new Date();
                    activeScheduledKeys.push(key);

                    if (scheduledTime > now) {
                        // Still in the future, reschedule
                        const delay = scheduledTime.getTime() - now.getTime();

                        const timeout = setTimeout(async () => {
                            try {
                                // Remove scheduled time to trigger immediate delivery
                                const deliveryOptions = { ...options, scheduledTime: undefined };
                                await this.postContent(contentPiece, deliveryOptions);

                                // Clean up cache
                                await this.runtime.cacheManager.delete(`contentDelivery/scheduled/${key}`);
                                this.scheduledDeliveries.delete(key);
                            } catch (error) {
                                elizaLogger.error(`[ContentDeliveryService] Error executing scheduled delivery: ${error}`);
                            }
                        }, delay);

                        this.scheduledDeliveries.set(key, timeout);
                        elizaLogger.log(`[ContentDeliveryService] Restored scheduled delivery for ${scheduledTime.toISOString()}`);

                        if (scheduledTime > latest) {
                            latest = scheduledTime;
                        }

                    } else {
                        // In the past, deliver now
                        elizaLogger.log(`[ContentDeliveryService] Delivering past-due scheduled content: ${contentPiece.id}`);
                        const deliveryOptions = { ...options, scheduledTime: undefined };
                        await this.postContent(contentPiece, deliveryOptions);

                        // Clean up cache
                        await this.runtime.cacheManager.delete(`contentDelivery/scheduled/${key}`);
                    }
                }
            }

            // Clean up list of active scheduled keys
            await this.runtime.cacheManager.set("contentDelivery/scheduledKeys", activeScheduledKeys, { expires: latest.getTime() + (24 * 60 * 60 * 1000) });

        } catch (error) {
            elizaLogger.error(`[ContentDeliveryService] Error loading scheduled deliveries: ${error}`);
        }
    }

    /**
     * Start the delivery monitor to check for missed deliveries
     */
    private startDeliveryMonitor(): void {
        // Check every 15 minutes for missed scheduled deliveries
        setInterval(async () => {
            try {
                await this.loadScheduledDeliveries();
            } catch (error) {
                elizaLogger.error(`[ContentDeliveryService] Error in delivery monitor: ${error}`);
            }
        }, 15 * 60 * 1000);
    }

    /**
     * Posts content to multiple platforms
     */
    async postContentToMultiplePlatforms(
        contentPiece: ContentPiece,
        platforms: Platform[],
        options?: ContentDeliveryOptions
    ): Promise<ContentDeliveryResult[]> {
        return Promise.all(
            platforms.map(platform =>
                this.postContent({ ...contentPiece, platform }, options)
            )
        );
    }

    /**
     * Check health status for all registered platforms
     */
    async checkPlatformConnections(): Promise<Record<Platform, boolean>> {
        elizaLogger.debug("[ContentDeliveryService] Checking platform connections");
        const statuses: Record<Platform, boolean> = {} as Record<Platform, boolean>;

        for (const [platform, registration] of this.adapterRegistry.entries()) {
            if (registration.enabled) {
                try {
                    statuses[platform] = await registration.adapter.checkConnection();
                } catch {
                    statuses[platform] = false;
                }
            } else {
                statuses[platform] = false;
            }
        }

        return statuses;
    }
}