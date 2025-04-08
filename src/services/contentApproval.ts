import { IAgentRuntime } from "@elizaos/core";
import { ApprovalProvider } from "../approval/providers/base";
import { ApprovalRequest, ApprovalResponse } from "../approval/types";

export class ContentApprovalService {
    private runtime: IAgentRuntime;
    private providers: Map<string, ApprovalProvider>;

    constructor(runtime: IAgentRuntime, providers: ApprovalProvider[]) {
        this.runtime = runtime;
        this.providers = new Map();

        providers.forEach(provider => {
            this.providers.set(provider.providerName, provider);
        });
    }

    async sendForApproval(content: string, providerName: string): Promise<ApprovalResponse | null> {
        const provider = this.providers.get(providerName);
        if (!provider) {
            throw new Error(`Approval provider "${providerName}" not found.`);
        }

        const request: ApprovalRequest = {
            content,
            timestamp: new Date(),
        };

        return provider.sendForApproval(request);
    }

    async checkApprovalStatus(taskId: string, providerName: string): Promise<ApprovalResponse | null> {
        const provider = this.providers.get(providerName);
        if (!provider) {
            throw new Error(`Approval provider "${providerName}" not found.`);
        }

        return provider.checkApprovalStatus(taskId);
    }
}