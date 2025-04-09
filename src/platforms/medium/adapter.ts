import { IAgentRuntime, cleanJsonResponse, elizaLogger, parseJSONObjectFromText } from "@elizaos/core";
import { ContentPiece, ContentValidationResult, FormattedContent, Platform, PlatformAdapter, PlatformAdapterConfig, PublishResult } from "../../types";

export class MediumAdapter implements PlatformAdapter {
    platformId = "medium";
    platform = Platform.MEDIUM;
    contentFormats: ["article", "blog", "post"];
    capabilities = ["formatContent", "validateContent", "publishContent"];

    private runtime: IAgentRuntime;
    private apiKey: string;
    private authorId: string;
    private configured: boolean = false;

    async configure(config: PlatformAdapterConfig): Promise<void> {
        elizaLogger.debug("[MediumAdapter] Configuring Medium adapter");

        this.apiKey = config.apiKey as string;
        this.authorId = config.authorId as string;

        if (this.apiKey && this.authorId) {
            this.configured = true;
        }
    }

    async initialize(runtime: IAgentRuntime): Promise<void> {
        elizaLogger.debug("[MediumAdapter] Initializing Medium adapter");
        this.runtime = runtime;

        // Get configurations from environment if not already set
        if (!this.apiKey) {
            this.apiKey = this.runtime.getSetting("MEDIUM_API_KEY") || process.env.MEDIUM_API_KEY;
        }

        if (!this.authorId) {
            this.authorId = this.runtime.getSetting("MEDIUM_AUTHOR_ID") || process.env.MEDIUM_AUTHOR_ID;
        }

        if (this.apiKey && this.authorId) {
            this.configured = true;
            elizaLogger.log("[MediumAdapter] Medium adapter configured successfully");
        } else {
            elizaLogger.warn("[MediumAdapter] Medium adapter not fully configured");
        }
    }

    async validateContent(content: ContentPiece): Promise<ContentValidationResult> {
        elizaLogger.debug("[MediumAdapter] Validating content");

        if (!content.generatedContent) {
            return { isValid: false, errors: ["Content is empty"] };
        }

        try {
            // Parse content from JSON if possible
            const parsedContent = parseJSONObjectFromText(content.generatedContent);

            // Check required fields for Medium posts
            const errors = [];

            if (!parsedContent?.title) {
                errors.push("Medium post requires a title");
            }

            if (!parsedContent?.content) {
                errors.push("Medium post requires content");
            }

            return {
                isValid: errors.length === 0,
                errors: errors.length > 0 ? errors : undefined
            };
        }
        catch (error) {
            // If not JSON, assume raw Markdown content
            const rawContent = cleanJsonResponse(content.generatedContent);

            // Basic validation - try to extract title and check content length
            const titleMatch = rawContent.match(/^#\s+(.+)/m);

            if (!titleMatch) {
                return {
                    isValid: false,
                    errors: ["Medium post requires a title (formatted as '# Title')"]
                };
            }

            // Remove title and check if there's remaining content
            const contentWithoutTitle = rawContent.replace(/^#\s+(.+)/m, "").trim();

            if (contentWithoutTitle.length < 100) {
                return {
                    isValid: false,
                    errors: ["Medium post content is too short (minimum 100 characters)"]
                };
            }

            return { isValid: true };
        }
    }

    async formatContent(content: ContentPiece): Promise<FormattedContent> {
        elizaLogger.debug("[MediumAdapter] Formatting content");

        try {
            const rawContent = cleanJsonResponse(content.generatedContent);
            let mediumPost;

            // Try parsing as JSON first
            try {
                const parsedContent = parseJSONObjectFromText(rawContent);

                mediumPost = {
                    title: parsedContent.title,
                    contentFormat: parsedContent.contentFormat || "markdown",
                    content: parsedContent.content,
                    tags: parsedContent.tags || [],
                    publishStatus: parsedContent.publishStatus || "draft",
                    notifyFollowers: parsedContent.notifyFollowers || false
                };
            }
            catch (error) {
                // If not JSON, parse from Markdown
                const titleMatch = rawContent.match(/^#\s+(.+)/m);
                const title = titleMatch ? titleMatch[1] : "Untitled Post";

                // Extract tags if in the format <!-- tags: tag1, tag2 -->
                let tags = [];
                const tagsMatch = rawContent.match(/<!--\s*tags:\s*(.*?)\s*-->/);
                if (tagsMatch) {
                    tags = tagsMatch[1].split(',').map(tag => tag.trim());
                }

                // Clean up content - remove title and tags comment
                let cleanContent = rawContent
                    .replace(/^#\s+(.+)/m, "")
                    .replace(/<!--\s*tags:\s*(.*?)\s*-->/g, "")
                    .trim();

                mediumPost = {
                    title,
                    contentFormat: "markdown",
                    content: cleanContent,
                    tags,
                    publishStatus: "draft",
                    notifyFollowers: false
                };
            }

            const formattedContent = {
                ...content,
                formattedContent: mediumPost
            };

            return formattedContent;
        }
        catch (error) {
            elizaLogger.error(`[MediumAdapter] Error formatting content: ${error}`);
            throw error;
        }
    }

    async publishContent(content: FormattedContent): Promise<PublishResult> {
        elizaLogger.debug("[MediumAdapter] Publishing content");

        if (!this.configured) {
            return {
                success: false,
                timestamp: new Date(),
                error: "Medium adapter not properly configured with API key and author ID"
            };
        }

        try {
            // Medium API implementation
            const mediumPost = content.formattedContent;

            // API reference: https://github.com/Medium/medium-api-docs
            const response = await fetch(`https://api.medium.com/v1/users/${this.authorId}/posts`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify(mediumPost)
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Medium API error: ${response.status} ${response.statusText} - ${errorText}`);
            }

            const result = await response.json();

            return {
                success: true,
                publishedUrl: result.data.url,
                publishedId: result.data.id,
                timestamp: new Date(),
                platformId: result.data.id
            };
        }
        catch (error) {
            elizaLogger.error(`[MediumAdapter] Error publishing content: ${error}`);
            return {
                success: false,
                timestamp: new Date(),
                error: `Error publishing to Medium: ${error instanceof Error ? error.message : String(error)}`
            };
        }
    }

    async getPerformanceMetrics(contentId: string): Promise<any> {
        // Medium doesn't provide official API for metrics
        return {
            error: "Medium API doesn't provide performance metrics"
        };
    }

    async checkConnection(): Promise<boolean> {
        if (!this.configured) {
            return false;
        }

        try {
            // Check connection by fetching user details
            const response = await fetch(`https://api.medium.com/v1/me`, {
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                }
            });

            return response.ok;
        }
        catch (error) {
            elizaLogger.error(`[MediumAdapter] Connection check failed: ${error}`);
            return false;
        }
    }
}