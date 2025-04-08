# Core Data Structures

This document outlines the fundamental data structures that form the foundation of the AI Content Agent System. These structures define how content strategy, plans, and performance data are represented within the system.

## Master Plan

The Master Plan represents the high-level content strategy and serves as the north star for all system activities.

```
masterPlan = {
  id: String,
  title: String,
  goals: [{
    id: String,
    type: String, // awareness, conversion, education, etc.
    description: String,
    priority: Number,
    kpis: [{ metric: String, target: Number }],
    completionCriteria: String
  }],
  contentMix: [{
    category: String,
    ratio: Number, // percentage of content
    platforms: [{ name: String, format: String }]
  }],
  audience: [{
    segment: String,
    characteristics: [String],
    painPoints: [String]
  }],
  brandVoice: {
    tone: String,
    vocabulary: [String],
    prohibitedTerms: [String]
  },
  timeline: {
    startDate: Date,
    endDate: Date,
    milestones: [{ date: Date, description: String }]
  },
  version: Number,
  approvalStatus: String,
  created: Date,
  modified: Date
}
```

## Micro Plan

Micro Plans are short-term tactical plans derived from the Master Plan that guide specific content creation activities.

```
microPlan = {
  id: String,
  masterPlanId: String,
  period: { start: Date, end: Date },
  contentPieces: [{
    id: String,
    topic: String,
    format: String,
    platform: String,
    goalAlignment: [String], // references to master plan goals
    scheduledDate: Date,
    keywords: [String],
    mediaRequirements: [String],
    brief: String,
    status: String
  }],
  approvalStatus: String,
  version: Number,
  created: Date,
  modified: Date
}
```

## Content Piece

Individual content items created and published by the system.

```
contentPiece = {
  id: String,
  microPlanId: String,
  type: String, // tweet, thread, blog post
  status: String, // draft, approved, published
  isPlanned: Boolean, // from plan or opportunistic
  title: String,
  body: String,
  media: [{ type: String, url: String, altText: String }],
  metadata: {
    platform: String,
    publishDate: Date,
    tags: [String],
    targetAudience: [String]
  },
  analytics: {
    impressions: Number,
    engagements: Number,
    conversions: Number,
    likes: Number,
    retweets: Number,
    reposts: Number,
    clicks: Number,
    comments: Number,
    // platform-specific metrics
  },
  goalContributions: [{
    goalId: String,
    contributionWeight: Number
  }],
  created: Date,
  modified: Date,
  published: Date
}
```

## Brand Guidelines

Comprehensive brand guidance that informs content creation decisions.

```
brandGuidelines = {
  id: String,
  version: Number,
  visualIdentity: {
    colors: [{ name: String, hex: String, usage: String }],
    typography: [{ font: String, usage: String }],
    imageStyle: [String]
  },
  voiceAndTone: {
    personality: String,
    tonalAttributes: [String], // friendly, authoritative, etc.
    vocabulary: {
      preferred: [String],
      avoided: [String],
      prohibited: [String]
    },
    examples: [{ context: String, sample: String }]
  },
  contentParameters: {
    preferredTopics: [String],
    avoidedTopics: [String],
    requiredDisclosures: [String],
    formatGuidelines: [{ platform: String, rules: [String] }]
  },
  created: Date,
  modified: Date
}
```

## External Inputs

Structures for real-time data that influences content decisions.

### News Event

```
newsEvent = {
  id: String,
  headline: String,
  source: String,
  publishDate: Date,
  summary: String,
  relevanceScore: Number, // calculated for brand alignment
  keywords: [String],
  category: String,
  url: String,
  processingStatus: String, // new, evaluated, incorporated, irrelevant
  created: Date
}
```

### Trending Topic

```
trendingTopic = {
  id: String,
  name: String,
  platform: String,
  discoveryDate: Date,
  volume: Number,
  growthRate: Number,
  relevanceScore: Number,
  relatedKeywords: [String],
  processingStatus: String,
  created: Date
}
```

## LLM Decision

Structure representing the output of the LLM decision engine.

```
contentDecision = {
  id: String,
  timestamp: Date,
  contentToCreate: [{
    contentType: String,
    topic: String,
    platform: String,
    timing: String, // immediate, scheduled date
    priority: Number,
    isPlanned: Boolean, // was this in the original plan
    reasonForSelection: String,
    relevantNews: [String], // if applicable
    relevantTrends: [String], // if applicable
    relevantGoals: [String] // tied to master plan
  }],
  context: {
    evaluatedNews: [String], // news IDs considered
    evaluatedTrends: [String], // trend IDs considered
    evaluatedPlans: [String], // plan IDs considered
  },
  decisionRationale: String
}
```

## Progress Evaluation

Structure representing goal progress assessments.

```
progressEvaluation = {
  id: String,
  masterPlanId: String,
  evaluationDate: Date,
  goals: [{
    goalId: String,
    status: String, // complete, in-progress, pending
    completionPercentage: Number,
    contentContributing: [String], // content IDs
    recommendedActions: [String]
  }],
  overallProgress: Number, // percentage
  nextEvaluationDate: Date
}
```

These data structures provide a comprehensive foundation for storing and manipulating all the information required for autonomous content management. They enable the system to maintain strategic alignment while adapting to real-time opportunities.