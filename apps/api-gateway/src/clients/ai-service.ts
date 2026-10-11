// Synchronous HTTP client for ai-service. Writing goes async via BullMQ, but
// placement is one-shot onboarding, so the caller waits for the profile.
import { currentRequestId, REQUEST_ID_HEADER } from "../observability/request-context";
import { AppError } from "../plugins/error-envelope";

export interface CefrDimension {
	level: string | null;
	source: string; // "assessed" | "proxy" | "pending"
	note: string | null;
}

export interface CefrProfileDto {
	learner_profile_id: string;
	placement_completed: boolean;
	speaking: CefrDimension;
	listening: CefrDimension;
	reading: CefrDimension;
	writing: CefrDimension;
}

export interface EvaluatePlacementInput {
	learnerProfileId: string;
	examType: string;
	// Only the id travels — ai-service reads the prompt from the exam config, so
	// no caller can pick the task it's scored on.
	taskId: string;
	essayText: string;
}

export interface PlacementTaskDto {
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

export interface DimensionPriorityDto {
	dimension: string;
	priority: number;
	overdue_ratio: number;
	skill_gap: number;
	volatility: number;
	days_since_practice: number | null;
	interval_days: number;
}

export interface SrsScheduleDto {
	learner_profile_id: string;
	language: string;
	next_dimension: string;
	next_priority: number;
	schedule: DimensionPriorityDto[];
}

export interface PersonaDto {
	persona: string;
	display_name: string;
	description: string;
	socratic_enabled: boolean;
	pro_only: boolean;
}

export interface DailySessionExercise {
	item: string;
	focus: string;
}

export interface DailySessionDto {
	session_id: string;
	session_date: string;
	skill_targeted: string;
	srs_priority_score: number;
	session_content: {
		type: string;
		prompt: string;
		exercises: DailySessionExercise[];
		estimated_duration_minutes: number;
	};
	pre_session_score: number;
	generated: boolean;
}

export interface LessonSessionDto {
	lesson_session_id: string;
	topic: string | null;
	started_at: string;
}

export interface AiServiceClient {
	evaluatePlacement(input: EvaluatePlacementInput): Promise<CefrProfileDto>;
	getPlacementTask(examType: string): Promise<PlacementTaskDto>;
	getCefrProfile(learnerProfileId: string): Promise<CefrProfileDto>;
	getSrsSchedule(learnerProfileId: string): Promise<SrsScheduleDto>;
	listPersonas(): Promise<PersonaDto[]>;
	generateDailySession(learnerProfileId: string): Promise<DailySessionDto>;
	startLesson(learnerProfileId: string, topic?: string): Promise<LessonSessionDto>;
	streamChat(
		learnerProfileId: string,
		lessonSessionId: string,
		message: string,
	): Promise<ReadableStream<Uint8Array>>;
	listExams(): Promise<ExamPreview[]>;
}

export function createAiServiceClient(baseUrl: string): AiServiceClient {
	const base = baseUrl.replace(/\/$/, "");

	async function toJson<T>(res: Response): Promise<T> {
		if (res.ok) return (await res.json()) as T;
		// ai-service speaks the same envelope — re-raise as AppError to keep one shape.
		let code = "UPSTREAM_ERROR";
		let message = `ai-service responded ${res.status}`;
		try {
			const body = (await res.json()) as { error?: { code?: string; message?: string } };
			if (body.error?.code) code = body.error.code;
			if (body.error?.message) message = body.error.message;
		} catch {
			// non-JSON error body — keep the defaults
		}
		// Upstream 5xx reads as a bad gateway; a 4xx is the caller's input, so it passes.
		throw new AppError(res.status >= 500 ? 502 : res.status, code, message);
	}

	// The caller's request id travels with every call, so ai-service logs under the same id.
	function headers(): Record<string, string> {
		const requestId = currentRequestId();
		return {
			"content-type": "application/json",
			...(requestId ? { [REQUEST_ID_HEADER]: requestId } : {}),
		};
	}

	async function call<T>(path: string, init: RequestInit): Promise<T> {
		let res: Response;
		try {
			res = await fetch(`${base}${path}`, { ...init, headers: headers() });
		} catch {
			// DNS/connection/timeout — the service is down, not a client error.
			throw new AppError(502, "AI_SERVICE_UNREACHABLE", "evaluation service is unavailable");
		}
		return toJson<T>(res);
	}

	return {
		evaluatePlacement(input) {
			return call<CefrProfileDto>("/api/v1/placement/evaluate", {
				method: "POST",
				body: JSON.stringify({
					learner_profile_id: input.learnerProfileId,
					exam_type: input.examType,
					task_id: input.taskId,
					essay_text: input.essayText,
				}),
			});
		},
		getPlacementTask(examType) {
			return call<PlacementTaskDto>(`/api/v1/placement/task/${examType}`, { method: "GET" });
		},
		getSrsSchedule(learnerProfileId) {
			return call<SrsScheduleDto>(
				`/api/v1/adaptive/srs-next?learner_profile_id=${encodeURIComponent(learnerProfileId)}`,
				{ method: "GET" },
			);
		},
		getCefrProfile(learnerProfileId) {
			return call<CefrProfileDto>(`/api/v1/placement/profile/${learnerProfileId}`, {
				method: "GET",
			});
		},
		generateDailySession(learnerProfileId) {
			return call<DailySessionDto>("/api/v1/mentor/daily-diagnostic", {
				method: "POST",
				body: JSON.stringify({ learner_profile_id: learnerProfileId }),
			});
		},
		startLesson(learnerProfileId, topic) {
			return call<LessonSessionDto>("/api/v1/mentor/lesson", {
				method: "POST",
				body: JSON.stringify({ learner_profile_id: learnerProfileId, topic: topic ?? null }),
			});
		},
		async streamChat(learnerProfileId, lessonSessionId, message) {
			// Deliberately not call(): that awaits res.json() and would buffer
			// the whole reply, which is the one thing streaming exists to avoid.
			let res: Response;
			try {
				res = await fetch(`${base}/api/v1/mentor/chat`, {
					method: "POST",
					headers: headers(),
					body: JSON.stringify({
						learner_profile_id: learnerProfileId,
						lesson_session_id: lessonSessionId,
						message,
					}),
				});
			} catch {
				throw new AppError(502, "AI_SERVICE_UNREACHABLE", "evaluation service is unavailable");
			}
			if (!res.ok || !res.body) {
				return toJson<never>(res);
			}
			return res.body;
		},
		listPersonas() {
			// Proxied rather than duplicated here so the tier gate and the persona
			// copy have one owner (same rule as listExams below).
			return call<PersonaDto[]>("/api/v1/personas", { method: "GET" });
		},
		listExams() {
			// Proxied from the exam YAMLs rather than duplicated as a frontend list,
			// so the selector tracks exams being added or quarantined (ADR 0003).
			return call<ExamPreview[]>("/api/v1/writing-eval/exams", { method: "GET" });
		},
	};
}
