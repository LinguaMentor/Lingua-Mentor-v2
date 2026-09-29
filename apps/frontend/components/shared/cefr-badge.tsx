import { Clock, Sparkles } from "lucide-react";

import { cn } from "@/lib/utils";

export type CefrSource = "assessed" | "proxy" | "pending";

export interface CefrBadgeProps {
	level: string | null;
	source: CefrSource;
	className?: string;
}

/** Source-honest CEFR level (PRD §22): only `assessed` reads as solid fact; `proxy` and `pending` render dashed and muted so an estimate is never mistaken for a measurement. */
export function CefrBadge({ level, source, className }: CefrBadgeProps) {
	if (source === "pending" || !level) {
		return (
			<span
				className={cn(
					"inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2.5 py-0.5 text-xs font-medium text-muted-foreground",
					className,
				)}
			>
				<Clock className="h-3 w-3" aria-hidden="true" />
				Not yet available
			</span>
		);
	}

	const bandClass = `cefr-${level.toLowerCase()}`;
	return (
		<span
			className={cn(
				"inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold",
				bandClass,
				className,
			)}
		>
			{source === "proxy" && <Sparkles className="h-3 w-3 opacity-70" aria-hidden="true" />}
			{level}
			{source === "proxy" && <span className="font-normal opacity-70">(est.)</span>}
		</span>
	);
}
