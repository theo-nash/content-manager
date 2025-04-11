import { elizaLogger, getProviders, IAgentRuntime, stringToUuid, UUID } from "@elizaos/core";
import { ApprovalProvider } from "../approval/base";
import { ApprovalRequest, ContentPiece, ApprovalStatus, Platform, MasterPlan, MicroPlan, ApprovalContent } from "../types";
import { ApprovalConfig } from "../environment";

// Constants for cache management
const CACHE_TTL_DAYS = 7; // Standardize on 7 days
const CACHE_KEY_PENDING = "pendingApprovals";
const CACHE_KEY_PREFIX = "approval";
const MAX_CALLBACK_RETRIES = 3;

// Type guard functions for more reliable content type detection
function isContentPiece(content: any): content is ContentPiece {
    return content && 'topic' in content && 'platform' in content;
}

function isMicroPlan(content: any): content is MicroPlan {
    return content && 'masterPlanId' in content && 'period' in content && 'contentPieces' in content;
}

function isMasterPlan(content: any): content is MasterPlan {
    return content && 'title' in content && 'goals' in content && 'contentMix' in content && 'audience' in content;
}

export class ContentApprovalService {
    private runtime: IAgentRuntime;
    private providers: Map<string, ApprovalProvider>;
    private pendingApprovals: Map<string, ApprovalRequest<any>> = new Map();
    private config: ApprovalConfig;
    private platformProviderMap: Map<string, string> = new Map();
    private isInitialized: boolean = false;
    private periodicCheckInterval: NodeJS.Timeout | null = null;

    constructor(runtime: IAgentRuntime, providers: ApprovalProvider[], approvalConfig: ApprovalConfig) {
        this.runtime = runtime;
        this.config = approvalConfig;
        this.providers = new Map();

        providers.forEach(provider => {
            this.providers.set(provider.providerName, provider);
        });
    }

    async initialize(): Promise<void> {
        if (this.isInitialized) {
            elizaLogger.debug("[ContentApprovalService] ContentApprovalService is already initialized");
            return;
        }

        // Initialize the service
        elizaLogger.debug("[ContentApprovalService] Initializing ContentApprovalService");

        // Setup default platform provider mapping
        this.setupPlatformProviderMapping();

        // Check if the service is enabled
        if (!this.config.APPROVAL_ENABLED) {
            elizaLogger.warn("[ContentApprovalService] Content approval service is disabled.");
            this.isInitialized = true;
            return;
        }

        // Initialize all providers
        for (const provider of this.providers.values()) {
            try {
                await provider.initialize(this.runtime);
                elizaLogger.debug(`[ContentApprovalService] Provider ${provider.providerName} initialized`);
            } catch (error) {
                elizaLogger.error(`[ContentApprovalService] Failed to initialize provider ${provider.providerName}: ${error}`);
            }
        }

        // Load pending approvals from cache
        await this.loadPendingApprovalsFromCache();

        // Check all pending approvals
        await this.checkAllPendingApprovals();

        // Set up a periodic check for pending approvals
        this.periodicCheckInterval = setInterval(async () => {
            try {
                await this.checkAllPendingApprovals();
                await this.cleanupStaleApprovals();
            } catch (error) {
                elizaLogger.error(`[ContentApprovalService] Error during periodic check: ${error}`);
            }
        }, this.config.APPROVAL_CHECK_INTERVAL * 60 * 1000);

        this.isInitialized = true;
        elizaLogger.log("[ContentApprovalService] Initialization complete");
    }

    async shutdown(): Promise<void> {
        elizaLogger.debug("[ContentApprovalService] Shutting down ContentApprovalService");

        // Clear interval
        if (this.periodicCheckInterval) {
            clearInterval(this.periodicCheckInterval);
            this.periodicCheckInterval = null;
        }

        // Save pending approvals before shutdown
        await this.savePendingApprovalsToCache();

        this.isInitialized = false;
    }


    private setupPlatformProviderMapping(): void {
        // Default mappings - can be overridden by configuration
        this.platformProviderMap.set(Platform.TWITTER, "discord");
        this.platformProviderMap.set(Platform.DISCORD, "discord");
        this.platformProviderMap.set(Platform.MEDIUM, "discord");

        // Apply any configuration overrides
        if (this.config.PLATFORM_PROVIDER_MAPPING) {
            try {
                const mappings = JSON.parse(this.config.PLATFORM_PROVIDER_MAPPING);
                for (const [platform, provider] of Object.entries(mappings)) {
                    this.platformProviderMap.set(platform, provider as string);
                }
            } catch (error) {
                elizaLogger.error(`[ContentApprovalService] Error parsing platform provider mapping: ${error}`);
            }
        }
    }

