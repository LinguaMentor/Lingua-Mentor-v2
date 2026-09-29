import { cn } from "@/lib/utils";

export interface ProgressProps {
	/** 0–100. Values outside that range are clamped, never rendered raw —
	 * a readiness/CEFR proportion bar must never visually overflow its track. */
	value: number;
	className?: string;
	indicatorClassName?: string;
}

export function Progress({ value, className, indicatorClassName }: ProgressProps) {
	const clamped = Math.min(100, Math.max(0, value));
	return (
		<div
			role="progressbar"
			aria-valuenow={clamped}
			aria-valuemin={0}
			aria-valuemax={100}
			className={cn("h-2 w-full overflow-hidden rounded-full bg-secondary", className)}
		>
			<div
				className={cn(
					"h-full rounded-full bg-primary transition-all duration-500 ease-out",
					indicatorClassName,
				)}
				style={{ width: `${clamped}%` }}
			/>
		</div>
	);
}
