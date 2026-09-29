// Response DTOs in the gateway's exact snake_case shapes — no translation
// layer, so a gateway change lands as one obvious diff against this file.

export interface PublicUser {
	id: string;
	email: string;
	display_name: string;
	role: string;
	subscription_tier: "free" | "pro";
	learner_profile_id: string;
	target_language: string;
	target_exam: string | null;
}

export interface AuthSession {
	access_token: string;
	user: PublicUser;
}

export interface UserProfile extends PublicUser {
	accent_target: string;
	default_persona: "companion" | "coach" | "examiner";
	active_track: "fluency" | "exam";
	cefr_speaking: string | null;
	cefr_listening: string | null;
	cefr_reading: string | null;
	cefr_writing: string | null;
}

export type CefrSource = "assessed" | "proxy" | "pending";

export interface CefrDimension {
	level: string | null;
	source: CefrSource;
	note: string | null;
}

export interface CefrProfile {
	learner_profile_id: string;
	placement_completed: boolean;
	speaking: CefrDimension;
	listening: CefrDimension;
	reading: CefrDimension;
	writing: CefrDimension;
}

/** The placement essay task. Server-owned: the client renders `prompt_text` but
 * only ever sends `task_id` back, so it can't choose what it's scored on. */
export interface PlacementTask {
	exam_type: string;
	display_name: string;
	task_name: string;
	task_id: string;
	prompt_text: string;
	word_count_min: number;
}

export interface ExamRubricCategory {
	key: string;
	name: string;
	weight: string;
}

export interface ExamPreview {
	exam_id: string;
	display_name: string;
	language: string;
	task_name: string;
	categories: ExamRubricCategory[];
}

export type WritingSessionStatus =
	"pending" | "processing" | "scored" | "failed" | "awaiting_calibration";

export interface WritingCategoryScore {
	name: string;
	// NUMERIC(4,2) stays a string end-to-end — parseFloat reintroduces drift.
	score: string;
	weight: string;
	feedback: string | null;
}

export interface GrammarCorrection {
	original: string;
	correction: string;
	explanation: string;
}

export interface VocabularySuggestion {
	original: string;
	suggestion: string;
	reason: string;
}

export interface WritingResult {
	session_id: string;
	status: WritingSessionStatus;
	calibrated?: boolean;
	message?: string;
	exam_type?: string;
	word_count?: number | null;
	overall_band_score?: string | null;
	cefr_level?: string | null;
	calibration_version?: string | null;
	// The baseline this score was produced under — not the current
	// one, so an older score never borrows a newer correlation.
	calibration_sample_count?: number | null;
	calibration_correlation?: string | null;
	submitted_at?: string;
	scored_at?: string | null;
	categories?: WritingCategoryScore[];
	grammar_corrections?: GrammarCorrection[];
	vocabulary_suggestions?: VocabularySuggestion[];
}

/** GET /api/v1/writing/calibration — current baseline for the
 * learner's target exam. `calibrated: false` is an answer, not a failure. */
export interface CalibrationMetadata {
	exam_type: string;
	calibrated: boolean;
	calibration_version?: string;
	sample_count?: number;
	overall_pearson?: string;
	calibration_date?: string;
}

export type AppealStatus = "pending" | "processing" | "resolved" | "failed";

export interface AppealResult {
	appeal_id: string;
	status: AppealStatus;
	writing_session_id: string;
	original_score: string;
	secondary_score?: string | null;
	discrepancy_delta?: string | null;
	requires_human_review?: boolean;
	created_at: string;
	resolved_at?: string | null;
	message?: string;
}

/** The {error:{code,message,field?}} shape every gateway/ai-service error
 * response shares — thrown as ApiError by the client below. */
export interface ErrorEnvelope {
	error: { code: string; message: string; field?: string };
}
