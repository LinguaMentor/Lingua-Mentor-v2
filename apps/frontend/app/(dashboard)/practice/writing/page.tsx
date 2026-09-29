"use client";

import { useState } from "react";
import { ArrowLeft, Send } from "lucide-react";

import { PageHeader } from "@/components/dashboard/page-header";
import { WritingReport } from "@/components/writing/writing-report";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { useMe } from "@/hooks/use-me";
import { useWritingSubmission } from "@/hooks/use-writing-submission";
import { ApiError } from "@/lib/api/client";
import { countWords } from "@/lib/utils";

function EvaluatingCard() {
	return (
		<Card>
			<CardContent className="flex items-center gap-3 py-8">
				<Spinner className="h-5 w-5" />
				<div>
					<p className="font-medium">Evaluating your essay…</p>
					<p className="text-sm text-muted-foreground">
						Scoring runs against the exam rubric — this usually takes a few seconds.
					</p>
				</div>
			</CardContent>
		</Card>
	);
}

export default function WritingPracticePage() {
	const meQuery = useMe();
	const targetExam = meQuery.data?.target_exam ?? null;

	const [promptText, setPromptText] = useState("");
	const [essayText, setEssayText] = useState("");
	const { submit, result, isPolling, timedOut, reset } = useWritingSubmission();

	function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		if (!targetExam) return;
		submit.mutate({ exam_type: targetExam, prompt_text: promptText, essay_text: essayText });
	}

	function handleReset() {
		setPromptText("");
		setEssayText("");
		reset();
	}

	if (!meQuery.isLoading && !targetExam) {
		return (
			<div>
				<PageHeader title="Writing practice" />
				<div className="max-w-3xl p-6">
					<Alert variant="warning">
						<AlertTitle>No target exam set</AlertTitle>
						<AlertDescription>
							Your essay is scored against your target exam&apos;s rubric, so we need one first.
						</AlertDescription>
					</Alert>
				</div>
			</div>
		);
	}

	// The submission is done (or being polled) — show its state, not the form.
	if (submit.isSuccess) {
		return (
			<div>
				<PageHeader
					title="Writing practice"
					description={targetExam ? targetExam.replace(/_/g, " ") : undefined}
					action={
						<Button variant="outline" size="sm" onClick={handleReset} disabled={isPolling}>
							<ArrowLeft className="h-4 w-4" /> New essay
						</Button>
					}
				/>
				<div className="max-w-3xl space-y-6 p-6">
					{timedOut ? (
						<Alert variant="warning">
							<AlertTitle>Still not scored</AlertTitle>
							<AlertDescription>
								Your essay was submitted but hasn&apos;t come back yet — the scoring service may be
								busy or unavailable. Your text is safe; start a new essay to try again.
							</AlertDescription>
						</Alert>
					) : isPolling || !result.data ? (
						<EvaluatingCard />
					) : (
						<WritingReport result={result.data} />
					)}
				</div>
			</div>
		);
	}

	const wordCount = countWords(essayText);
	const canSubmit =
		promptText.trim().length > 0 && essayText.trim().length > 0 && !submit.isPending;

	return (
		<div>
			<PageHeader
				title="Writing practice"
				description="Write an essay and get rubric-aligned, calibration-gated feedback."
			/>
			<div className="max-w-3xl p-6">
				<form onSubmit={handleSubmit} className="space-y-6">
					<Card>
						<CardHeader>
							<CardTitle className="text-base">Essay prompt</CardTitle>
							<CardDescription>
								Paste the exam question you want to practise, or write your own.
							</CardDescription>
						</CardHeader>
						<CardContent>
							<Textarea
								id="prompt"
								className="min-h-[80px]"
								placeholder="e.g. Some people think… Discuss both views and give your own opinion."
								value={promptText}
								onChange={(e) => setPromptText(e.target.value)}
								disabled={submit.isPending}
							/>
						</CardContent>
					</Card>

					<div className="space-y-2">
						<div className="flex items-baseline justify-between">
							<Label htmlFor="essay">Your response</Label>
							<span className="text-xs text-muted-foreground" aria-live="polite">
								{wordCount} words
							</span>
						</div>
						<Textarea
							id="essay"
							className="min-h-[360px]"
							placeholder="Write your response here."
							value={essayText}
							onChange={(e) => setEssayText(e.target.value)}
							disabled={submit.isPending}
						/>
					</div>

					{submit.isError && (
						<Alert variant="destructive">
							<AlertTitle>Couldn&apos;t submit your essay</AlertTitle>
							<AlertDescription>
								{submit.error instanceof ApiError
									? submit.error.message
									: "Something went wrong. Your text is still here — try again."}
							</AlertDescription>
						</Alert>
					)}

					<Button type="submit" disabled={!canSubmit}>
						{submit.isPending ? (
							<>
								<Spinner className="h-4 w-4" /> Submitting…
							</>
						) : (
							<>
								<Send className="h-4 w-4" /> Submit for evaluation
							</>
						)}
					</Button>
				</form>
			</div>
		</div>
	);
}
