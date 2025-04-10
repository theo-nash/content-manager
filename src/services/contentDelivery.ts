import { UUID, IAgentRuntime, elizaLogger, ServiceType, stringToUuid } from "@elizaos/core";
import {
    ContentPiece,
    Platform,
    PublishResult,
    ContentStatus,
    ApprovalStatus,
    ApprovalRequest,
    ContentValidationResult
} from "../types";
import { ContentApprovalService } from "./contentApproval";
import { ContentAgentMemoryManager } from "../managers/contentMemory";
import { AdapterProvider } from "./adapterService";

export interface ContentDeliveryOptions {
    retry?: boolean;
    maxRetries?: number;
    validateBeforePublish?: boolean;
    formatOptions?: Record<string, any>;
    scheduledTime?: Date;
    skipApproval?: boolean;
    approvalOffset?: number; // milliseconds before scheduled time to request approval
}

export interface ContentDeliveryResult extends PublishResult {
    contentId: UUID;
    platform: Platform;
    success: boolean;
    timestamp: Date;
    attempts?: number;
    validationErrors?: string[];
}

interface ScheduledCacheEntry {
    contentPiece: ContentPiece;
    options: ContentDeliveryOptions;
    createdAt: Date;
    approvalStatus?: ApprovalStatus;
    approvalId?: UUID;
    formattedContent?: ContentPiece;
    isProcessing?: boolean;
    lastProcessed?: Date;
}

