// Profile lookup and GDPR erasure for /api/v1/user/me (PRD §35.2).
import { randomUUID } from "node:crypto";
import { hash as argonHash } from "@node-rs/argon2";

import type { DbClient } from "../../db/client";

export interface UserProfile {
	id: string;
	email: string;
	displayName: string;
	role: string;
	subscriptionTier: string;
	learnerProfileId: string;
	targetLanguage: string;
	targetExam: string | null;
	accentTarget: string;
	defaultPersona: string;
	activeTrack: string;
	// 4D CEFR profile (PRD §22) — null until placement runs or the skill has data.
	cefrSpeaking: string | null;
	cefrListening: string | null;
	cefrReading: string | null;
	cefrWriting: string | null;
}

export async function getUserProfile(db: DbClient, userId: string): Promise<UserProfile | null> {
	const { rows } = await db.query(
		`SELECT u.id, u.email, u.display_name, u.role, u.subscription_tier,
				lp.id AS learner_profile_id, lp.target_language, lp.target_exam,
				lp.accent_target, lp.default_persona, lp.active_track,
				lp.cefr_speaking, lp.cefr_listening, lp.cefr_reading, lp.cefr_writing
		 FROM users u
		 JOIN learner_profiles lp ON lp.user_id = u.id
		 WHERE u.id = $1`,
		[userId],
	);
	const row = rows[0];
	if (!row) return null;

	return {
		id: String(row.id),
		email: String(row.email),
		displayName: String(row.display_name),
		role: String(row.role),
		subscriptionTier: String(row.subscription_tier),
		learnerProfileId: String(row.learner_profile_id),
		targetLanguage: String(row.target_language),
		targetExam: row.target_exam == null ? null : String(row.target_exam),
		accentTarget: String(row.accent_target),
		defaultPersona: String(row.default_persona),
		activeTrack: String(row.active_track),
		cefrSpeaking: row.cefr_speaking == null ? null : String(row.cefr_speaking),
		cefrListening: row.cefr_listening == null ? null : String(row.cefr_listening),
		cefrReading: row.cefr_reading == null ? null : String(row.cefr_reading),
		cefrWriting: row.cefr_writing == null ? null : String(row.cefr_writing),
	};
}

const ERASED_DISPLAY_NAME = "Erased user";

/**
 * GDPR erasure (ADR 0007). Anonymises the identity, clears every scrap of
 * learner-authored text, and leaves scores and `ai_model_runs` standing as the
 * anonymised metrics PRD §10.5 says to retain.
 */
export async function eraseAccount(db: DbClient, userId: string): Promise<boolean> {
	// A hash of a secret nobody holds, not a blank: auth.service.ts verifies the
	// stored hash before it checks is_active, and a malformed one throws there.
	const unusablePasswordHash = await argonHash(randomUUID());

	return db.transaction(async (tx) => {
		const erased = await tx.query(
			`UPDATE users
			 SET email = 'erased+' || id::text || '@erased.invalid',
				 display_name = $2,
				 password_hash = $3,
				 is_active = false,
				 gdpr_erasure_requested_at = now()
			 WHERE id = $1 AND gdpr_erasure_requested_at IS NULL
			 RETURNING id`,
			[userId, ERASED_DISPLAY_NAME, unusablePasswordHash],
		);
		if (erased.rows.length === 0) return false;

		// Everything below keys off the profile, which outlives the identity.
		const { rows: profileRows } = await tx.query(
			`SELECT id FROM learner_profiles WHERE user_id = $1`,
			[userId],
		);
		const learnerProfileId = profileRows[0]?.id;
		if (!learnerProfileId) return true;

		// Feedback quotes the essay back (prompt_builder.py), so it carries the
		// same re-identification risk as the essay itself.
		await tx.query(
			`UPDATE writing_score_breakdowns SET category_1_feedback = NULL, category_2_feedback = NULL,
					category_3_feedback = NULL, category_4_feedback = NULL
			 WHERE writing_session_id IN (SELECT id FROM writing_sessions WHERE learner_profile_id = $1)`,
			[learnerProfileId],
		);
		await tx.query(
			`UPDATE writing_sessions SET prompt_text = '', essay_text = '' WHERE learner_profile_id = $1`,
			[learnerProfileId],
		);
		await tx.query(`UPDATE score_appeals SET appeal_reason = NULL WHERE learner_profile_id = $1`, [
			learnerProfileId,
		]);
		await tx.query(
			`UPDATE speaking_sessions SET transcript_text = NULL WHERE learner_profile_id = $1`,
			[learnerProfileId],
		);
		// Mentor turns quote the learner's own words back to correct them, so both
		// sides carry re-identification risk; the ai_model_runs link stays (ADR 0010 §3).
		await tx.query(
			`UPDATE lesson_messages SET content = ''
			 WHERE lesson_session_id IN (SELECT id FROM lesson_sessions WHERE learner_profile_id = $1)`,
			[learnerProfileId],
		);
		await tx.query(`UPDATE lesson_sessions SET topic = NULL WHERE learner_profile_id = $1`, [
			learnerProfileId,
		]);
		return true;
	});
}
