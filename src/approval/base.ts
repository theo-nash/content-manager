import { IAgentRuntime, UUID } from "@elizaos/core";
import { ApprovalRequest, ApprovalStatus } from "../types";

/**
 * Interface for content approval providers
 */
export interface ApprovalProvider {
    /**
     * Unique name of the provider
     */
    providerName: string;

    /**
     * Initialize the provider with runtime
     */
    initialize(runtime: IAgentRuntime): Promise<void>;

    /**
     * Submit content for approval
     * @returns The request ID or null if submission failed
     */
    submitForApproval(request: ApprovalRequest): Promise<void>;

    /**
     * Check the status of an approval request
     */
    checkApprovalStatus(request: ApprovalRequest): Promise<ApprovalRequest>;

    /**
     * Clean up resources for a request after processing
     */
    cleanupRequest(requestId: string): Promise<void>;

}