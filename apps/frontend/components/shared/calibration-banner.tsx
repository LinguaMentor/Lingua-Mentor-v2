import { ShieldCheck } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export interface CalibrationBannerProps {
	calibrated: boolean;
	calibrationVersion?: string | null;
	/** Essays the baseline was built from, and its AI-to-human Pearson r. */
	sampleCount?: number | null;
	correlation?: string | null;
	/** Verbatim withheld-score copy from the gateway (writing.service.ts); never re-paraphrase here. */
	message?: string;
}

/** NUMERIC(5,4) arrives as "0.8800"; §21.3 shows two decimals. */
function formatCorrelation(raw: string): string {
	return Number(raw).toFixed(2);
}

// trust surface (PRD §21.3, §60): score ran under an active baseline, or was withheld; renders above the score
export function CalibrationBanner({
	calibrated,
	calibrationVersion,
	sampleCount,
	correlation,
	message,
}: CalibrationBannerProps) {
	if (calibrated) {
		// The numbers are the trust signal (§21.3); without them this is just a
		// claim, so fall back to naming the baseline rather than implying a figure.
		const hasFigures = sampleCount != null && correlation != null;
		return (
			<Alert variant="success">
				<AlertTitle className="flex items-center gap-1.5">
					<ShieldCheck className="h-4 w-4" aria-hidden="true" />
					AI-calibrated score
				</AlertTitle>
				<AlertDescription>
					{hasFigures ? (
						<>
							This score was calibrated against {sampleCount.toLocaleString()} human-graded essays.
							AI-to-human correlation:{" "}
							<span className="font-medium">{formatCorrelation(correlation)}</span>.
						</>
					) : (
						<>This score was produced under an active Phase 0 calibration baseline.</>
					)}
					{calibrationVersion ? (
						<>
							{" "}
							Baseline <span className="font-mono text-xs">{calibrationVersion}</span>.
						</>
					) : null}
				</AlertDescription>
			</Alert>
		);
	}

	return (
		<Alert variant="warning">
			<AlertTitle>Score withheld — pending calibration</AlertTitle>
			<AlertDescription>
				{message ??
					"Your response was evaluated, but AI scoring for this exam has not yet passed Phase 0 calibration, so a band score is withheld."}
			</AlertDescription>
		</Alert>
	);
}
