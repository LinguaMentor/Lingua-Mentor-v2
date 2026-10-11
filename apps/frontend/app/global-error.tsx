"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

import "./globals.css";

// Next catches render errors in its own boundary, so they never reach the browser's global handler.
export default function GlobalError({
	error,
	reset,
}: {
	error: Error & { digest?: string };
	reset: () => void;
}) {
	useEffect(() => {
		Sentry.captureException(error);
	}, [error]);

	return (
		<html lang="en">
			<body className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 font-sans">
				<h1 className="text-xl font-semibold">Something went wrong</h1>
				<p className="text-muted-foreground">The error has been reported. You can try again.</p>
				<button
					type="button"
					onClick={reset}
					className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
				>
					Try again
				</button>
			</body>
		</html>
	);
}
