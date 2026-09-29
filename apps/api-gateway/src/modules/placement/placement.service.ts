// Placement: hand the learner the exam's task, then score their essay against
// it. The prompt is server-owned — scoring logic lives in ai-service.
import type { AiServiceClient, CefrProfileDto, PlacementTaskDto } from "../../clients/ai-service";
import type { DbClient } from "../../db/client";
import { AppError } from "../../plugins/error-envelope";

export interface PlacementDeps {
	db: DbClient;
	aiService: AiServiceClient;
}

export interface PlacementInput {
	learnerProfileId: string;
	taskId: string;
	essayText: string;
}

// Both routes resolve through here, so the test can't be handed out on terms
// the submit would then refuse.
async function resolveTargetExam(
	deps: PlacementDeps,
	learnerProfileId: string,
	enforceCalibrationGate: boolean,
): Promise<string> {
	// Scored against the target exam's rubric — no target exam, no rubric.
	const { rows } = await deps.db.query(`SELECT target_exam FROM learner_profiles WHERE id = $1`, [
		learnerProfileId,
	]);
	const targetExam = rows[0]?.target_exam;
	if (!targetExam) {
		throw new AppError(400, "NO_TARGET_EXAM", "set a target exam before taking the placement test");
	}

	// Phase 0 gate (PRD §60): refuse before the learner writes anything, rather
	// than take a 250-word essay and then decline to score it.
	if (enforceCalibrationGate) {
		const baseline = await deps.db.query(
			`SELECT 1 FROM calibration_baselines
			 WHERE exam_type = $1 AND displayed_on_reports = true
			 LIMIT 1`,
			[targetExam],
		);
		if (baseline.rows.length === 0) {
			throw new AppError(
				409,
				"AWAITING_CALIBRATION",
				"The placement test isn't available yet: AI scoring for your target exam " +
					"is still being calibrated against certified human examiners. " +
					"You'll be able to take it as soon as calibration is confirmed.",
			);
		}
	}
	return String(targetExam);
}

export async function getPlacementTask(
	deps: PlacementDeps,
	learnerProfileId: string,
	enforceCalibrationGate: boolean,
): Promise<PlacementTaskDto> {
	const examType = await resolveTargetExam(deps, learnerProfileId, enforceCalibrationGate);
	return deps.aiService.getPlacementTask(examType);
}

export async function submitPlacement(
	deps: PlacementDeps,
	input: PlacementInput,
	enforceCalibrationGate: boolean,
): Promise<CefrProfileDto> {
	const examType = await resolveTargetExam(deps, input.learnerProfileId, enforceCalibrationGate);
	return deps.aiService.evaluatePlacement({
		learnerProfileId: input.learnerProfileId,
		examType,
		taskId: input.taskId,
		essayText: input.essayText,
	});
}
