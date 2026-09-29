// Gateway side of the writing lifecycle: insert the session row the worker
// re-reads, enqueue a pointer job, read results. Scoring lives in ai-service.
import type { DbClient } from "../../db/client";
import { AppError } from "../../plugins/error-envelope";
import {
	type AppealEvalQueue,
	enqueueAppealEval,
	enqueueWritingEval,
	type WritingEvalQueue,
} from "../../queue/bullmq-client";

export interface WritingDeps {
	db: DbClient;
	queue: WritingEvalQueue;
}

export interface SubmitInput {
	learnerProfileId: string;
	examType: string;
	promptText: string;
	essayText: string;
}

export interface WritingCategory {
	name: string;
	score: string;
	weight: string;
	feedback: string | null;
}

export interface WritingResult {
	session_id: string;
	status: string;
	calibrated?: boolean;
	// Explains a withheld score (status "awaiting_calibration") to the user.
	message?: string;
	exam_type?: string;
	word_count?: number | null;
	overall_band_score?: string | null;
	cefr_level?: string | null;
	calibration_version?: string | null;
	calibration_sample_count?: number | null;
	calibration_correlation?: string | null;
	submitted_at?: string;
	scored_at?: string | null;
	categories?: WritingCategory[];
	grammar_corrections?: unknown;
	vocabulary_suggestions?: unknown;
}

/** What PRD §21.3 puts in front of the learner: how well the AI agreed with
 * human graders, and over how many essays. */
export interface CalibrationMetadata {
	exam_type: string;
	calibrated: boolean;
	calibration_version?: string;
	sample_count?: number;
	overall_pearson?: string;
	calibration_date?: string;
}