    private async loadPendingApprovalsFromCache(): Promise<void> {
        try {
            const cachedApprovals = await this.runtime.cacheManager.get<Array<[string, ApprovalRequest<any>]>>(CACHE_KEY_PENDING);

            if (cachedApprovals) {
                this.pendingApprovals = new Map(cachedApprovals);
                elizaLogger.debug(`[ContentApprovalService] Loaded ${this.pendingApprovals.size} pending approvals from cache`);
            }

            await this.cleanupStaleApprovals();

        } catch (error) {
            elizaLogger.error(`[ContentApprovalService] Error loading approvals from cache: ${error}`);
            // Initialize with empty map if there's an error
            this.pendingApprovals = new Map();
        }
    }

    private async savePendingApprovalsToCache(): Promise<void> {
        const serializedApprovals = Array.from(this.pendingApprovals.entries());
        const expiresAt = Date.now() + (CACHE_TTL_DAYS * 24 * 60 * 60 * 1000);

        try {
            await this.runtime.cacheManager.set(
                CACHE_KEY_PENDING,
                serializedApprovals,
                { expires: expiresAt }
            );
        } catch (error) {
            elizaLogger.error(`[ContentApprovalService] Error saving approvals to cache: ${error}`);
        }
    }

    getProvider(platform: Platform | string): ApprovalProvider | undefined {
        // Get provider name from platform mapping
        const providerName = this.platformProviderMap.get(platform);

        if (providerName) {
            // Return the mapped provider
            return this.providers.get(providerName);
        }

        // If no specific mapping, try to find a provider with the same name as the platform
        if (this.providers.has(platform)) {
            return this.providers.get(platform);
        }

        // As a last resort, return the first available provider
        if (this.providers.size > 0) {
            return Array.from(this.providers.values())[0];
        }

        return undefined;
    }

    async sendForApproval<T extends ApprovalContent>(
        content: T,
        callback: (request: ApprovalRequest<T>) => Promise<any>
    ): Promise<ApprovalRequest<T>> {
        if (!this.isInitialized) {
            throw new Error("[ContentApprovalService] Service not initialized");
        }

        // Ensure callback is a function
        if (typeof callback !== 'function') {
            throw new Error("[ContentApprovalService] Invalid callback provided");
        }

        // Auto-approve if configured
        if (this.config.APPROVAL_AUTOAPPROVE) {
            elizaLogger.warn("[ContentApprovalService] Auto-approve is enabled. Skipping approval.");
            const approvalId = stringToUuid(`${content.id}-approval`);

            const autoApprovalRequest: ApprovalRequest<T> = {
                id: approvalId,
                content: content,
                platform: "auto",
                requesterId: this.runtime.agentId,
                timestamp: new Date(),
                status: ApprovalStatus.APPROVED,
                comments: "Auto-approved by configuration",
                callback
            };

            // Execute callback immediately for auto-approvals
            try {
                await callback(autoApprovalRequest);
            } catch (error) {
                elizaLogger.error(`[ContentApprovalService] Error executing callback for auto-approved request: ${error}`);
            }

            return autoApprovalRequest;
        }

        // Determine content type and appropriate provider
        let contentType = "unknown";
        let provider: ApprovalProvider | undefined;

        if (isContentPiece(content)) {
            contentType = content.platform;
            provider = this.getProvider(content.platform);
        } else if (isMicroPlan(content)) {
            contentType = "microplan";
            provider = this.getDefaultProvider();
        } else if (isMasterPlan(content)) {
            contentType = "masterplan";
            provider = this.getDefaultProvider();
        } else {
            contentType = "unknown";
            provider = this.getDefaultProvider();
        }

        if (!provider) {
            elizaLogger.error(`[ContentApprovalService] No approval provider found for ${contentType}`);
            const failedRequestId = stringToUuid(`${content.id}-approval`);

            return {
                id: failedRequestId,
                content: content,
                platform: contentType,
                requesterId: this.runtime.agentId,
                timestamp: new Date(),
                status: ApprovalStatus.FAILED,
                comments: "No approval provider available",
                callback
            };
        }

        const providerName = provider.providerName;

        // Check cache for an existing request
        const cacheKey = `${CACHE_KEY_PREFIX}/${providerName}/${content.id}-approval`;
        const cachedRequest = await this.runtime.cacheManager.get<ApprovalRequest<T>>(cacheKey);

        if (cachedRequest) {
            // Update the callback to the new one (keeping context)
            cachedRequest.callback = callback;
            return cachedRequest;
        }

        // Create new approval request
        const approvalId = stringToUuid(`${content.id}-approval`);

        let request: ApprovalRequest<T> = {
            id: approvalId,
            content: content,
            platform: contentType,
            requesterId: this.runtime.agentId,
            timestamp: new Date(),
            status: ApprovalStatus.PENDING,
            callback
        };

        try {
            // Submit to provider
            request = await provider.submitForApproval(request);

            // Cache individual request
            await this.runtime.cacheManager.set(
                cacheKey,
                request,
                { expires: Date.now() + (CACHE_TTL_DAYS * 24 * 60 * 60 * 1000) }
            );

            // Add to pending approvals
            await this.addPendingApproval(request);

            elizaLogger.log(`[ContentApprovalService] Approval request created: ${request.id} (${contentType})`);
            return request;
        } catch (error) {
            elizaLogger.error(`[ContentApprovalService] Error submitting approval request: ${error}`);

            // Return a failed request
            request.status = ApprovalStatus.FAILED;
            request.comments = `Error: ${error instanceof Error ? error.message : String(error)}`;

            return request;
        }
    }

