"use client";

import { Menu, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { NavLinks } from "@/components/dashboard/nav-links";
import { UserMenu } from "@/components/dashboard/user-menu";

/** Authenticated app shell: fixed sidebar on desktop, hamburger drawer on
 * mobile. Both render the same <NavLinks>/<UserMenu> so nav state can't drift. */
export function AppShell({ children }: { children: React.ReactNode }) {
	const [drawerOpen, setDrawerOpen] = useState(false);

	useEffect(() => {
		if (!drawerOpen) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") setDrawerOpen(false);
		};
		document.addEventListener("keydown", onKeyDown);
		// Prevent the page behind the drawer from scrolling while it's open.
		document.body.style.overflow = "hidden";
		return () => {
			document.removeEventListener("keydown", onKeyDown);
			document.body.style.overflow = "";
		};
	}, [drawerOpen]);

	return (
		<div className="flex min-h-screen">
			<aside className="hidden w-64 shrink-0 flex-col gap-6 border-r border-border bg-card p-4 lg:flex">
				<Link href="/dashboard" className="text-lg font-bold tracking-tight">
					LinguaMentor
				</Link>
				<NavLinks />
				<UserMenu />
			</aside>

			<div className="flex min-w-0 flex-1 flex-col">
				<header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-card px-4 lg:hidden">
					<Link href="/dashboard" className="text-lg font-bold tracking-tight">
						LinguaMentor
					</Link>
					<Button
						variant="ghost"
						size="icon"
						onClick={() => setDrawerOpen(true)}
						aria-label="Open menu"
					>
						<Menu className="h-5 w-5" />
					</Button>
				</header>

				<main className="flex-1 bg-secondary/20">{children}</main>
			</div>

			{drawerOpen && (
				<div className="fixed inset-0 z-50 lg:hidden">
					<div
						className="absolute inset-0 animate-fade-in bg-foreground/40"
						onClick={() => setDrawerOpen(false)}
						aria-hidden="true"
					/>
					<div
						role="dialog"
						aria-modal="true"
						aria-label="Navigation menu"
						className="absolute inset-y-0 left-0 flex w-72 animate-fade-in flex-col gap-6 bg-card p-4 shadow-lg"
					>
						<div className="flex items-center justify-between">
							<span className="text-lg font-bold tracking-tight">LinguaMentor</span>
							<Button
								variant="ghost"
								size="icon"
								onClick={() => setDrawerOpen(false)}
								aria-label="Close menu"
							>
								<X className="h-5 w-5" />
							</Button>
						</div>
						<NavLinks onNavigate={() => setDrawerOpen(false)} />
						<UserMenu />
					</div>
				</div>
			)}
		</div>
	);
}
