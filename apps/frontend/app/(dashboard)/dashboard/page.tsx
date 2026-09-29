"use client";

import { ArrowRight, NotebookPen, Target } from "lucide-react";
import Link from "next/link";

import { PageHeader } from "@/components/dashboard/page-header";
import { CefrRadar } from "@/components/dashboard/cefr-radar";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useCefrProfile } from "@/hooks/use-cefr-profile";
import { useMe } from "@/hooks/use-me";
import { useAuthStore } from "@/store/auth-store";

export default function DashboardPage() {
	const user = useAuthStore((s) => s.user);
	const meQuery = useMe();
	const profileQuery = useCefrProfile();

	const firstName = user?.display_name.split(" ")[0] ?? "there";

	return (
		<div>
			<PageHeader
				title={`Welcome back, ${firstName}`}
				description={
					meQuery.data?.target_exam
						? `Tracking toward ${meQuery.data.target_exam.replace(/_/g, " ")}`
						: "Set a target exam to start tracking your progress."
				}
			/>

			<div className="space-y-6 p-6">
				{profileQuery.data && !profileQuery.data.placement_completed && (
					<Alert variant="info">
						<AlertTitle>Take your placement test</AlertTitle>
						<AlertDescription>
							Submit a short writing sample to initialize your 4D CEFR profile — it&apos;s the first
							step before writing practice and exam simulation unlock.
						</AlertDescription>
						<Button asChild size="sm" className="mt-2">
							<Link href="/placement">
								Start placement <ArrowRight className="h-4 w-4" />
							</Link>
						</Button>
					</Alert>
				)}

				<div className="grid gap-6 lg:grid-cols-3">
					<Card className="lg:col-span-2">
						<CardHeader>
							<CardTitle>4D CEFR profile</CardTitle>
							<CardDescription>
								Speaking, Listening, Reading, and Writing tracked independently — a single averaged
								level would hide exactly the gaps that matter.
							</CardDescription>
						</CardHeader>
						<CardContent>
							{profileQuery.isLoading && <Skeleton className="h-72 w-full" />}
							{profileQuery.isError && (
								<p className="text-sm text-destructive">
									Couldn&apos;t load your CEFR profile — try refreshing.
								</p>
							)}
							{profileQuery.data && <CefrRadar profile={profileQuery.data} />}
						</CardContent>
					</Card>

					<div className="space-y-6">
						<Card>
							<CardHeader>
								<CardTitle className="flex items-center gap-2 text-base">
									<NotebookPen className="h-4 w-4 text-primary" aria-hidden="true" />
									Writing practice
								</CardTitle>
								<CardDescription>
									Submit an essay for rubric-aligned, calibration-gated scoring.
								</CardDescription>
							</CardHeader>
							<CardContent>
								<Button asChild variant="outline" className="w-full">
									<Link href="/practice/writing">
										Practice now <ArrowRight className="h-4 w-4" />
									</Link>
								</Button>
							</CardContent>
						</Card>

						<Card>
							<CardHeader>
								<CardTitle className="flex items-center gap-2 text-base">
									<Target className="h-4 w-4 text-primary" aria-hidden="true" />
									Placement test
								</CardTitle>
								<CardDescription>
									{profileQuery.data?.placement_completed
										? "Completed — retake anytime to refresh your writing baseline."
										: "Not yet completed."}
								</CardDescription>
							</CardHeader>
							<CardContent>
								<Button asChild variant="outline" className="w-full">
									<Link href="/placement">
										{profileQuery.data?.placement_completed ? "Retake" : "Start now"}{" "}
										<ArrowRight className="h-4 w-4" />
									</Link>
								</Button>
							</CardContent>
						</Card>
					</div>
				</div>
			</div>
		</div>
	);
}
