export type StageStatus = "pending" | "running" | "done" | "warning" | "error";

export type ReviewSource = "live-rss" | "live-web" | "import" | "cache" | "sample";

export interface AppMetadata {
  appId: string;
  name: string;
  sellerName?: string;
  primaryGenreName?: string;
  averageUserRating?: number;
  userRatingCount?: number;
  version?: string;
  artworkUrl?: string;
  storeUrl: string;
}

export interface Review {
  id: string;
  rating: number;
  title: string;
  body: string;
  version?: string;
  date?: string;
  author?: string;
  country: string;
  source: ReviewSource;
}

export interface AnalysisScope {
  appId: string;
  country: "us";
  goal: string;
  ratingFilter?: number[];
  versionFilter?: string;
  focusHints: string[];
  notes: string[];
}

export interface CleaningReport {
  inputCount: number;
  outputCount: number;
  duplicateCount: number;
  invalidCount: number;
  filteredCount: number;
  ratingDistribution: Record<string, number>;
  versionDistribution: Record<string, number>;
}

export interface EvidenceSample {
  reviewId: string;
  rating: number;
  excerpt: string;
}

export interface Finding {
  id: string;
  title: string;
  userProblem: string;
  severity: "low" | "medium" | "high";
  confidence: number;
  supportCount: number;
  evidence: EvidenceSample[];
  conflictingEvidence: EvidenceSample[];
  modelGenerated: boolean;
  uncertainty: string;
}

export interface Requirement {
  id: string;
  version: string;
  priority: "P0" | "P1" | "P2";
  title: string;
  problem: string;
  requirement: string;
  acceptanceCriteria: string[];
  outOfScope: string[];
  sourceFindingIds: string[];
  sourceReviewIds: string[];
  evidenceType: "deterministic_stat" | "model_inference" | "mixed" | "hypothesis";
  uncertainty: string;
}

export interface TestCase {
  id: string;
  requirementId: string;
  title: string;
  preconditions: string[];
  steps: string[];
  expectedResult: string;
  linkedReviewIds: string[];
}

export interface TraceabilityIssue {
  level: "warning" | "error";
  message: string;
  objectId: string;
}

export interface PipelineStage {
  id: string;
  label: string;
  status: StageStatus;
  message: string;
  startedAt?: string;
  completedAt?: string;
}

export interface PipelineRun {
  runId: string;
  appUrl: string;
  createdAt: string;
  stages: PipelineStage[];
  metadata?: AppMetadata;
  scope?: AnalysisScope;
  rawReviews: Review[];
  cleanedReviews: Review[];
  cleaningReport?: CleaningReport;
  findings: Finding[];
  requirements: Requirement[];
  testCases: TestCase[];
  traceabilityIssues: TraceabilityIssue[];
  revisions: string[];
  errors: string[];
  modelInfo: {
    provider: string;
    model: string;
    usedRuntimeModel: boolean;
    fallbackReason?: string;
  };
}

export interface AnalyzeRequest {
  appUrl: string;
  goal: string;
  importData?: string;
  importFormat?: "json" | "csv";
  useSampleOnFailure?: boolean;
}
