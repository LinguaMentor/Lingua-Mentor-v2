import { AlertTriangle, BookOpen, SpellCheck } from "lucide-react";

import { CalibrationBanner } from "@/components/shared/calibration-banner";
import { CefrBadge } from "@/components/shared/cefr-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import type { WritingResult } from "@/lib/api/types";

function ScoreHeader({ result }: { result: WritingResult }) {
	return (
		<Card>
			<CardContent className="flex flex-wrap items-center justify-between gap-4 pt-6">
				<div>
					<p className="text-sm text-muted-foreground">Overall band</p>
					<p className="text-4xl font-bold tabular-nums">{result.overall_band_score}</p>
				</div>
				{result.cefr_level && (
					<div className="text-right">
						<p className="mb-1 text-sm text-muted-foreground">CEFR</p>
						<CefrBadge level={result.cefr_level} source="assessed" />
					</div>
				)}
			</CardContent>
		</Card>
	);
}

function CategoryBreakdown({ result }: { result: WritingResult }) {
	if (!result.categories?.length) return null;
	return (
		<Card>
			<CardHeader>
				<CardTitle className="text-base">Rubric breakdown</CardTitle>
			</CardHeader>
			<CardContent className="space-y-4">
				{result.categories.map((c) => (
					<div key={c.name}>
						<div className="flex items-baseline justify-between">
							<span className="font-medium">{c.name}</span>
							<span className="tabular-nums">
								{c.score}
								<span className="ml-2 text-xs text-muted-foreground">weight {c.weight}</span>
							</span>
						</div>
						{c.feedback && <p className="mt-1 text-sm text-muted-foreground">{c.feedback}</p>}
					</div>
				))}
			</CardContent>
		</Card>
	);
}

function GrammarCorrections({ result }: { result: WritingResult }) {
	if (!result.grammar_corrections?.length) return null;
	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2 text-base">
					<SpellCheck className="h-4 w-4 text-primary" aria-hidden="true" />
					Grammar
				</CardTitle>
			</CardHeader>
			<CardContent className="space-y-3">
				{result.grammar_corrections.map((g, i) => (
					<div key={i} className="text-sm">
						<p>
							<span className="text-destructive line-through">{g.original}</span>
							{" → "}
							<span className="font-medium text-success">{g.correction}</span>
						</p>
						<p className="text-muted-foreground">{g.explanation}</p>
					</div>
				))}
			</CardContent>
		</Card>
	);
}

function VocabularySuggestions({ result }: { result: WritingResult }) {
	if (!result.vocabulary_suggestions?.length) return null;
	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2 text-base">
					<BookOpen className="h-4 w-4 text-primary" aria-hidden="true" />
					Vocabulary
				</CardTitle>
			</CardHeader>
			<CardContent className="space-y-3">
				{result.vocabulary_suggestions.map((v, i) => (
					<div key={i} className="text-sm">
						<p>
							<span className="text-muted-foreground">{v.original}</span>
							{" → "}
							<span className="font-medium">{v.suggestion}</span>
						</p>
						<p className="text-muted-foreground">{v.reason}</p>
					</div>
				))}
			</CardContent>
		</Card>
	);
}

export function WritingReport({ result }: { result: WritingResult }) {
	if (result.status === "failed") {
		return (
			<Alert variant="destructive">
				<AlertTitle className="flex items-center gap-1.5">
					<AlertTriangle className="h-4 w-4" aria-hidden="true" />
					Evaluation failed
				</AlertTitle>
				<AlertDescription>
					The scoring service couldn&apos;t evaluate this essay. Your text is safe — submit it
					again.
				</AlertDescription>
			</Alert>
		);
	}

	// Phase 0 gate: the band is withheld until calibration passes, and the banner
	// carries the gateway's verbatim reason (never re-worded here).
	if (result.status === "awaiting_calibration") {
		return <CalibrationBanner calibrated={false} message={result.message} />;
	}

	return (
		<div className="space-y-6">
			{/* Only the calibrated banner belongs above a visible score. A scored
			    result that isn't calibrated is a dev-gate artifact (production
			    withholds instead), so it gets a muted note, not a "withheld" alarm. */}
			{result.calibrated ? (
				<CalibrationBanner
					calibrated
					calibrationVersion={result.calibration_version}
					sampleCount={result.calibration_sample_count}
					correlation={result.calibration_correlation}
				/>
			) : (
				<Alert variant="info">
					<AlertDescription>
						This score ran without an active calibration baseline — shown for development only.
					</AlertDescription>
				</Alert>
			)}
			<ScoreHeader result={result} />
			{result.word_count != null && <Badge variant="secondary">{result.word_count} words</Badge>}
			<Separator />
			<CategoryBreakdown result={result} />
			<GrammarCorrections result={result} />
			<VocabularySuggestions result={result} />
		</div>
	);
}
