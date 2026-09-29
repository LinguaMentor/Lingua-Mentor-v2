// Teaching persona selection (PRD §17, §35.3). The persona *layer* lives in
// ai-service; what's stored here is the learner's standing choice.
import type { AiServiceClient, PersonaDto } from "../../clients/ai-service";
import type { DbClient } from "../../db/client";
import { AppError } from "../../plugins/error-envelope";

export interface VoiceDeps {
	db: DbClient;
	aiService: AiServiceClient;
}

export interface PersonaState {
	current: string;
	available: PersonaDto[];
}

/** Personas this tier may use — Companion is free, the rest are Pro (§17.4). */
function allowedFor(personas: PersonaDto[], tier: string): PersonaDto[] {
	return personas.filter((p) => !p.pro_only || tier === "pro");
}

export async function getPersonaState(
	deps: VoiceDeps,
	learnerProfileId: string,
	tier: string,
): Promise<PersonaState> {
	const [{ rows }, personas] = await Promise.all([
		deps.db.query(`SELECT default_persona FROM learner_profiles WHERE id = $1`, [learnerProfileId]),
		deps.aiService.listPersonas(),
	]);
	if (rows.length === 0) {
		throw new AppError(404, "NOT_FOUND", "learner profile not found");
	}
	return { current: String(rows[0].default_persona), available: allowedFor(personas, tier) };
}

export async function selectPersona(
	deps: VoiceDeps,
	learnerProfileId: string,
	tier: string,
	persona: string,
): Promise<PersonaState> {
	const personas = await deps.aiService.listPersonas();
	const requested = personas.find((p) => p.persona === persona);
	if (!requested) {
		throw new AppError(400, "UNKNOWN_PERSONA", `unknown persona '${persona}'`, "persona");
	}
	// Gated per persona rather than per endpoint: a free learner selecting
	// Companion is choosing the only thing they have, not upgrading (§17.4).
	if (requested.pro_only && tier !== "pro") {
		throw new AppError(
			403,
			"PRO_TIER_REQUIRED",
			`the ${requested.display_name} persona is available on the Pro plan`,
			"persona",
		);
	}

	const { rows } = await deps.db.query(
		`UPDATE learner_profiles SET default_persona = $2, updated_at = now()
		 WHERE id = $1
		 RETURNING default_persona`,
		[learnerProfileId, persona],
	);
	if (rows.length === 0) {
		throw new AppError(404, "NOT_FOUND", "learner profile not found");
	}
	return { current: String(rows[0].default_persona), available: allowedFor(personas, tier) };
}
