import { elizaLogger, getProviders, IAgentRuntime, stringToUuid } from "@elizaos/core";
import { ApprovalProvider } from "../approval/base";
import { ApprovalRequest, ContentPiece, ApprovalStatus, Platform, MasterPlan, MicroPlan } from "../types";
import { ApprovalConfig } from "../environment";

// Constants for cache management
const CACHE_TTL_DAYS = 7; // Standardize on 7 days
const CACHE_KEY_PENDING = "pendingApprovals";

export class ContentApprovalService {
    private runtime: IAgentRuntime;
    private providers: Map<string, ApprovalProvider>;
    pendingApprovals: Map<string, ApprovalRequest<any>> = new Map();
    config: ApprovalConfig;

    constructor(runtime: IAgentRuntime, providers: ApprovalProvider[]) {
        this.runtime = runtime;
        this.providers = new Map();

        providers.forEach(provider => {
            this.providers.set(provider.providerName, provider);
        });
    }

    async initialize(approvalConfig: ApprovalConfig): Promise<void> {
        elizaLogger.debug("[ContentApprovalService] Initializing ContentApprovalService");

        this.config = approvalConfig;

        // Check if the service is enabled
        if (!approvalConfig.APPROVAL_ENABLED) {
            elizaLogger.warn("[ContentApprovalService] Content approval service is disabled.");
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
        setInterval(async () => {
            try {
                await this.checkAllPendingApprovals();
                await this.cleanupStaleApprovals();
            } catch (error) {
                elizaLogger.error(`[ContentApprovalService] Error during periodic check: ${error}`);
            }
        }, 2 * 60 * 1000); // Check every 2 minutes

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

        await this.runtime.cacheManager.set(
            CACHE_KEY_PENDING,
            serializedApprovals,
            { expires: expiresAt }
        );
    }

    getProvider(platform: Platform): ApprovalProvider | undefined {
        switch (platform) {
            case Platform.TWITTER:
                return this.providers.get("discord");
            // Map other platforms to the desired approval provider
            default:
                return undefined;
        }
    }

    async sendForApproval<T extends ContentPiece | MasterPlan | MicroPlan>(
        content: T,
        callback: Function
    ): Promise<ApprovalRequest<T>> {
        if (this.config.APPROVAL_AUTOAPPROVE) {
            elizaLogger.warn("[ContentApprovalService] Auto-approve is enabled. Skipping approval.");
            return {
                id: stringToUuid(`${content.id}-approval`),
                content: content,
                platform: "none",
                requesterId: this.runtime.agentId,
                timestamp: new Date(),
                status: ApprovalStatus.APPROVED,
                callback: callback,
            };
        }

        // Get a default provider
        let provider = Array.from(this.providers.values())[0];

        if (!provider) {
            elizaLogger.error("[ContentApprovalService] No approval provider registered.");
            return {
                id: stringToUuid(`${content.id}-approval`),
                content: content,
                platform: "none",
                requesterId: this.runtime.agentId,
                timestamp: new Date(),
                status: ApprovalStatus.FAILED,
                callback: callback,
            };
        }

        // Check content type and assign proper provider
        if ('topic' in content && 'format' in content) {
            // This is a content piece
            const _c = content as ContentPiece;
            provider = this.getProvider(_c.platform);

            if (!provider) {
                elizaLogger.error(`[ContentApprovalService] No approval provider found for platform ${content.platform}`);
                return {
                    id: stringToUuid(`${content.id}-approval`),
                    content: content,
                    platform: provider.providerName,
                    requesterId: this.runtime.agentId,
                    timestamp: new Date(),
                    status: ApprovalStatus.FAILED,
                    callback: callback,
                };
            }
        }

        const providerName = provider.providerName;

        // Check cache for a repeat request
        const cacheKey = `approval/${providerName}/${content.id}-approval`;
        const cachedRequest = await this.runtime.cacheManager.get<ApprovalRequest<T>>(cacheKey);

        if (cachedRequest) {
            return cachedRequest;
        }

        const request: ApprovalRequest<T> = {
            id: stringToUuid(`${content.id}-approval`),
            content: content,
            platform: providerName,
            requesterId: this.runtime.agentId,
            timestamp: new Date(),
            status: ApprovalStatus.PENDING,
            callback: callback,
        };

        await provider.submitForApproval(request);

        // Cache the individual request
        await this.runtime.cacheManager.set(
            cacheKey,
            request,
            { expires: Date.now() + (CACHE_TTL_DAYS * 24 * 60 * 60 * 1000) }
        );

        await this.addPendingApproval(request);

        return request;
    }

    async checkApprovalStatus<T extends ContentPiece | MasterPlan | MicroPlan>(request: ApprovalRequest<T>): Promise<ApprovalRequest<T>> {
        if (!this.pendingApprovals.has(request.id)) {
            elizaLogger.warn(`[ContentApprovalService] Approval request "${request.id}" not found.`);
            return request;
        }

        const provider = this.providers.get(request.platform);
        if (!provider) {
            elizaLogger.error(`[ContentApprovalService] Approval provider "${request.platform}" not found.`);
            const failedRequest = { ...request, status: ApprovalStatus.FAILED };
            await this.updateApprovalRequest(failedRequest);
            return failedRequest;
        }

        try {
            const status = await provider.checkApprovalStatus(request);

            if (status.status !== request.status) {
                await this.updateApprovalRequest(status);
            }

            return status;
        } catch (error) {
            elizaLogger.error(`[ContentApprovalService] Error checking approval status: ${error}`);
            return request;
        }
    }

    async registerProvider(provider: ApprovalProvider): Promise<void> {
        if (this.providers.has(provider.providerName)) {
            throw new Error(`[ContentApprovalService] Approval provider "${provider.providerName}" already registered.`);
        }

        this.providers.set(provider.providerName, provider);
    }

    async addPendingApproval(request: ApprovalRequest<any>): Promise<void> {
        if (this.pendingApprovals.has(request.id)) {
            elizaLogger.warn(`[ContentApprovalService] Approval request "${request.id}" already exists.`);
            return;
        }

        this.pendingApprovals.set(request.id, request);

        await this.savePendingApprovalsToCache();
    }

    async updateApprovalRequest(request: ApprovalRequest<any>): Promise<void> {
        if (!this.pendingApprovals.has(request.id)) {
            elizaLogger.warn(`[ContentApprovalService] Approval request "${request.id}" not found.`);
            return;
        }

        const finalStatuses = [ApprovalStatus.APPROVED, ApprovalStatus.REJECTED, ApprovalStatus.FAILED];

        if (finalStatuses.includes(request.status)) {
            this.pendingApprovals.delete(request.id);
        } else {
            this.pendingApprovals.set(request.id, request);
        }

        // Save updates to cache
        await this.savePendingApprovalsToCache();

        // Execute callback with error handling
        try {
            await request.callback(request);
        } catch (error) {
            elizaLogger.error(`[ContentApprovalService] Error executing callback for approval request ${request.id}: ${error}`);
        }

        elizaLogger.log(`[ContentApprovalService] Approval request updated: ${request.id} - Status: ${request.status}`);
    }

    private async cleanupStaleApprovals(): Promise<void> {
        const now = new Date();
        const staleThreshold = new Date(now.getTime() - (this.config.AUTO_REJECT_DAYS * 24 * 60 * 60 * 1000));

        for (const [id, request] of this.pendingApprovals.entries()) {
            if (request.timestamp < staleThreshold) {
                elizaLogger.warn(`[ContentApprovalService] Auto-rejecting stale approval request: ${id}`);

                const rejectedRequest = {
                    ...request,
                    status: ApprovalStatus.REJECTED
                };

                await this.updateApprovalRequest(rejectedRequest);
            }
        }
    }

    private async checkAllPendingApprovals() {
        const checkPromises = Array.from(this.pendingApprovals.values())
            .map(approval => this.checkApprovalStatus(approval));
        await Promise.all(checkPromises);
    }
}