    private getDefaultProvider(): ApprovalProvider | undefined {
        if (this.providers.size === 0) {
            return undefined;
        }

        // Try to get a "default" provider
        if (this.providers.has("default")) {
            return this.providers.get("default");
        }

        // Otherwise return the first provider
        return Array.from(this.providers.values())[0];
    }

    async checkApprovalStatus<T extends ApprovalContent>(request: ApprovalRequest<T>): Promise<ApprovalRequest<T>> {
        if (!this.isInitialized) {
            elizaLogger.warn("[ContentApprovalService] Service not initialized");
            return request;
        }

        // Make a safe copy of the request to work with
        const currentRequest = { ...request };

        if (!this.pendingApprovals.has(currentRequest.id)) {
            elizaLogger.warn(`[ContentApprovalService] Approval request "${currentRequest.id}" not found.`);
            return currentRequest;
        }

        // Get the appropriate provider
        const provider = this.getProviderForRequest(currentRequest);

        if (!provider) {
            elizaLogger.error(`[ContentApprovalService] Approval provider not found for request: ${currentRequest.id}`);
            const failedRequest = {
                ...currentRequest,
                status: ApprovalStatus.FAILED,
                comments: "Approval provider not found"
            };
            await this.updateApprovalRequest(failedRequest);
            return failedRequest;
        }

        try {
            const updatedStatus = await provider.checkApprovalStatus(currentRequest);

            if (updatedStatus.status !== currentRequest.status) {
                elizaLogger.log(`[ContentApprovalService] Status changed for request ${currentRequest.id}: ${currentRequest.status} -> ${updatedStatus.status}`);
                await this.updateApprovalRequest(updatedStatus);
            }

            return updatedStatus;
        } catch (error) {
            elizaLogger.error(`[ContentApprovalService] Error checking approval status: ${error}`);
            return currentRequest;
        }
    }

    private getProviderForRequest(request: ApprovalRequest<any>): ApprovalProvider | undefined {
        if (isContentPiece(request.content)) {
            return this.getProvider(request.content.platform);
        }

        // Try to get by platform field
        if (request.platform && this.providers.has(request.platform)) {
            return this.providers.get(request.platform);
        }

        // Fall back to default provider
        return this.getDefaultProvider();
    }

    async registerProvider(provider: ApprovalProvider): Promise<void> {
        if (this.providers.has(provider.providerName)) {
            throw new Error(`[ContentApprovalService] Approval provider "${provider.providerName}" already registered.`);
        }

        this.providers.set(provider.providerName, provider);
        elizaLogger.log(`[ContentApprovalService] Provider registered: ${provider.providerName}`);
    }

    async addPendingApproval(request: ApprovalRequest<any>): Promise<void> {
        if (this.pendingApprovals.has(request.id)) {
            elizaLogger.warn(`[ContentApprovalService] Approval request "${request.id}" already exists.`);
            return;
        }

        this.pendingApprovals.set(request.id, request);

        await this.savePendingApprovalsToCache();

        elizaLogger.debug(`[ContentApprovalService] Added pending approval: ${request.id}`);
    }

