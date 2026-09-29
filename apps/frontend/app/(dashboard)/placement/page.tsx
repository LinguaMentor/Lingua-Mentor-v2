"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ArrowRight, ShieldCheck } from "lucide-react";
import Link from "next/link";

import { CefrRadar } from "@/components/dashboard/cefr-radar";
import { PageHeader } from "@/components/dashboard/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { useInvalidateCefrProfile } from "@/hooks/use-cefr-profile";
import { useMe } from "@/hooks/use-me";
import { usePlacementTask } from "@/hooks/use-placement-task";
import { ApiError } from "@/lib/api/client";
import { submitPlacement } from "@/lib/api/placement";
import type { CefrProfile, PlacementTask } from "@/lib/api/types";
import { countWords } from "@/lib/utils";

function TaskUnavailable({ error, examName }: { error: unknown; examName?: string }) {
	// The gateway's copy is the product's answer on this one — restating it here
	// would just be a second version to keep in sync.
	if (error instanceof ApiError && error.code === "AWAITING_CALIBRATION") {
		return (
			<Alert variant="warning">
				<AlertTitle>Placement isn&apos;t open yet</AlertTitle>
				<AlertDescription>{error.message}</AlertDescription>
			</Alert>
		);
	}
	// Not a fault: the exam is real, it just has no placement task yet. The
	// upstream message names the exam id, which isn't the learner's language.
	if (error instanceof ApiError && error.code === "PLACEMENT_NOT_AVAILABLE") {
		return (
			<Alert variant="warning">
				<AlertTitle>Placement isn&apos;t available for {examName ?? "your target exam"}</AlertTitle>
				<AlertDescription>
					We only open the placement test for exams whose scoring has been calibrated against
					certified human examiners, and {examName ?? "this exam"} isn&apos;t there yet. IELTS
					Academic and IELTS General are the exams we can mark today.
				</AlertDescription>
			</Alert>
		);
	}
	if (error instanceof ApiError && error.code === "NO_TARGET_EXAM") {
		return (
			<Alert variant="warning">
				<AlertTitle>No target exam set</AlertTitle>
				<AlertDescription>
					Your placement essay is marked against your target exam&apos;s rubric, so we need one
					before you start. Editing your profile isn&apos;t available yet — for now, register a new
					account with a target exam selected.
				</AlertDescription>
			</Alert>
		);
	}
	return (
		<Alert variant="destructive">
			<AlertTitle>Couldn&apos;t load the placement task</AlertTitle>
			<AlertDescription>
				Something went wrong on our side. Try refreshing the page.
			</AlertDescription>
		</Alert>
	);
}

function PlacementResult({ profile }: { profile: CefrProfile }) {
	return (
		<div className="space-y-6">
			<Alert variant="success">
				<AlertTitle className="flex items-center gap-1.5">
					<ShieldCheck className="h-4 w-4" aria-hidden="true" />
					Placement complete
				</AlertTitle>
				<AlertDescription>
					Your writing level is assessed. Reading is proxied from it for now; speaking and listening
					stay pending until voice practice lands.
				</AlertDescription>
			</Alert>

			<Card>
				<CardHeader>
					<CardTitle>Your 4D CEFR profile</CardTitle>
					<CardDescription>
						Each skill is tracked on its own — an averaged level would hide the gaps worth working
						on.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<CefrRadar profile={profile} />
				</CardContent>
			</Card>

			<Button asChild>
				<Link href="/dashboard">
					Go to dashboard <ArrowRight className="h-4 w-4" />
				</Link>
			</Button>
		</div>
	);
}

function PlacementForm({ task }: { task: PlacementTask }) {
	const [essay, setEssay] = useState("");
	const invalidateProfile = useInvalidateCefrProfile();

	const mutation = useMutation({
		mutationFn: () => submitPlacement({ task_id: task.task_id, essay_text: essay }),
		onSuccess: invalidateProfile,
	});

	if (mutation.data) return <PlacementResult profile={mutation.data} />;

	const wordCount = countWords(essay);
	const underLength = wordCount < task.word_count_min;

	return (
		<div className="space-y-6">
			<Card>
				<CardHeader>
					<CardTitle>{task.display_name}</CardTitle>
					<CardDescription>{task.task_name}</CardDescription>
				</CardHeader>
				<CardContent>
					<p className="whitespace-pre-line text-sm leading-relaxed">{task.prompt_text}</p>
				</CardContent>
			</Card>

			<form
				onSubmit={(e) => {
					e.preventDefault();
					mutation.mutate();
				}}
				className="space-y-4"
			>
				<div className="space-y-2">
					<div className="flex items-baseline justify-between">
						<Label htmlFor="essay">Your response</Label>
						<span
							className={underLength ? "text-xs text-warning" : "text-xs text-muted-foreground"}
							aria-live="polite"
						>
							{wordCount} / {task.word_count_min} words
						</span>
					</div>
					<Textarea
						id="essay"
						className="min-h-[360px]"
						placeholder="Write your response here."
						value={essay}
						onChange={(e) => setEssay(e.target.value)}
						disabled={mutation.isPending}
					/>
					{underLength && (
						// A real examiner penalises an under-length response rather than
						// refusing it, so this warns and still lets them submit.
						<p className="text-xs text-muted-foreground">
							Under {task.word_count_min} words is marked down, the same as it would be in the real
							exam.
						</p>
					)}
				</div>

				{mutation.isError && (
					<Alert variant="destructive">
						<AlertTitle>Couldn&apos;t score your response</AlertTitle>
						<AlertDescription>
							{mutation.error instanceof ApiError
								? mutation.error.message
								: "Something went wrong. Your text is still here — try submitting again."}
						</AlertDescription>
					</Alert>
				)}

				<Button type="submit" disabled={wordCount === 0 || mutation.isPending}>
					{mutation.isPending ? (
						<>
							<Spinner className="h-4 w-4" /> Marking your essay…
						</>
					) : (
						"Submit for assessment"
					)}
				</Button>
			</form>
		</div>
	);
}

export default function PlacementPage() {
	const taskQuery = usePlacementTask();
	const meQuery = useMe();

	return (
		<div>
			<PageHeader
				title="Placement test"
				description="One essay, marked against your target exam's rubric, to set your starting CEFR profile."
			/>
			<div className="max-w-3xl space-y-6 p-6">
				{taskQuery.isLoading && <Skeleton className="h-96 w-full" />}
				{taskQuery.isError && (
					<TaskUnavailable
						error={taskQuery.error}
						examName={meQuery.data?.target_exam?.replace(/_/g, " ")}
					/>
				)}
				{taskQuery.data && <PlacementForm task={taskQuery.data} />}
			</div>
		</div>
	);
}
