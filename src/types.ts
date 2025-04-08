import { UUID, IAgentRuntime } from "@elizaos/core";

export enum Timeframe {
    DAILY = "daily",
    WEEKLY = "weekly",
    MONTHLY = "monthly",
    QUARTERLY = "quarterly"
}

export interface MasterPlan {
    id: UUID;
    title: string;
    goals: Goal[];
    contentMix: ContentMixItem[];
    audience: AudienceSegment[];
    brandVoice: BrandVoice;
    timeline: Timeline;
    version: number;
    approvalStatus: ApprovalStatus;
    created: Date;
    modified: Date;
}

export interface Goal {
    id: UUID;
    type: string; // awareness, conversion, education, etc.
    description: string;
    priority: number;
    kpis: KPI[];
    completionCriteria: string;
}

export interface KPI {
    metric: string;
    target: number;
}

export interface ContentMixItem {
    category: string;
    ratio: number; // percentage of content
    platforms: PlatformFormat[];
}

export interface PlatformFormat {
    name: string;
    format: string;
}

export interface AudienceSegment {
    segment: string;
    characteristics: string[];
    painPoints: string[];
}

export interface BrandVoice {
    tone: string;
    vocabulary: string[];
    prohibitedTerms: string[];
}

export interface Timeline {
    startDate: Date;
    endDate: Date;
    milestones: Milestone[];
}

export interface Milestone {
    date: Date;
    description: string;
}

export enum Platform {
    TWITTER = "twitter",
    DISCORD = "discord"
}

export enum ApprovalStatus {
    DRAFT = "draft",
    PENDING = "pending",
    APPROVED = "approved",
    REJECTED = "rejected",
    FAILED = "failed"
}

export interface MicroPlan {
    id: UUID;
    masterPlanId: UUID;
    period: { start: Date; end: Date };
    contentPieces: ContentPiece[];
    approvalStatus: ApprovalStatus;
    version: number;
    created: Date;
    modified: Date;
}

export interface ContentPiece {
    id: UUID;
    topic: string;
    format: string;
    platform: Platform;
    goalAlignment: UUID[]; // references to master plan goals
    scheduledDate: Date;
    keywords: string[];
    mediaRequirements: string[];
    brief: string;
    status: ContentStatus;
    generatedContent?: any;
    formattedContent?: any;
    platformId?: string; // optional, for tracking on specific platforms
}

export interface FormattedContent extends ContentPiece {
    formattedContent: any;
}

export enum ContentStatus {
    PLANNED = "planned",
    DRAFT = "draft",
    READY = "ready",
    PUBLISHED = "published",
    CANCELLED = "cancelled"
}

export interface NewsEvent {
    id: UUID;
    headline: string;
    source: string;
    publishDate: Date;
    summary: string;
    relevanceScore: number;
    keywords: string[];
    category: string;
    url: string;
    processingStatus: ProcessingStatus;
    created: Date;
}

export enum ProcessingStatus {
    NEW = "new",
    EVALUATED = "evaluated",
    INCORPORATED = "incorporated",
    IRRELEVANT = "irrelevant"
}

export interface TrendingTopic {
    id: UUID;
    name: string;
    platform: Platform;
    discoveryDate: Date;
    volume?: number;
    growthRate?: number;
    relevanceScore?: number;
    relatedKeywords?: string[];
    processingStatus: ProcessingStatus;
    created?: Date;
}

export interface ContentDecision {
    id: UUID;
    timestamp: Date;
    contentToCreate: ContentDecisionItem[];
    context: DecisionContext;
    decisionRationale: string;
}

export interface ContentDecisionItem {
    contentType: string;
    topic: string;
    platform: string;
    timing: string; // immediate, scheduled date
    priority: number;
    isPlanned: boolean;
    reasonForSelection: string;
    relevantNews: UUID[];
    relevantTrends: UUID[];
    relevantGoals: UUID[];
}

export interface DecisionContext {
    evaluatedNews: UUID[];
    evaluatedTrends: UUID[];
    evaluatedPlans: UUID[];
    temporalContext?: {
        dayOfWeek: string;
        timeOfDay: string;
        upcomingEvents: string[];
    };
}

export interface ProgressEvaluation {
    id: UUID;
    masterPlanId: UUID;
    evaluationDate: Date;
    goals: GoalProgress[];
    overallProgress: number; // percentage
    nextEvaluationDate: Date;
}

export interface GoalProgress {
    goalId: UUID;
    status: GoalStatus;
    completionPercentage: number;
    contentContributing: UUID[]; // content IDs
    recommendedActions: string[];
}

export enum GoalStatus {
    PENDING = "pending",
    IN_PROGRESS = "in_progress",
    COMPLETE = "complete"
}

// Platform integration types
export interface PublishResult {
    success: boolean;
    publishedUrl?: string;
    publishedId?: string;
    timestamp: Date;
    error?: string;
    platformId?: string;
}

export interface PerformanceMetrics {
    impressions?: number;
    engagements?: number;
    clicks?: number;
    conversions?: number;
    shares?: number;
    comments?: number;
    [key: string]: number;
}

export interface PlatformAdapterConfig {
    apiKey?: string;
    apiEndpoint?: string;
    timeout?: number;
    retryAttempts?: number;
    debug?: boolean;
    accountId?: string;
    [key: string]: any;
}

export interface ContentValidationResult {
    isValid: boolean;
    errors?: string[];
    warnings?: string[];
}

export interface PlatformAdapter {
    platformId: string;
    platformName: string;
    capabilities: string[];

    // Initialization
    initialize(runtime: IAgentRuntime): Promise<void>;

    // Configuration
    configure(config: PlatformAdapterConfig): void;

    // Content handling
    validateContent(content: ContentPiece): Promise<ContentValidationResult>;
    formatContent(content: ContentPiece): Promise<ContentPiece>;
    publishContent(content: ContentPiece): Promise<PublishResult>;

    // Content lifecycle management
    updateContent?(contentId: string, updatedContent: ContentPiece): Promise<PublishResult>;
    deleteContent?(contentId: string): Promise<boolean>;

    // Analytics
    getPerformanceMetrics(contentId: string): Promise<PerformanceMetrics>;
    getAudienceInsights?(contentId: string): Promise<AudienceInsight[]>;

    // Trends and news
    getTrends?(opts?: { contentId?: string; filter?: string; }): Promise<TrendingTopic[]>;
    getNews?(opts?: { contentId?: string; filter?: string; }): Promise<NewsEvent[]>;

    // Status
    checkConnection(): Promise<boolean>;
}

export interface AudienceInsight {
    type: string;
    value: number | string;
    segment?: string;
    confidence: number;
}

export interface AdapterRegistration {
    adapter: PlatformAdapter;
    platform: Platform;
    enabled: boolean;
    priority?: number;
}

export interface ApprovalRequest {
    id: UUID;
    content: ContentPiece;
    platform: string;
    requesterId: string;
    timestamp: Date;
    status: ApprovalStatus;
    comments?: string;
    approverId?: string;
    callback: Function;
}

export interface ApprovalRequestStatus {
    requestId: string;
    status: ApprovalStatus;
    timestamp: Date;
}