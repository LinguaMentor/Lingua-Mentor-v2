"use client";

import {
	PolarAngleAxis,
	PolarGrid,
	PolarRadiusAxis,
	Radar,
	RadarChart,
	ResponsiveContainer,
	Tooltip,
} from "recharts";

import { CefrBadge } from "@/components/shared/cefr-badge";
import type { CefrProfile, CefrSource } from "@/lib/api/types";
import { cefrToScore, scoreToCefrLabel } from "@/lib/cefr";

interface RadarDatum {
	skill: string;
	score: number;
	level: string | null;
	source: CefrSource;
}

function buildData(profile: CefrProfile): RadarDatum[] {
	return [
		{
			skill: "Writing",
			score: cefrToScore(profile.writing.level),
			level: profile.writing.level,
			source: profile.writing.source,
		},
		{
			skill: "Speaking",
			score: cefrToScore(profile.speaking.level),
			level: profile.speaking.level,
			source: profile.speaking.source,
		},
		{
			skill: "Listening",
			score: cefrToScore(profile.listening.level),
			level: profile.listening.level,
			source: profile.listening.source,
		},
		{
			skill: "Reading",
			score: cefrToScore(profile.reading.level),
			level: profile.reading.level,
			source: profile.reading.source,
		},
	];
}

const SOURCE_LABEL: Record<CefrSource, string> = {
	assessed: "Assessed",
	proxy: "Estimated (proxy)",
	pending: "Not yet available",
};

interface ChartTooltipProps {
	active?: boolean;
	payload?: { payload: RadarDatum }[];
}

function ChartTooltip({ active, payload }: ChartTooltipProps) {
	if (!active || !payload?.length) return null;
	const datum = payload[0].payload;
	return (
		<div className="rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-md">
			<p className="font-semibold text-popover-foreground">{datum.skill}</p>
			<p className="text-muted-foreground">
				{datum.level ?? "—"} · {SOURCE_LABEL[datum.source]}
			</p>
		</div>
	);
}

/** The 4D CEFR profile (PRD §22) as a radar chart: each skill plots on its own
 * so asymmetric proficiency shows, and `pending` skills dip to 0 rather than
 * interpolate a guess. The text legend repeats the distinction for touch. */
export function CefrRadar({ profile }: { profile: CefrProfile }) {
	const data = buildData(profile);

	return (
		<div className="space-y-4">
			<div className="h-72 w-full">
				<ResponsiveContainer width="100%" height="100%">
					<RadarChart data={data} outerRadius="70%">
						<PolarGrid stroke="hsl(var(--border))" />
						<PolarAngleAxis
							dataKey="skill"
							tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }}
						/>
						<PolarRadiusAxis
							domain={[0, 6]}
							tickCount={7}
							tickFormatter={scoreToCefrLabel}
							tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
						/>
						<Radar
							dataKey="score"
							stroke="hsl(var(--primary))"
							fill="hsl(var(--primary))"
							fillOpacity={0.25}
							strokeWidth={2}
						/>
						<Tooltip content={<ChartTooltip />} />
					</RadarChart>
				</ResponsiveContainer>
			</div>

			<div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
				{data.map((datum) => (
					<div
						key={datum.skill}
						className="flex flex-col items-center gap-1.5 rounded-lg border border-border p-3"
					>
						<span className="text-xs font-medium text-muted-foreground">{datum.skill}</span>
						<CefrBadge level={datum.level} source={datum.source} />
					</div>
				))}
			</div>
		</div>
	);
}