export function countWords(text: string): number {
	return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Current baseline for the learner's target exam (PRD §35.4). Uncalibrated is
 * a real answer here, not an error — it's what the trust banner reports. */
export async function getCalibrationMetadata(
	db: DbClient,
	learnerProfileId: string,
): Promise<CalibrationMetadata> {
	const { rows: profileRows } = await db.query(
		`SELECT target_exam FROM learner_profiles WHERE id = $1`,
		[learnerProfileId],
	);
	const targetExam = profileRows[0]?.target_exam;
	if (!targetExam) {
		throw new AppError(400, "NO_TARGET_EXAM", "set a target exam to see its calibration status");
	}

	const { rows } = await db.query(
		`SELECT calibration_version, sample_count, overall_pearson, calibration_date
		 FROM calibration_baselines
		 WHERE exam_type = $1 AND displayed_on_reports = true
		 ORDER BY calibration_date DESC
		 LIMIT 1`,
		[targetExam],
	);
	const row = rows[0];
	if (!row) return { exam_type: String(targetExam), calibrated: false };

	const calibrationDate =
		row.calibration_date instanceof Date
			? row.calibration_date.toISOString()
			: String(row.calibration_date);

	return {
		exam_type: String(targetExam),
		calibrated: true,
		calibration_version: String(row.calibration_version),
		sample_count: row.sample_count as number,
		overall_pearson: String(row.overall_pearson),
		calibration_date: calibrationDate,
	};
}

export async function submitWriting(
	deps: WritingDeps,
	input: SubmitInput,
): Promise<{ sessionId: string }> {
	const insert = await deps.db.query(
		`INSERT INTO writing_sessions
			(learner_profile_id, exam_type, prompt_text, essay_text, word_count)
		 VALUES ($1, $2, $3, $4, $5)
		 RETURNING id`,
		[
			input.learnerProfileId,
			input.examType,
			input.promptText,
			input.essayText,
			countWords(input.essayText),
		],
	);
	const sessionId = String(insert.rows[0].id);

	try {
		await enqueueWritingEval(deps.queue, sessionId, input.examType);
	} catch (err) {
		// Redis down: mark it failed rather than strand the row pending forever.
		await deps.db.query(`UPDATE writing_sessions SET status = 'failed' WHERE id = $1`, [sessionId]);
		throw err;
	}

	return { sessionId };
}

export async function getWritingResult(
	deps: WritingDeps,
	sessionId: string,
	learnerProfileId: string,
	enforceCalibrationGate: boolean,
): Promise<WritingResult | null> {
	// Ownership in the WHERE clause: someone else's session reads as 404.
	const { rows } = await deps.db.query(
		`SELECT ws.id, ws.status, ws.exam_type, ws.word_count, ws.overall_band_score,
				ws.cefr_level, ws.calibration_version, ws.submitted_at, ws.scored_at,
				b.category_1_name, b.category_1_score, b.category_1_weight, b.category_1_feedback,
				b.category_2_name, b.category_2_score, b.category_2_weight, b.category_2_feedback,
				b.category_3_name, b.category_3_score, b.category_3_weight, b.category_3_feedback,
				b.category_4_name, b.category_4_score, b.category_4_weight, b.category_4_feedback,
				b.grammar_corrections, b.vocabulary_suggestions,
				cb.sample_count, cb.overall_pearson
		 FROM writing_sessions ws
		 LEFT JOIN writing_score_breakdowns b ON b.writing_session_id = ws.id
		 LEFT JOIN calibration_baselines cb
			ON cb.calibration_version = ws.calibration_version AND cb.exam_type = ws.exam_type
		 WHERE ws.id = $1 AND ws.learner_profile_id = $2`,
		[sessionId, learnerProfileId],
	);
	if (rows.length === 0) return null;

	const row = rows[0];
	const status = String(row.status);
	if (status !== "scored") {
		return { session_id: sessionId, status };
	}

	const submittedAt =
		row.submitted_at instanceof Date ? row.submitted_at.toISOString() : String(row.submitted_at);
	const scoredAt =
		row.scored_at == null
			? null
			: row.scored_at instanceof Date
				? row.scored_at.toISOString()
				: String(row.scored_at);

	// Phase 0 gate (Calibration Brief §9, PRD §21.3): a band scored with no active
	// baseline isn't exam-valid, so withhold it rather than imply it's trustworthy.
	const calibrated = row.calibration_version != null;
	if (!calibrated && enforceCalibrationGate) {
		return {
			session_id: sessionId,
			status: "awaiting_calibration",
			calibrated: false,
			exam_type: row.exam_type as string,
			word_count: row.word_count as number | null,
			submitted_at: submittedAt,
			scored_at: scoredAt,
			message:
				"Your response was evaluated, but AI scoring for this exam has not yet passed " +
				"Phase 0 calibration, so a band score is withheld.",
		};
	}

	const categories: WritingCategory[] = [];
	for (const n of [1, 2, 3, 4]) {
		const name = row[`category_${n}_name`];
		// TOEFL's 3-category rubric leaves slot 4 NULL — collapse it.
		if (name == null) continue;
		categories.push({
			name: String(name),
			score: String(row[`category_${n}_score`]),
			weight: String(row[`category_${n}_weight`]),
			feedback: (row[`category_${n}_feedback`] as string | null) ?? null,
		});
	}

	return {
		session_id: sessionId,
		status,
		calibrated,
		exam_type: row.exam_type as string,
		word_count: row.word_count as number | null,
		overall_band_score: row.overall_band_score as string | null,
		cefr_level: row.cefr_level as string | null,
		calibration_version: row.calibration_version as string | null,
		calibration_sample_count: (row.sample_count as number | null) ?? null,
		// NUMERIC(5,4) — a string for the same no-drift reason as the band.
		calibration_correlation: row.overall_pearson == null ? null : String(row.overall_pearson),
		submitted_at: submittedAt,
		scored_at: scoredAt,
		categories,
		grammar_corrections: row.grammar_corrections ?? [],
		vocabulary_suggestions: row.vocabulary_suggestions ?? [],
	};
}

// --- Score appeal (PRD §21.4, §35.4) ---

export interface AppealDeps {
	db: DbClient;
	appealQueue: AppealEvalQueue;
}

export interface AppealResult {
	appeal_id: string;
	status: string;
	writing_session_id: string;
	original_score: string;
	secondary_score?: string | null;
	discrepancy_delta?: string | null;
	requires_human_review?: boolean;
	created_at: string;
	resolved_at?: string | null;
	message?: string;
}

export async function submitAppeal(
	deps: AppealDeps,
	sessionId: string,
	learnerProfileId: string,
	appealReason: string | null,
	enforceCalibrationGate: boolean,
): Promise<{ appealId: string }> {
	// Eligibility read first so each refusal gets a precise error; the INSERT
	// below re-checks atomically, so a concurrent duplicate can't slip through.
	const { rows } = await deps.db.query(
		`SELECT ws.status, ws.overall_band_score, ws.calibration_version,
				EXISTS (
					SELECT 1 FROM score_appeals sa
					WHERE sa.writing_session_id = ws.id
					  AND sa.status IN ('pending', 'processing')
				) AS has_open_appeal
		 FROM writing_sessions ws
		 WHERE ws.id = $1 AND ws.learner_profile_id = $2`,
		[sessionId, learnerProfileId],
	);
	// Ownership in the WHERE clause: someone else's session reads as 404.
	if (rows.length === 0) {
		throw new AppError(404, "NOT_FOUND", "writing session not found");
	}
	const session = rows[0];
	if (String(session.status) !== "scored") {
		throw new AppError(409, "NOT_SCORED", "only a scored session can be appealed");
	}
	// A gate-withheld band was never shown, so there's nothing to appeal.
	if (enforceCalibrationGate && session.calibration_version == null) {
		throw new AppError(
			409,
			"SCORE_WITHHELD",
			"this score is withheld pending calibration, so there is no displayed score to appeal",
		);
	}
	if (session.has_open_appeal) {
		throw new AppError(409, "APPEAL_PENDING", "an appeal for this session is already in progress");
	}

	const insert = await deps.db.query(
		`INSERT INTO score_appeals (writing_session_id, learner_profile_id, appeal_reason, original_score)
		 SELECT ws.id, ws.learner_profile_id, $3, ws.overall_band_score
		 FROM writing_sessions ws
		 WHERE ws.id = $1 AND ws.learner_profile_id = $2 AND ws.status = 'scored'
		   AND NOT EXISTS (
				SELECT 1 FROM score_appeals sa
				WHERE sa.writing_session_id = ws.id
				  AND sa.status IN ('pending', 'processing')
		   )
		 RETURNING id`,
		[sessionId, learnerProfileId, appealReason],
	);
	if (insert.rows.length === 0) {
		// The eligibility read passed but the guarded INSERT didn't — a
		// concurrent appeal won the race between the two statements.
		throw new AppError(409, "APPEAL_PENDING", "an appeal for this session is already in progress");
	}
	const appealId = String(insert.rows[0].id);

	try {
		await enqueueAppealEval(deps.appealQueue, appealId);
	} catch (err) {
		// Same rule as submitWriting: mark failed rather than strand it pending.
		await deps.db.query(`UPDATE score_appeals SET status = 'failed' WHERE id = $1`, [appealId]);
		throw err;
	}

	return { appealId };
}

export async function getAppeal(
	deps: { db: DbClient },
	appealId: string,
	learnerProfileId: string,
): Promise<AppealResult | null> {
	const { rows } = await deps.db.query(
		`SELECT id, writing_session_id, status, original_score, secondary_score,
				discrepancy_delta, requires_human_review, created_at, resolved_at
		 FROM score_appeals
		 WHERE id = $1 AND learner_profile_id = $2`,
		[appealId, learnerProfileId],
	);
	if (rows.length === 0) return null;
	const row = rows[0];
	const status = String(row.status);

	const toIso = (v: unknown): string | null =>
		v == null ? null : v instanceof Date ? v.toISOString() : String(v);

	const result: AppealResult = {
		appeal_id: appealId,
		status,
		writing_session_id: String(row.writing_session_id),
		original_score: String(row.original_score),
		created_at: toIso(row.created_at) as string,
		resolved_at: toIso(row.resolved_at),
	};
	if (status === "resolved") {
		result.secondary_score = row.secondary_score as string | null;
		result.discrepancy_delta = row.discrepancy_delta as string | null;
		result.requires_human_review = Boolean(row.requires_human_review);
	}
	if (status === "failed") {
		// a failed secondary evaluation keeps the original score
		// displayed and tells the learner they can retry.
		result.message =
			"The secondary evaluation could not be completed. Your original score stands — you can submit the appeal again.";
	}
	return result;
}