    async updateApprovalRequest(request: ApprovalRequest<any>): Promise<void> {
        if (!this.pendingApprovals.has(request.id)) {
            elizaLogger.warn(`[ContentApprovalService] Approval request "${request.id}" not found.`);
            return;
        }

        const finalStatuses = [ApprovalStatus.APPROVED, ApprovalStatus.REJECTED, ApprovalStatus.FAILED];
        const originalRequest = this.pendingApprovals.get(request.id);

        if (finalStatuses.includes(request.status)) {
            this.pendingApprovals.delete(request.id);
        } else {
            this.pendingApprovals.set(request.id, request);
        }

        // Save updates to cache
        await this.savePendingApprovalsToCache();

        // Execute callback with error handling
        try {
            if (typeof request.callback === 'function') {
                await this.executeCallbackWithRetry(request);
            } else {
                elizaLogger.warn(`[ContentApprovalService] No valid callback for approval request ${request.id}`);
            }
        } catch (error) {
            elizaLogger.error(`[ContentApprovalService] Error executing callback for approval request ${request.id}: ${error}`);
        }

        elizaLogger.log(`[ContentApprovalService] Approval request updated: ${request.id} - Status: ${request.status}`);
    }

    private async cleanupStaleApprovals(): Promise<void> {
        if (!this.isInitialized) {
            return;
        }

        try {
            const now = new Date();
            const staleThreshold = new Date(now.getTime() - (this.config.AUTO_REJECT_DAYS * 24 * 60 * 60 * 1000));
            let staleCount = 0;

            // Create a copy of the entries to avoid modification during iteration
            const entries = Array.from(this.pendingApprovals.entries());

            for (const [id, request] of entries) {
                if (request.timestamp < staleThreshold) {
                    elizaLogger.warn(`[ContentApprovalService] Auto-rejecting stale approval request: ${id} (${new Date(request.timestamp).toISOString()})`);

                    const rejectedRequest = {
                        ...request,
                        status: ApprovalStatus.REJECTED,
                        comments: `Auto-rejected: Request exceeded maximum age of ${this.config.AUTO_REJECT_DAYS} days`
                    };

                    await this.updateApprovalRequest(rejectedRequest);
                    staleCount++;
                }
            }

            if (staleCount > 0) {
                elizaLogger.log(`[ContentApprovalService] Cleaned up ${staleCount} stale approval requests`);
            }
        } catch (error) {
            elizaLogger.error(`[ContentApprovalService] Error cleaning up stale approvals: ${error}`);
        }
    }

    private async executeCallbackWithRetry(request: ApprovalRequest<any>): Promise<void> {
        let attempts = 0;
        let success = false;
        let lastError: any;

        while (attempts < MAX_CALLBACK_RETRIES && !success) {
            attempts++;
            try {
                await request.callback(request);
                success = true;
                elizaLogger.debug(`[ContentApprovalService] Callback executed successfully for request ${request.id}`);
            } catch (error) {
                lastError = error;
                elizaLogger.error(`[ContentApprovalService] Error executing callback (attempt ${attempts}): ${error}`);

                // Wait before retry (exponential backoff)
                if (attempts < MAX_CALLBACK_RETRIES) {
                    const delay = Math.min(1000 * Math.pow(2, attempts), 30000);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }

        if (!success) {
            elizaLogger.error(`[ContentApprovalService] All callback attempts failed for request ${request.id}: ${lastError}`);
        }
    }

    private async checkAllPendingApprovals(): Promise<void> {
        if (!this.isInitialized || this.pendingApprovals.size === 0) {
            return;
        }

        elizaLogger.debug(`[ContentApprovalService] Checking status of ${this.pendingApprovals.size} pending approvals`);

        // Create a copy of values to avoid modification during iteration
        const requests = Array.from(this.pendingApprovals.values());

        // Check all in parallel (with a concurrency limit)
        const concurrencyLimit = 5;
        const chunks = [];

        for (let i = 0; i < requests.length; i += concurrencyLimit) {
            chunks.push(requests.slice(i, i + concurrencyLimit));
        }

        for (const chunk of chunks) {
            await Promise.all(chunk.map(request => this.checkApprovalStatus(request)));
        }
    }

    // Public API to get pending approvals count
    async getPendingApprovalsCount(): Promise<number> {
        return this.pendingApprovals.size;
    }

    // Public API to cancel an approval request
    async cancelApprovalRequest(requestId: UUID | string): Promise<boolean> {
        if (!this.pendingApprovals.has(requestId)) {
            elizaLogger.warn(`[ContentApprovalService] Approval request "${requestId}" not found for cancellation.`);
            return false;
        }

        const request = this.pendingApprovals.get(requestId);
        if (!request) return false;

        const cancelledRequest = {
            ...request,
            status: ApprovalStatus.REJECTED,
            comments: "Approval request cancelled"
        };

        await this.updateApprovalRequest(cancelledRequest);
        elizaLogger.log(`[ContentApprovalService] Approval request cancelled: ${requestId}`);

        return true;
    }
}