import { elizaLogger } from "@elizaos/core";
import {
    Platform,
    PlatformAdapter,
    PlatformAdapterConfig,
    AdapterRegistration,
} from "../types";

export class AdapterProvider {
    private adapterRegistry: Map<Platform, AdapterRegistration> = new Map();
    private isInitialized: boolean = false;

    async initialize(): Promise<void> {
        if (this.isInitialized) {
            elizaLogger.debug("[AdapterProvider] AdapterProvider is already initialized");
            return;
        }
        elizaLogger.debug("[AdapterProvider] Initializing AdapterProvider");
        this.isInitialized = true;
    }

    registerAdapter(adapter: PlatformAdapter, config?: PlatformAdapterConfig): void {
        elizaLogger.debug(`[AdapterProvider] Registering adapter for platform: ${adapter.platform}`);

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
     * Get registered adapter for a specific platform
     */
    getAdapter(platform: Platform): PlatformAdapter | undefined {
        const registration = this.adapterRegistry.get(platform);
        if (!registration) {
            elizaLogger.error(`[AdapterProvider] No adapter registered for platform: ${platform}`);
            return undefined;
        }
        return registration?.enabled ? registration.adapter : undefined;
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
     * Get all registered adapters
     */
    getAllAdapters(): PlatformAdapter[] {
        const adapters: PlatformAdapter[] = [];
        for (const registration of this.adapterRegistry.values()) {
            if (registration.enabled) {
                adapters.push(registration.adapter);
            }
        }
        return adapters;
    }

    /**
     * Check health status for all registered platforms
     */
    async checkPlatformConnections(): Promise<Record<Platform, boolean>> {
        elizaLogger.debug("[AdapterProvider] Checking platform connections");
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