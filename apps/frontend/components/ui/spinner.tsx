import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";

export function Spinner({ className }: { className?: string }) {
	return (
		<Loader2
			className={cn("h-5 w-5 animate-spin text-muted-foreground", className)}
			aria-hidden="true"
		/>
	);
}

/** Full-viewport loading state for route guards — the gap between first
 * paint and the session-bootstrap/auth check resolving (hooks/use-session.ts)
 * should never render as a blank white flash. */
export function PageSpinner() {
	return (
		<div
			className="flex min-h-screen items-center justify-center"
			role="status"
			aria-label="Loading"
		>
			<Spinner className="h-6 w-6" />
		</div>
	);
}
