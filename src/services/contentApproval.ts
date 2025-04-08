import { elizaLogger, getProviders, IAgentRuntime, stringToUuid } from "@elizaos/core";
import { ApprovalProvider } from "../approval/base";
import { ApprovalRequest, ContentPiece, ApprovalStatus, Platform } from "../types";

export class ContentApprovalService {
    private runtime: IAgentRuntime;
    private providers: Map<string, ApprovalProvider>;
    pendingApprovals: Map<string, ApprovalRequest> = new Map();

    constructor(runtime: IAgentRuntime, providers: ApprovalProvider[]) {
        this.runtime = runtime;
        this.providers = new Map();

        providers.forEach(provider => {
            this.providers.set(provider.providerName, provider);
        });
    }

    async initialize(): Promise<void> {
        elizaLogger.debug("[ContentApprovalService] Initializing ContentApprovalService");

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
        const cachedApprovals = await this.runtime.cacheManager.get<Map<string, ApprovalRequest>>("pendingApprovals");
        if (cachedApprovals) {
            this.pendingApprovals = cachedApprovals;
        }

        // Check all pending approvals
        await this.checkAllPendingApprovals();

        // Set up a periodic check for pending approvals
        setInterval(async () => {
            try {
                await this.checkAllPendingApprovals();
            } catch (error) {
                elizaLogger.error(`[ContentApprovalService] Error during periodic check: ${error}`);
            }
        }, 2 * 60 * 1000); // Check every 2 minutes

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

    async sendForApproval(content: ContentPiece, callback: Function): Promise<ApprovalRequest> {
        const provider = this.getProvider(content.platform);

        if (!provider) {
            elizaLogger.error(`[ContentApprovalService] No approval provider found for platform ${content.platform}`);
            return {
                id: stringToUuid(`${content.id}-approval`),
                content: content,
                platform: content.platform,
                requesterId: this.runtime.agentId,
                timestamp: new Date(),
                status: ApprovalStatus.FAILED,
                callback: callback,
            };
        }

        const providerName = provider.providerName;

        // Check cache for a repeat request
        const cacheKey = `approval/${providerName}/${content.id}-approval`;
        const cachedRequest = await this.runtime.cacheManager.get<ApprovalRequest>(cacheKey);

        if (cachedRequest) {
            return cachedRequest;
        }

        if (!provider) {
            throw new Error(`[ContentApprovalService] Approval provider "${providerName}" not found.`);
        }

        const request: ApprovalRequest = {
            id: stringToUuid(`${content.id}-approval`),
            content: content,
            platform: providerName,
            requesterId: this.runtime.agentId,
            timestamp: new Date(),
            status: ApprovalStatus.PENDING,
            callback: callback,
        };

        await provider.submitForApproval(request);

        await this.addPendingApproval(request);

        return request;
    }

    async checkApprovalStatus(request: ApprovalRequest): Promise<ApprovalRequest> {
        if (!this.pendingApprovals.has(request.id)) {
            elizaLogger.warn(`[ContentApprovalService] Approval request "${request.id}" not found.`);
            return request;
        }

        const provider = this.providers.get(request.platform);
        if (!provider) {
            throw new Error(`[ContentApprovalService] Approval provider "${request.platform}" not found.`);
        }

        const status = await provider.checkApprovalStatus(request);

        if (status.status === ApprovalStatus.APPROVED) {
            await this.handleApprovedRequest(status);
        }

        if (status.status !== request.status) {
            await this.updateApprovalRequest(status);
        }

        return status;
    }

    async registerProvider(provider: ApprovalProvider): Promise<void> {
        if (this.providers.has(provider.providerName)) {
            throw new Error(`[ContentApprovalService] Approval provider "${provider.providerName}" already registered.`);
        }

        this.providers.set(provider.providerName, provider);
    }

    async addPendingApproval(request: ApprovalRequest): Promise<void> {
        if (this.pendingApprovals.has(request.id)) {
            elizaLogger.warn(`[ContentApprovalService] Approval request "${request.id}" already exists.`);
            return;
        }

        this.pendingApprovals.set(request.id, request);

        // Update the cache with the current pending approval map
        this.runtime.cacheManager.set(
            `pendingApprovals`,
            this.pendingApprovals,
            { expires: Date.now() + 60 * 60 * 1000 * 24 } // 24 hour TTL
        )
    }

    async handleApprovedRequest(request: ApprovalRequest): Promise<void> {
        if (request.status != ApprovalStatus.APPROVED) {
            elizaLogger.warn(`Approval request "${request.id}" is not approved.`);
            return;
        }

        await request.callback(request);

        elizaLogger.log(`[ContentApprovalService] Approval request handled: ${request.id}`);

        if (this.pendingApprovals.has(request.id)) {
            this.pendingApprovals.delete(request.id);
        }

        // Update the cache with the current pending approval map
        this.runtime.cacheManager.set(
            `pendingApprovals`,
            this.pendingApprovals,
            { expires: Date.now() + 60 * 60 * 1000 * 24 } // 24 hour TTL
        )
    }

    async updateApprovalRequest(request: ApprovalRequest): Promise<void> {
        if (!this.pendingApprovals.has(request.id)) {
            elizaLogger.warn(`Approval request "${request.id}" not found.`);
            return;
        }

        if (request.status === ApprovalStatus.APPROVED) {
            await this.runtime.cacheManager.delete(`approval/${request.platform}/${request.id}`);
            this.pendingApprovals.delete(request.id);
            return;
        }

        this.pendingApprovals.set(request.id, request);
    }

    private async checkAllPendingApprovals() {
        const checkPromises = Array.from(this.pendingApprovals.values())
            .map(approval => this.checkApprovalStatus(approval));
        await Promise.all(checkPromises);
    }
}