export class ContentDeliveryService {
    capabilityDescription = "Provides a platform-specific adapter for content management";
    private approvalService: ContentApprovalService | undefined;
    private scheduledDeliveries: Map<string, NodeJS.Timeout> = new Map();
    private runtime: IAgentRuntime;
    private memoryManager: ContentAgentMemoryManager;
    private adapterProvider: AdapterProvider;
    private maintenanceInterval: NodeJS.Timeout;

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
        approvalOffset: 3 * 60 * 60 * 1000, // 3 hours
    };

    async initialize(runtime: IAgentRuntime, memoryManager: ContentAgentMemoryManager, approvalService?: ContentApprovalService, adapterProvider?: AdapterProvider): Promise<void> {
        elizaLogger.debug("[ContentDeliveryService] Initializing ContentDeliveryService");
        this.runtime = runtime;
        this.memoryManager = memoryManager;
        this.approvalService = approvalService;
        this.adapterProvider = adapterProvider;

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
        this.approvalService = approvalService;

        // Load any scheduled deliveries from cache
        await this.loadScheduledDeliveries();

        // Start the delivery monitor
        this.startDeliveryMonitor();

        // Start maintenance cleanup - runs every 2 hours
        this.maintenanceInterval = setInterval(() => {
            this.performMaintenanceCleanup();
        }, 2 * 60 * 60 * 1000);
    }

    /**
     * Cleans up resources when service is being shut down
     */
    async shutdown(): Promise<void> {
        elizaLogger.debug("[ContentDeliveryService] Shutting down ContentDeliveryService");

        // Clear all scheduled deliveries
        for (const [id, timeout] of this.scheduledDeliveries.entries()) {
            clearTimeout(timeout);
        }
        this.scheduledDeliveries.clear();

        // Clear maintenance interval
        if (this.maintenanceInterval) {
            clearInterval(this.maintenanceInterval);
        }
    }

    /**
     * Manages post content to the appropriate platforms and schedules if needed
     */
    async submitContent(
        contentPiece: ContentPiece,
        options: ContentDeliveryOptions = {}
    ): Promise<ContentDeliveryResult> {
        // Ensure piece hasn't been posted already
        const contentMemory = await this.memoryManager.getContentPieceById(contentPiece.id);

        if (contentPiece.status === ContentStatus.PUBLISHED || (contentMemory && contentMemory.status === ContentStatus.PUBLISHED)) {
            elizaLogger.warn(`[ContentDeliveryService] Content already published: ${contentPiece.id}`);
            return {
                contentId: contentPiece.id,
                platform: contentPiece.platform,
                success: false,
                timestamp: new Date(),
                error: "Content already published"
            };
        }
        // Merge default options with provided options`
        const mergedOptions = { ...this.defaultOptions, ...options };

        try {
            // Format and validate content
            const formattedContent = await this.formatContent(contentPiece, mergedOptions);
            const validationResult = await this.validateContent(formattedContent, mergedOptions);

            if (!validationResult.isValid) {
                let validationErrors = validationResult.errors || [];
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

            // Check for scheduled delivery
            if (mergedOptions.scheduledTime && mergedOptions.scheduledTime > new Date()) {
                elizaLogger.log(`[ContentDeliveryService] Scheduling content for delivery at ${mergedOptions.scheduledTime.toISOString()}: ${contentPiece.id}`);
                return this.scheduleContentDelivery(formattedContent, mergedOptions);
            }

            // Check approvals
            let approval: ApprovalRequest<ContentPiece> | undefined;

            if (this.approvalService && !mergedOptions.skipApproval) {
                elizaLogger.debug(`[ContentDeliveryService] Sending content for approval: ${contentPiece.id}`);
                approval = await this.submitForApproval(formattedContent, mergedOptions);
            } else {
                elizaLogger.debug(`[ContentDeliveryService] No approval required for content: ${contentPiece.id}`);
                const boundPublish = this.publishContent.bind(this);
                approval = {
                    id: stringToUuid(`${contentPiece.id}-approval`),
                    content: formattedContent,
                    platform: contentPiece.platform,
                    requesterId: this.runtime.agentId,
                    timestamp: new Date(),
                    status: ApprovalStatus.APPROVED,
                    comments: "Content approved automatically",
                    callback: boundPublish
                }
            }

            if (approval.status === ApprovalStatus.APPROVED) {
                const boundPublish = this.publishContent.bind(this);
                return await boundPublish(approval);
            } else {
                return {
                    contentId: contentPiece.id,
                    platform: contentPiece.platform,
                    success: true,
                    timestamp: new Date(),
                    error: "Content pending approval"
                };
            }
        }
        catch (error) {
            elizaLogger.error(`[ContentDeliveryService] Error in content submission: ${error}`);
            return {
                contentId: contentPiece.id,
                platform: contentPiece.platform,
                success: false,
                timestamp: new Date(),
                error: `Error in content submission: ${error instanceof Error ? error.message : String(error)}`
            };
        }
    }

    /**
     * Validate content before publishing
     */
    private async validateContent(
        contentPiece: ContentPiece,
        options: ContentDeliveryOptions
    ): Promise<ContentValidationResult> {
        if (!options.validateBeforePublish) {
            return { isValid: true, errors: [] };
        }

        const adapter = this.adapterProvider.getAdapter(contentPiece.platform);
        if (!adapter) {
            throw new Error(`No enabled adapter for platform: ${contentPiece.platform}`);
        }

        try {
            return await adapter.validateContent(contentPiece);
        } catch (error) {
            elizaLogger.error(`[ContentDeliveryService] Validation error: ${error}`);
            return {
                isValid: false,
                errors: [`Validation error: ${error instanceof Error ? error.message : String(error)}`]
            };
        }
    }


    private async formatContent(
        contentPiece: ContentPiece,
        options: ContentDeliveryOptions
    ): Promise<ContentPiece> {
        const adapter = this.adapterProvider.getAdapter(contentPiece.platform);
        if (!adapter) {
            throw new Error(`No enabled adapter for platform: ${contentPiece.platform}`);
        }
        try {
            return await adapter.formatContent(contentPiece);
        } catch (error) {
            elizaLogger.error(`[ContentDeliveryService] Formatting error: ${error}`);
            throw new Error(`Formatting error: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async submitForApproval(
        contentPiece: ContentPiece,
        options: ContentDeliveryOptions
    ): Promise<ApprovalRequest<ContentPiece>> {
        if (this.approvalService && !options.skipApproval) {
            elizaLogger.debug(`[ContentDeliveryService] Sending content for approval: ${contentPiece.id}`);

            const boundPublish = this.publishContent.bind(this);
            return await this.approvalService.sendForApproval<ContentPiece>(contentPiece, boundPublish)

        } else {
            const boundPublish = this.publishContent.bind(this);
            const approvalResult: ApprovalRequest<ContentPiece> = {
                id: stringToUuid(`${contentPiece.id}-approval`),
                content: contentPiece,
                platform: contentPiece.platform,
                requesterId: this.runtime.agentId,
                timestamp: new Date(),
                status: ApprovalStatus.APPROVED,
                comments: "Content approved automatically",
                callback: boundPublish
            }
            return approvalResult;
        }
    }

    async publishContent(approvalResult: ApprovalRequest<ContentPiece>): Promise<ContentDeliveryResult> {
        const contentPiece = approvalResult.content;
        let attempts = 0;
        let delay = 1000;

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
            const adapter = this.adapterProvider.getAdapter(approvalResult.content.platform);
            if (!adapter) {
                throw new Error(`No enabled adapter for platform: ${contentPiece.platform}`);
            }

            // Publish with retry
            const publishResult = await this.withRetry(
                () => adapter.publishContent(contentPiece),
                (result) => result.success,
                "Publishing"
            );

            // Update content status if published successfully
            contentPiece.status = ContentStatus.PUBLISHED;
            contentPiece.platformId = publishResult.platformId || null;
            contentPiece.publishedUrl = publishResult.publishedUrl || null;

            // Store the updated content piece
            await this.memoryManager.createContentPiece(contentPiece);

            return {
                ...publishResult,
                contentId: contentPiece.id,
                platform: contentPiece.platform,
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

    private async submitScheduledContentForApproval(
        contentPiece: ContentPiece,
        options: ContentDeliveryOptions,
        cacheKey: string
    ): Promise<ApprovalRequest<ContentPiece>> {
        elizaLogger.debug(`[ContentDeliveryService] Sending scheduled content for approval: ${contentPiece.id}`);

        try {
            // Mark as processing in cache
            let scheduledData = await this.runtime.cacheManager.get<ScheduledCacheEntry>(cacheKey);
            if (scheduledData) {
                await this.runtime.cacheManager.set(
                    cacheKey,
                    {
                        ...scheduledData,
                        isProcessing: true,
                        lastProcessed: new Date()
                    },
                    { expires: new Date(scheduledData.options.scheduledTime).getTime() + (24 * 60 * 60 * 1000) }
                );
            }

            // Create a special callback for scheduled approvals that doesn't publish
            const scheduledApprovalCallback = async (request: ApprovalRequest<ContentPiece>): Promise<ContentDeliveryResult> => {
                // Just update the cache with the approval status
                const currentData = await this.runtime.cacheManager.get<ScheduledCacheEntry>(cacheKey);
                if (currentData) {
                    await this.runtime.cacheManager.set(
                        cacheKey,
                        {
                            ...currentData,
                            approvalStatus: request.status,
                            approvalId: request.id,
                            formattedContent: request.content,  // Store the formatted content
                            isProcessing: false  // Mark processing as complete
                        },
                        { expires: new Date(currentData.options.scheduledTime).getTime() + (24 * 60 * 60 * 1000) }
                    );
                }

                // Return a placeholder result - nothing is actually published yet
                return {
                    contentId: contentPiece.id,
                    platform: contentPiece.platform,
                    success: true,
                    timestamp: new Date(),
                    error: `Approval status updated for scheduled content`
                };
            };

            // Use the approval service with our custom callback
            if (this.approvalService) {
                const boundCallback = scheduledApprovalCallback.bind(this);
                return await this.approvalService.sendForApproval<ContentPiece>(
                    contentPiece,
                    boundCallback
                );
            } else {
                // Auto-approve if no approval service
                return {
                    id: stringToUuid(`${contentPiece.id}-approval`),
                    content: contentPiece,
                    platform: contentPiece.platform,
                    requesterId: this.runtime.agentId,
                    timestamp: new Date(),
                    status: ApprovalStatus.APPROVED,
                    comments: "Content approved automatically (scheduled)",
                    callback: scheduledApprovalCallback.bind(this)
                };
            }
        } catch (error) {
            // Clear processing flag on error
            const errorData = await this.runtime.cacheManager.get<ScheduledCacheEntry>(cacheKey);
            if (errorData) {
                await this.runtime.cacheManager.set(
                    cacheKey,
                    {
                        ...errorData,
                        isProcessing: false,
                        lastProcessed: new Date()
                    },
                    { expires: new Date(errorData.options.scheduledTime).getTime() + (24 * 60 * 60 * 1000) }
                );
            }

            throw error;
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
            return this.submitContent(contentPiece, { ...options, scheduledTime: undefined });
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
                options: { ...options, scheduledTime },
                createdAt: now,
                isProcessing: false
            },
            { expires: scheduledTime.getTime() + (24 * 60 * 60 * 1000) } // 24 hour grace period
        );

        // Handle approval offset logic
        if (options.approvalOffset && options.approvalOffset > 0 && !options.skipApproval && this.approvalService) {
            const approvalTime = new Date(scheduledTime.getTime() - options.approvalOffset);
            elizaLogger.log(`[ContentDeliveryService] Scheduling approval request for ${approvalTime.toISOString()}: ${contentPiece.id}`);

            if (approvalTime > now) {
                // Approval is in the future
                const approvalDelay = approvalTime.getTime() - now.getTime();
                const approvalTimeoutId = `${scheduledId}-approval`;

                // Set up approval timeout
                const approvalTimeout = setTimeout(async () => {
                    try {
                        elizaLogger.log(`[ContentDeliveryService] Requesting approval for scheduled content: ${contentPiece.id}`);

                        // Use our custom approval method
                        await this.submitScheduledContentForApproval(
                            contentPiece,
                            options,
                            cacheKey
                        );

                    } catch (error) {
                        elizaLogger.error(`[ContentDeliveryService] Error requesting approval: ${error}`);
                    }
                }, approvalDelay);

                // Store timeout reference
                this.scheduledDeliveries.set(approvalTimeoutId, approvalTimeout);
            } else {
                // Approval time is now or in past, but publishing is still future
                // Request approval immediately
                try {
                    elizaLogger.log(`[ContentDeliveryService] Requesting immediate approval for future content: ${contentPiece.id}`);
                    await this.submitScheduledContentForApproval(
                        contentPiece,
                        options,
                        cacheKey
                    );
                } catch (error) {
                    elizaLogger.error(`[ContentDeliveryService] Error requesting immediate approval: ${error}`);
                }
            }
        }

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
                // Get cached data to check approval status
                let scheduledData = await this.runtime.cacheManager.get<ScheduledCacheEntry>(cacheKey);

                if (!scheduledData) {
                    elizaLogger.error(`[ContentDeliveryService] Scheduled content not found in cache: ${contentPiece.id}`);
                    return;
                }

                // Wait for approval processing to complete if in progress
                if (scheduledData.isProcessing) {
                    elizaLogger.log(`[ContentDeliveryService] Waiting for approval processing to complete: ${contentPiece.id}`);

                    // Wait for up to 2 minutes (with 10 sec intervals) for processing to complete
                    for (let i = 0; i < 12; i++) {
                        await new Promise(resolve => setTimeout(resolve, 10000));
                        scheduledData = await this.runtime.cacheManager.get<ScheduledCacheEntry>(cacheKey);

                        if (!scheduledData || !scheduledData.isProcessing) {
                            break;
                        }
                    }

                    // If still processing after timeout, log warning but proceed
                    if (scheduledData && scheduledData.isProcessing) {
                        elizaLogger.warn(`[ContentDeliveryService] Approval still processing after wait: ${contentPiece.id}`);
                    }
                }

                // Check if content was pre-approved
                if (scheduledData.approvalStatus === ApprovalStatus.APPROVED && scheduledData.formattedContent) {
                    elizaLogger.log(`[ContentDeliveryService] Publishing pre-approved content: ${contentPiece.id}`);

                    // Create an approval result from the pre-approved data
                    const approvalResult: ApprovalRequest<ContentPiece> = {
                        id: scheduledData.approvalId || stringToUuid(`${contentPiece.id}-approval`),
                        content: scheduledData.formattedContent,
                        platform: contentPiece.platform,
                        requesterId: this.runtime.agentId,
                        timestamp: new Date(),
                        status: ApprovalStatus.APPROVED,
                        comments: "Pre-approved for scheduled delivery",
                        callback: this.publishContent.bind(this)
                    };

                    // Publish directly
                    await this.publishContent(approvalResult);
                } else if (scheduledData && scheduledData.approvalStatus === ApprovalStatus.REJECTED) {
                    // Content was rejected during pre-approval
                    elizaLogger.warn(`[ContentDeliveryService] Scheduled content was rejected during pre-approval: ${contentPiece.id}`);
                    // Don't publish rejected content
                } else {
                    // No pre-approval or status is PENDING, go through normal flow
                    elizaLogger.log(`[ContentDeliveryService] No pre-approval found, submitting normally: ${contentPiece.id}`);
                    const deliveryOptions = { ...options, scheduledTime: undefined };
                    await this.submitContent(contentPiece, deliveryOptions);
                }

                // Clean up after delivery
                await this.cleanupScheduledDelivery(cacheKey, scheduledId);

            } catch (error) {
                elizaLogger.error(`[ContentDeliveryService] Error executing scheduled delivery: ${error}`);

                // Schedule a retry cleanup to make sure resources get cleaned up
                setTimeout(() => {
                    this.cleanupScheduledDelivery(cacheKey, scheduledId);
                }, 60 * 1000);
            }
        }, delay);

        // Store the timeout reference
        this.scheduledDeliveries.set(scheduledId, timeout);

        return {
            contentId: contentPiece.id,
            platform: contentPiece.platform,
            success: true,
            timestamp: now,
            error: `Content scheduled for delivery at ${scheduledTime.toISOString()}`
        };
    }

    /**
     * Cancel a scheduled content delivery
     */
    async cancelScheduledDelivery(scheduledId: string): Promise<boolean> {
        const cacheKey = `contentDelivery/scheduled/${scheduledId}`;
        return await this.cleanupScheduledDelivery(cacheKey, scheduledId);
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
                const scheduledDelivery = await this.runtime.cacheManager.get<ScheduledCacheEntry>(key);

                if (scheduledDelivery) {
                    const { contentPiece, options } = scheduledDelivery;
                    const scheduledTime = new Date(options.scheduledTime);
                    const now = new Date();

                    // Keep active key
                    activeScheduledKeys.push(key);

                    if (scheduledTime > now) {
                        // Main delivery is still in the future
                        const delay = scheduledTime.getTime() - now.getTime();
                        const scheduledId = key.replace('contentDelivery/scheduled/', '');

                        // Check if approval is needed
                        if (options.approvalOffset && options.approvalOffset > 0 && !options.skipApproval && this.approvalService) {
                            const approvalTime = new Date(scheduledTime.getTime() - options.approvalOffset);

                            if (approvalTime > now) {
                                // Approval is also in the future
                                const approvalDelay = approvalTime.getTime() - now.getTime();
                                const approvalTimeoutId = `${scheduledId}-approval`;

                                // Set up approval timeout
                                const approvalTimeout = setTimeout(async () => {
                                    try {
                                        elizaLogger.log(`[ContentDeliveryService] Requesting approval for scheduled content: ${contentPiece.id}`);
                                        await this.submitScheduledContentForApproval(
                                            contentPiece,
                                            options,
                                            key
                                        );
                                    } catch (error) {
                                        elizaLogger.error(`[ContentDeliveryService] Error requesting approval: ${error}`);
                                    }
                                }, approvalDelay);

                                this.scheduledDeliveries.set(approvalTimeoutId, approvalTimeout);
                                elizaLogger.log(`[ContentDeliveryService] Restored scheduled approval for ${approvalTime.toISOString()}`);
                            } else {
                                // Approval time is now or past, but publishing is future
                                // Request approval immediately if not already done
                                if (!scheduledDelivery.approvalStatus) {
                                    try {
                                        elizaLogger.log(`[ContentDeliveryService] Requesting immediate approval for future content: ${contentPiece.id}`);
                                        await this.submitScheduledContentForApproval(
                                            contentPiece,
                                            options,
                                            key
                                        );
                                    } catch (error) {
                                        elizaLogger.error(`[ContentDeliveryService] Error requesting immediate approval: ${error}`);
                                    }
                                }
                            }
                        }

                        // Set up main delivery timeout using bind to maintain context
                        const boundDeliveryFn = async () => {
                            try {
                                // Check for pre-approval
                                let scheduledData = await this.runtime.cacheManager.get<ScheduledCacheEntry>(key);

                                if (!scheduledData) {
                                    elizaLogger.error(`[ContentDeliveryService] Scheduled content not found in cache: ${contentPiece.id}`);
                                    return;
                                }

                                // Wait for approval processing to complete if in progress
                                if (scheduledData.isProcessing) {
                                    elizaLogger.log(`[ContentDeliveryService] Waiting for approval processing to complete: ${contentPiece.id}`);

                                    // Wait for up to 2 minutes (with 10 sec intervals) for processing to complete
                                    for (let i = 0; i < 12; i++) {
                                        await new Promise(resolve => setTimeout(resolve, 10000));
                                        scheduledData = await this.runtime.cacheManager.get<ScheduledCacheEntry>(key);

                                        if (!scheduledData || !scheduledData.isProcessing) {
                                            break;
                                        }
                                    }
                                }

                                if (scheduledData && scheduledData.approvalStatus === ApprovalStatus.APPROVED && scheduledData.formattedContent) {
                                    // Content was pre-approved, publish directly
                                    elizaLogger.log(`[ContentDeliveryService] Publishing pre-approved content: ${contentPiece.id}`);

                                    const approvalResult: ApprovalRequest<ContentPiece> = {
                                        id: scheduledData.approvalId || stringToUuid(`${contentPiece.id}-approval`),
                                        content: scheduledData.formattedContent,
                                        platform: contentPiece.platform,
                                        requesterId: this.runtime.agentId,
                                        timestamp: new Date(),
                                        status: ApprovalStatus.APPROVED,
                                        comments: "Pre-approved for scheduled delivery",
                                        callback: this.publishContent.bind(this)
                                    };

                                    await this.publishContent(approvalResult);
                                } else if (scheduledData && scheduledData.approvalStatus === ApprovalStatus.REJECTED) {
                                    // Content was rejected, don't publish
                                    elizaLogger.warn(`[ContentDeliveryService] Scheduled content was rejected during pre-approval: ${contentPiece.id}`);
                                } else {
                                    // No pre-approval or still pending
                                    const deliveryOptions = { ...options, scheduledTime: undefined };
                                    await this.submitContent(contentPiece, deliveryOptions);
                                }

                                // Clean up
                                await this.cleanupScheduledDelivery(key, scheduledId);

                            } catch (error) {
                                elizaLogger.error(`[ContentDeliveryService] Error executing scheduled delivery: ${error}`);

                                // Schedule a retry cleanup to make sure resources get cleaned up
                                setTimeout(() => {
                                    this.cleanupScheduledDelivery(key, scheduledId);
                                }, 60 * 1000);
                            }
                        };

                        const timeout = setTimeout(boundDeliveryFn, delay);
                        this.scheduledDeliveries.set(scheduledId, timeout);
                        elizaLogger.log(`[ContentDeliveryService] Restored scheduled delivery for ${scheduledTime.toISOString()}`);

                        if (scheduledTime > latest) {
                            latest = scheduledTime;
                        }
                    } else {
                        // Scheduled time is in the past, deliver now
                        elizaLogger.log(`[ContentDeliveryService] Delivering past-due scheduled content: ${contentPiece.id}`);

                        // Check if there was a pre-approval
                        if (scheduledDelivery.approvalStatus === ApprovalStatus.APPROVED && scheduledDelivery.formattedContent) {
                            const approvalResult: ApprovalRequest<ContentPiece> = {
                                id: scheduledDelivery.approvalId || stringToUuid(`${contentPiece.id}-approval`),
                                content: scheduledDelivery.formattedContent,
                                platform: contentPiece.platform,
                                requesterId: this.runtime.agentId,
                                timestamp: new Date(),
                                status: ApprovalStatus.APPROVED,
                                comments: "Pre-approved for scheduled delivery",
                                callback: this.publishContent.bind(this)
                            };

                            await this.publishContent(approvalResult);
                        } else if (scheduledDelivery.approvalStatus === ApprovalStatus.REJECTED) {
                            // Content was rejected, don't publish
                            elizaLogger.warn(`[ContentDeliveryService] Past-due content was rejected during pre-approval: ${contentPiece.id}`);
                        } else {
                            // No pre-approval or still pending
                            const deliveryOptions = { ...options, scheduledTime: undefined };
                            await this.submitContent(contentPiece, deliveryOptions);
                        }

                        // Clean up cache
                        const scheduledId = key.replace('contentDelivery/scheduled/', '');
                        await this.cleanupScheduledDelivery(key, scheduledId);
                    }
                }
            }

            // Clean up list of active scheduled keys
            await this.runtime.cacheManager.set(
                "contentDelivery/scheduledKeys",
                activeScheduledKeys,
                { expires: latest.getTime() + (24 * 60 * 60 * 1000) }
            );

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
                this.submitContent({ ...contentPiece, platform }, options)
            )
        );
    }

    /**
     * Check health status for all registered platforms
     */
    async checkPlatformConnections(): Promise<Record<Platform, boolean>> {
        return this.adapterProvider.checkPlatformConnections();
    }

    /**
     * Clean up resources for a scheduled delivery
     */
    private async cleanupScheduledDelivery(cacheKey: string, scheduledId: string): Promise<boolean> {
        try {
            // First try to get all keys
            const cacheKeys = await this.runtime.cacheManager.get<string[]>("contentDelivery/scheduledKeys") || [];
            const updatedKeys = cacheKeys.filter(key => key !== cacheKey);

            // Perform operations in parallel for efficiency
            await Promise.all([
                // Delete the specific cache entry
                this.runtime.cacheManager.delete(cacheKey),

                // Update the keys list
                this.runtime.cacheManager.set(
                    "contentDelivery/scheduledKeys",
                    updatedKeys,
                    { expires: Date.now() + (7 * 24 * 60 * 60 * 1000) } // 7 day grace period
                )
            ]);

            // Clear timeouts if they exist
            if (this.scheduledDeliveries.has(scheduledId)) {
                clearTimeout(this.scheduledDeliveries.get(scheduledId));
                this.scheduledDeliveries.delete(scheduledId);
            }

            const approvalTimeoutId = `${scheduledId}-approval`;
            if (this.scheduledDeliveries.has(approvalTimeoutId)) {
                clearTimeout(this.scheduledDeliveries.get(approvalTimeoutId));
                this.scheduledDeliveries.delete(approvalTimeoutId);
            }

            elizaLogger.debug(`[ContentDeliveryService] Successfully cleaned up scheduled delivery: ${scheduledId}`);
            return true;
        } catch (error) {
            // Log the error but don't rethrow - we want to continue even if cleanup partially fails
            elizaLogger.error(`[ContentDeliveryService] Error during cache cleanup for ${scheduledId}: ${error}`);

            // Try to schedule a retry cleanup later
            setTimeout(() => {
                this.performMaintenanceCleanup();
            }, 15 * 60 * 1000); // 15 minutes later

            return false;
        }
    }

    /**
     * Perform maintenance cleanup for scheduled deliveries
     * - Cleans up expired or orphaned entries
     * - Handles any inconsistencies in the cache
     */
    private async performMaintenanceCleanup(): Promise<void> {
        elizaLogger.debug("[ContentDeliveryService] Performing maintenance cleanup");

        try {
            // Get all scheduled keys
            const cacheKeys = await this.runtime.cacheManager.get<string[]>("contentDelivery/scheduledKeys") || [];
            const now = new Date();

            // Check each key for expired deliveries
            for (const key of cacheKeys) {
                try {
                    const scheduledData = await this.runtime.cacheManager.get<ScheduledCacheEntry>(key);
                    if (!scheduledData) {
                        // Remove orphaned key
                        const updatedKeys = cacheKeys.filter(k => k !== key);
                        await this.runtime.cacheManager.set(
                            "contentDelivery/scheduledKeys",
                            updatedKeys,
                            { expires: now.getTime() + (7 * 24 * 60 * 60 * 1000) }
                        );
                        continue;
                    }

                    const scheduledTime = new Date(scheduledData.options.scheduledTime);
                    // If scheduled time is more than 24 hours in the past, clean up
                    if (scheduledTime.getTime() < now.getTime() - (24 * 60 * 60 * 1000)) {
                        const scheduledId = key.replace('contentDelivery/scheduled/', '');
                        await this.cleanupScheduledDelivery(key, scheduledId);
                    }

                    // Check for stuck processing flags (more than 30 minutes old)
                    if (scheduledData.isProcessing && scheduledData.lastProcessed) {
                        const lastProcessed = new Date(scheduledData.lastProcessed);
                        if ((now.getTime() - lastProcessed.getTime()) > 30 * 60 * 1000) {
                            elizaLogger.warn(`[ContentDeliveryService] Found stuck processing flag for ${key}, resetting`);

                            // Reset processing flag
                            await this.runtime.cacheManager.set(
                                key,
                                {
                                    ...scheduledData,
                                    isProcessing: false
                                },
                                { expires: scheduledTime.getTime() + (24 * 60 * 60 * 1000) }
                            );
                        }
                    }
                } catch (error) {
                    elizaLogger.error(`[ContentDeliveryService] Error checking scheduled key ${key}: ${error}`);
                }
            }

            elizaLogger.debug(`[ContentDeliveryService] Maintenance cleanup completed`);
        } catch (error) {
            elizaLogger.error(`[ContentDeliveryService] Error in maintenance cleanup: ${error}`);
        }
    }

    // Helper retry function that can be applied to any async operation
    private async withRetry<T>(
        operation: () => Promise<T>,
        isSuccess: (result: T) => boolean,
        errorMessage: string,
        options?: ContentDeliveryOptions
    ): Promise<T> {
        let attempts = 0;
        let delay = 1000; // Start with 1 second
        const maxRetries = options?.maxRetries || this.defaultOptions.maxRetries || 3;

        let result: T;
        let lastError: Error | string = new Error("Operation failed");

        for (attempts = 1; attempts <= maxRetries; attempts++) {
            try {
                elizaLogger.debug(`[ContentDeliveryService] ${errorMessage} attempt ${attempts}/${maxRetries}`);
                result = await operation();

                if (isSuccess(result)) {
                    return result;
                }

                // If we're here, the operation was performed but returned a non-success result
                if (result && typeof result === 'object' && 'error' in result) {
                    if (typeof result.error === 'string') {
                        lastError = new Error(result.error);
                    } else if (result.error instanceof Error) {
                        lastError = result.error;
                    } else {
                        lastError = new Error('Unknown error');
                    }
                }
            } catch (error) {
                lastError = error instanceof Error ? error.message : String(error);

                // Check for non-retryable errors
                if (isNonRetryableError(lastError)) {
                    throw new Error(`Non-retryable error: ${lastError}`);
                }
            }

            // Only delay and retry if we haven't succeeded and have retries left
            if (attempts < maxRetries) {
                await new Promise(resolve => setTimeout(resolve, delay));
                delay = Math.min(delay * 2, 30000); // Exponential backoff with 30s max
            }
        }

        throw new Error(`Failed after ${attempts - 1} attempts: ${lastError}`);
    };
}

// Helper to identify errors that shouldn't be retried
function isNonRetryableError(error: string | Error): boolean {
    const errorMessage = error instanceof Error ? error.message : error;
    const nonRetryablePatterns = [
        'authentication failed',
        'insufficient permissions',
        'invalid content format',
        'account suspended',
        'rate limit exceeded',
    ];

    return nonRetryablePatterns.some(pattern =>
        errorMessage.toLowerCase().includes(pattern.toLowerCase())
    );
}