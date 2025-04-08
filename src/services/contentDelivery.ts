import { UUID, Service, IAgentRuntime, elizaLogger, ServiceType, stringToUuid } from "@elizaos/core";
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

export interface ContentDeliveryOptions {
    retry?: boolean;
    maxRetries?: number;
    validateBeforePublish?: boolean;
    formatOptions?: Record<string, any>;
}

export interface ContentDeliveryResult extends PublishResult {
    contentId: UUID;
    platform: Platform;
    attempts?: number;
    validationErrors?: string[];
}

export class ContentDeliveryService extends Service {
    capabilityDescription = "Provides a platform-specific adapter for content management";
    private approvalService: ContentApprovalService | undefined;

    static get serviceType(): ServiceType {
        return "content-delivery" as ServiceType;
    }

    get serviceType(): ServiceType {
        return ContentDeliveryService.serviceType;
    }

    private runtime: IAgentRuntime;
    private adapterRegistry: Map<Platform, AdapterRegistration> = new Map();
    private defaultOptions: ContentDeliveryOptions = {
        retry: true,
        maxRetries: 3,
        validateBeforePublish: true
    };

    async initialize(runtime: IAgentRuntime, approvalService?: ContentApprovalService): Promise<void> {
        elizaLogger.debug("[ContentDeliveryService] Initializing ContentDeliveryService");
        this.runtime = runtime;

        this.approvalService = approvalService;

        // Initialize platform clients
        for (const [platform, registration] of this.adapterRegistry.entries()) {
            try {
                await registration.adapter.initialize(this.runtime);
                elizaLogger.debug(`[ContentDeliveryService] Adapter for ${platform} initialized`);
            } catch (error) {
                elizaLogger.error(`[ContentDeliveryService] Failed to initialize adapter for ${platform}: ${error}`);
            }
        }

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
    }

    /**
     * Register a platform adapter
     */
    registerAdapter(platform: Platform, adapter: PlatformAdapter, config?: PlatformAdapterConfig): void {
        if (config) {
            adapter.configure(config);
        }

        this.adapterRegistry.set(platform, {
            adapter,
            platform,
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
        const mergedOptions = { ...this.defaultOptions, ...options };
        const registration = this.adapterRegistry.get(contentPiece.platform);

        if (!registration || !registration.enabled) {
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
            // Validate content if option is enabled
            if (mergedOptions.validateBeforePublish) {
                const validationResult = await adapter.validateContent(contentPiece);
                if (!validationResult.isValid) {
                    validationErrors = validationResult.errors || [];
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
            const formattedContent = await adapter.formatContent(contentPiece);

            // Get approval if required
            if (this.approvalService) {
                await this.approvalService.sendForApproval(formattedContent, this.publishContent)
            } else {
                const approvalResult: ApprovalRequest = {
                    id: stringToUuid(contentPiece.id + "-approval"),
                    content: formattedContent,
                    platform: contentPiece.platform,
                    requesterId: this.runtime.agentId,
                    timestamp: new Date(),
                    status: ApprovalStatus.APPROVED,
                    comments: "Content approved automatically",
                    callback: this.publishContent
                }
                await this.publishContent(approvalResult);
            }
        } catch (error) {
            return null
        }
    }

    async publishContent(approvalResult: ApprovalRequest): Promise<ContentDeliveryResult> {
        const contentPiece = approvalResult.content;
        let attempts = 0;

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
            const adapter = registration.adapter;

            // Publish with retry logic if enabled
            let publishResult: PublishResult = { success: false, timestamp: new Date() };
            let lastError: any;

            do {
                attempts++;
                try {
                    publishResult = await adapter.publishContent(contentPiece.formattedContent);

                    if (publishResult.success) {
                        // Update content status if published successfully
                        contentPiece.status = ContentStatus.PUBLISHED;

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