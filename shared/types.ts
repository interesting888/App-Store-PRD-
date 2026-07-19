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
  country: string;
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

export interface CollectionAttempt {
  method: "import" | "rss" | "web-structured-data" | "cache" | "sample";
  status: "success" | "empty" | "failed" | "skipped";
  detail: string;
  count: number;
}

export interface CollectionReport {
  selectedSource?: ReviewSource;
  attempts: CollectionAttempt[];
  limitations: string[];
  reproducibility: string[];
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

export interface ReliabilityAssessment {
  score: number;
  level: "high" | "medium" | "low";
  reasons: string[];
  limitations: string[];
  generalizationChecks: Array<{
    name: string;
    status: "pass" | "warning" | "fail";
    detail: string;
  }>;
}

export interface EvaluationCriterion {
  id: string;
  title: string;
  status: "pass" | "warning" | "fail";
  summary: string;
  evidence: string[];
  improvement?: string;
}

export interface DeliveryEvaluation {
  overallStatus: "pass" | "warning" | "fail";
  criteria: EvaluationCriterion[];
}

export interface ChartSeries {
  title: string;
  type: "bar" | "metric";
  data: Array<{
    label: string;
    value: number;
    detail?: string;
  }>;
}

export interface VisualizationReport {
  charts: ChartSeries[];
  highlights: string[];
}

export interface WorkflowCheck {
  id: string;
  title: string;
  status: "pass" | "warning" | "fail";
  evidence: string;
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
  reliability?: ReliabilityAssessment;
  evaluation?: DeliveryEvaluation;
  visualization?: VisualizationReport;
  workflowVerification?: WorkflowCheck[];
  reportMarkdown?: string;
  revisions: string[];
  errors: string[];
  modelInfo: {
    provider: string;
    model: string;
    usedRuntimeModel: boolean;
    semanticTask: string;
    promptPolicy: string;
    fallbackReason?: string;
  };
  collectionReport?: CollectionReport;
}

export interface AnalyzeRequest {
  appUrl: string;
  goal: string;
  importData?: string;
  importFormat?: "json" | "csv";
  useSampleOnFailure?: boolean;
}
